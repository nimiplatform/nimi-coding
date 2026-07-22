import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

import { contextAuthorityPath, queryAuthorityPath } from "../cli/lib/authority/query.mjs";
import { collectIrLeaves } from "../cli/lib/authority/source-map.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixtures = path.join(packageRoot, "test", "fixtures", "authority");
const temporaryRoots = [];

async function corpus() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-context-"));
  temporaryRoots.push(root);
  const target = path.join(root, "authority");
  await cp(path.join(fixtures, "valid", "yaml"), target, { recursive: true });
  return { root, target };
}

async function runCli(root, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("exact query and outgoing bounded context are complete, traceable, minimal, and deterministic", async () => {
  const first = await corpus();
  const second = await corpus();

  const queried = await queryAuthorityPath(first.target, "rule.checkout-session", { maxBytes: 65536 });
  assert.equal(queried.ok, true, JSON.stringify(queried.diagnostics));
  assert.equal(queried.fileCount, 1);
  assert.equal(queried.unitCount, 1);
  assert.equal(queried.packet.format, "nimicoding.authority-context/v1");
  assert.deepEqual(queried.packet.units.map((unit) => unit.id), ["rule.checkout-session"]);
  assert.equal(queried.packet.closure.direction, "exact");

  const contextual = await contextAuthorityPath(first.target, "rule.checkout-session", { maxUnits: 5, maxBytes: 65536 });
  assert.equal(contextual.ok, true, JSON.stringify(contextual.diagnostics));
  const expectedIds = [
    "definition.session",
    "definition.session-v0",
    "rule.checkout-session",
    "rule.checkout-session-v0",
    "rule.checkout-session-v00",
  ];
  assert.deepEqual(contextual.packet.units.map((unit) => unit.id), expectedIds);
  assert.deepEqual(contextual.packet.closure.relationCategories, ["applies_to", "supersedes"]);
  assert.equal(contextual.packet.closure.complete, true);
  assert.equal(contextual.packetBytes, Buffer.byteLength(JSON.stringify(contextual.packet), "utf8"));
  assert(contextual.packetBytes <= 65536);
  assert(!contextual.packet.units.some((unit) => unit.id === "rule.checkout-no-anonymous"));

  const expectedLeaves = [...collectIrLeaves({ units: contextual.packet.units })].sort();
  assert.deepEqual(Object.keys(contextual.packet.sourceMap.fields).sort(), expectedLeaves);
  for (const mapped of Object.values(contextual.packet.sourceMap.fields)) {
    assert(!path.isAbsolute(mapped.file));
    assert.match(mapped.file, /\.authority\.yaml$/);
  }

  const repeated = await contextAuthorityPath(first.target, "rule.checkout-session", { maxUnits: 5, maxBytes: 65536 });
  const relocated = await contextAuthorityPath(second.target, "rule.checkout-session", { maxUnits: 5, maxBytes: 65536 });
  assert.deepEqual(repeated.packet, contextual.packet);
  assert.deepEqual(relocated.packet, contextual.packet);
  assert.doesNotMatch(JSON.stringify(contextual.packet), /authority-source\.schema|\.nimi\/contracts/);

  const task = YAML.parse(await readFile(path.join(fixtures, "context-task.yaml"), "utf8"));
  assert.equal(task.root, contextual.packet.root);
  assert.deepEqual(task.required_authority, expectedIds);
  assert(task.unrelated_authority.every((id) => !contextual.packet.units.some((unit) => unit.id === id)));
  assert.deepEqual(task.allowed_inputs, ["projected_authority_guide", "bounded_context_packet", "task_authority", "diagnostics"]);
});

test("bounded context closes relations both within one YAML container and across containers", async () => {
  const state = await corpus();
  const source = path.join(state.target, "session.authority.yaml");
  const document = YAML.parse(await readFile(source, "utf8"));
  const moved = document.units.filter((unit) => ["definition.session", "definition.session-v0"].includes(unit.id));
  document.units = document.units.filter((unit) => !moved.includes(unit));
  await writeFile(source, YAML.stringify(document, { indent: 2, lineWidth: 0 }), "utf8");
  await writeFile(path.join(state.target, "definitions.authority.yaml"), YAML.stringify({ format: document.format, units: moved }, { indent: 2, lineWidth: 0 }), "utf8");
  for (const file of [source, path.join(state.target, "definitions.authority.yaml")]) {
    assert.equal((await runCli(state.root, ["authority", "fmt", file, "--json"])).code, 0);
  }
  const result = await contextAuthorityPath(state.target, "rule.checkout-session", { maxUnits: 5, maxBytes: 65536 });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.fileCount, 2);
  assert.deepEqual(result.packet.units.map((unit) => unit.id), [
    "definition.session",
    "definition.session-v0",
    "rule.checkout-session",
    "rule.checkout-session-v0",
    "rule.checkout-session-v00",
  ]);
  const files = new Set(Object.values(result.packet.sourceMap.fields).map((mapped) => mapped.file));
  assert.deepEqual([...files].sort(), ["definitions.authority.yaml", "session.authority.yaml"]);
});

test("unknown, ambiguous, invalid-graph, and over-budget requests fail without partial packets", async () => {
  const state = await corpus();
  const relocatedState = await corpus();

  const unknown = await queryAuthorityPath(state.target, "rule.unknown", { maxBytes: 65536 });
  const relocatedUnknown = await queryAuthorityPath(relocatedState.target, "rule.unknown", { maxBytes: 65536 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.packet, null);
  assert.equal(unknown.diagnostics[0].code, "AUTH_QUERY_NOT_FOUND");
  assert.equal(unknown.diagnostics[0].path, ".");
  assert.deepEqual(relocatedUnknown, unknown);
  const unknownCli = await runCli(state.root, ["authority", "query", state.target, "rule.unknown", "--max-bytes", "65536", "--json"]);
  const relocatedUnknownCli = await runCli(relocatedState.root, ["authority", "query", relocatedState.target, "rule.unknown", "--max-bytes", "65536", "--json"]);
  assert.equal(unknownCli.stdout, relocatedUnknownCli.stdout);

  const overBudget = await contextAuthorityPath(state.target, "rule.checkout-session", { maxUnits: 4, maxBytes: 65536 });
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.packet, null);
  assert.equal(overBudget.unitCount, 0);
  assert.equal(overBudget.diagnostics[0].code, "AUTH_CONTEXT_BUDGET");
  assert.match(overBudget.diagnostics[0].reason, /requires 5 units/);

  await cp(path.join(state.target, "session.authority.yaml"), path.join(state.target, "session-copy.authority.yaml"));
  const ambiguous = await queryAuthorityPath(state.target, "definition.session", { maxBytes: 65536 });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.packet, null);
  assert(ambiguous.diagnostics.some((entry) => entry.code === "AUTH_ID_DUPLICATE"));
  await rm(path.join(state.target, "session-copy.authority.yaml"));

  const rulePath = path.join(state.target, "session.authority.yaml");
  const rule = await readFile(rulePath, "utf8");
  await writeFile(rulePath, rule.replace("target: definition.session", "target: definition.unknown"), "utf8");
  const dangling = await contextAuthorityPath(state.target, "rule.checkout-session", { maxUnits: 8, maxBytes: 65536 });
  assert.equal(dangling.ok, false);
  assert.equal(dangling.packet, null);
  assert(dangling.diagnostics.some((entry) => entry.code === "AUTH_RELATION_DANGLING"));

  await writeFile(rulePath, rule, "utf8");
  const removedRulePath = path.join(state.target, "session.authority.yaml");
  const removedRule = await readFile(removedRulePath, "utf8");
  await writeFile(removedRulePath, removedRule.replace("target: rule.checkout-session-v00", "target: rule.checkout-session-v0"), "utf8");
  const cycle = await contextAuthorityPath(state.target, "rule.checkout-session", { maxUnits: 8, maxBytes: 65536 });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.packet, null);
  assert(cycle.diagnostics.some((entry) => entry.code === "AUTH_RELATION_CYCLE"));
});

test("independent UTF-8 measurement and exact N/N-1 boundaries hold for multibyte query and context packets", async () => {
  const state = await corpus();
  const largeCorpus = path.join(state.root, "large-authority");
  await mkdir(largeCorpus);
  const largeFile = path.join(largeCorpus, "large.authority.yaml");
  await writeFile(largeFile, [
    "format: nimicoding.authority/v1",
    "units:",
    "  - id: definition.large",
    "    kind: definition",
    "    owner: team.identity",
    "    lifecycle: active",
    "    title: 多字节 😀界 definition",
    `    meaning: ${"😀界".repeat(300_000)}`,
    "    relations: []",
    "",
  ].join("\n"), "utf8");
  assert.equal((await runCli(state.root, ["authority", "fmt", largeFile, "--json"])).code, 0);

  async function assertExactBoundary(run) {
    const seed = await run(8_000_000);
    assert.equal(seed.ok, true, JSON.stringify(seed.diagnostics));
    const serialized = JSON.stringify(seed.packet);
    const exactBytes = Buffer.byteLength(serialized, "utf8");
    assert.notEqual(exactBytes, serialized.length);
    assert(exactBytes > 2 * 1024 * 1024);

    const exact = await run(exactBytes);
    assert.equal(exact.ok, true, JSON.stringify(exact.diagnostics));
    assert.equal(exact.packetBytes, exactBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(exact.packet), "utf8"), exactBytes);

    const oneUnder = await run(exactBytes - 1);
    assert.equal(oneUnder.ok, false);
    assert.equal(oneUnder.packet, null);
    assert.equal(oneUnder.packetBytes, 0);
    assert.equal(oneUnder.diagnostics[0].code, "AUTH_CONTEXT_BUDGET");
    assert.match(oneUnder.diagnostics[0].reason, new RegExp(`requires ${exactBytes} UTF-8 bytes`));
  }

  await assertExactBoundary((maxBytes) => queryAuthorityPath(largeCorpus, "definition.large", { maxBytes }));
  await assertExactBoundary((maxBytes) => contextAuthorityPath(largeCorpus, "definition.large", { maxUnits: 1, maxBytes }));
});

test("public context CLI requires explicit positive unit and byte budgets and returns no partial JSON result", async () => {
  const state = await corpus();
  for (const args of [
    ["authority", "query", state.target, "definition.session", "--json"],
    ["authority", "query", state.target, "definition.session", "--max-bytes", "0", "--json"],
    ["authority", "context", state.target, "rule.checkout-session", "--max-units", "5", "--json"],
    ["authority", "context", state.target, "rule.checkout-session", "--max-units", "0", "--max-bytes", "65536", "--json"],
    ["authority", "context", state.target, "rule.checkout-session", "--max-units", "not-a-number", "--max-bytes", "65536", "--json"],
    ["authority", "context", state.target, "rule.checkout-session", "--max-units", "5", "--max-bytes", "not-a-number", "--json"],
  ]) {
    const invalidUsage = await runCli(state.root, args);
    assert.equal(invalidUsage.code, 2);
  }

  const exact = await runCli(state.root, ["authority", "query", state.target, "definition.session", "--max-bytes", "65536", "--json"]);
  assert.equal(exact.code, 0);
  assert.deepEqual(JSON.parse(exact.stdout).packet.units.map((unit) => unit.id), ["definition.session"]);

  const overflow = await runCli(state.root, ["authority", "context", state.target, "rule.checkout-session", "--max-units", "4", "--max-bytes", "65536", "--json"]);
  assert.equal(overflow.code, 1);
  const payload = JSON.parse(overflow.stdout);
  assert.equal(payload.packet, null);
  assert.equal(payload.summary.units, 0);
  assert.equal(payload.diagnostics[0].code, "AUTH_CONTEXT_BUDGET");
});
