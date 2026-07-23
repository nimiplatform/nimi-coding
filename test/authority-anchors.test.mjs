import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const temporaryRoots = [];

async function execute(file, args, options) {
  try {
    const result = await execFileAsync(file, args, options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function runCli(root, args, extraEnv = {}) {
  return execute(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1", ...extraEnv },
  });
}

function git(root, args) {
  return execute("git", args, { cwd: root, env: process.env });
}

function activeDefinition(id, meaning) {
  return {
    id,
    kind: "definition",
    owner: "team.anchor",
    lifecycle: "active",
    title: `Definition ${id}`,
    meaning,
    relations: [],
  };
}

function activeRule(id, target, fields = {}) {
  return {
    id,
    kind: "rule",
    owner: "team.anchor",
    lifecycle: "active",
    title: `Rule ${id}`,
    modality: "must",
    scope: ["api.anchor"],
    statement: fields.statement ?? "The anchor rule is explicit.",
    condition: fields.condition ?? "Always.",
    failure: fields.failure ?? "Reject the operation.",
    relations: [{ type: "applies_to", target }],
  };
}

function removedDefinition(id, reason) {
  return {
    id,
    kind: "definition",
    owner: "team.anchor",
    lifecycle: "removed",
    title: `Removed ${id}`,
    reason,
    relations: [],
  };
}

async function writeCorpus(root, units) {
  const spec = path.join(root, ".nimi", "spec");
  await mkdir(spec, { recursive: true });
  const source = path.join(spec, "anchors.authority.yaml");
  await writeFile(source, YAML.stringify({ format: "nimicoding.authority/v1", units }, { indent: 2, lineWidth: 0 }), "utf8");
  const formatted = await runCli(root, ["authority", "fmt", source, "--json"]);
  assert.equal(formatted.code, 0, formatted.stderr || formatted.stdout);
  return spec;
}

async function repository(units = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-authority-anchors-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "ok.ts"), "export const ok = true;\n", "utf8");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "anchor-fixture",
    private: true,
    scripts: { build: "node src/ok.ts", "check:realm": "node src/ok.ts" },
  }, null, 2)}\n`, "utf8");
  const selectedUnits = units ?? [
    activeDefinition("definition.anchor", "Implementation src/ok.ts uses pnpm build"),
    activeRule("rule.anchor", "definition.anchor"),
    removedDefinition("definition.removed-anchor", "Legacy src/missing.ts and pnpm dead:command references are inactive."),
  ];
  const spec = await writeCorpus(root, selectedUnits);
  const initialized = await git(root, ["init", "-q", "-b", "main"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const added = await git(root, ["add", "--", "."]);
  assert.equal(added.code, 0, added.stderr);
  return { root, spec };
}

function anchorArgs(state, budgets = {}, extra = []) {
  return [
    "authority", "anchors", state.root,
    "--spec", state.spec,
    "--max-units", String(budgets.maxUnits ?? 10),
    "--max-anchors", String(budgets.maxAnchors ?? 20),
    "--max-bytes", String(budgets.maxBytes ?? 100000),
    ...extra,
  ];
}

async function jsonAnchors(state, budgets = {}, extra = [], env = {}) {
  const output = await runCli(state.root, [...anchorArgs(state, budgets, extra), "--json"], env);
  return { output, report: output.stdout ? JSON.parse(output.stdout) : null };
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("class A tracked paths and class B root scripts resolve without scanning removed units", async () => {
  const state = await repository();
  const { output, report } = await jsonAnchors(state, {}, [], {
    GIT_DIR: path.join(state.root, "invalid-git-dir"),
    GIT_WORK_TREE: path.join(state.root, "invalid-worktree"),
    GIT_CONFIG_NOSYSTEM: "0",
  });
  assert.equal(output.code, 0, output.stderr || output.stdout);
  assert.equal(output.stderr, "");
  assert.deepEqual(report.summary, { units: 2, anchorsChecked: 2, diagnostics: 0 });
  assert.equal(report.operation, "anchors");
  assert.equal(report.ok, true);
  assert.equal(report.semantic_status, "valid");
  assert.equal(report.complete, true);
  assert.equal(report.partial, false);
  assert(report.anchors_bytes > 0);
  assert.deepEqual(report.diagnostics, []);

  const human = await runCli(state.root, anchorArgs(state));
  assert.equal(human.code, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /^nimicoding authority anchors: valid; complete=true$/m);
  assert.match(human.stdout, /^units: 2; anchors checked: 2; diagnostics: 0$/m);

  const help = await runCli(state.root, ["authority", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /authority anchors <repository-path> --spec <corpus-path> \[--scope-bindings <file>\]/);
  assert.match(help.stdout, /maximal non-whitespace token containing "\/"/);
  assert.match(help.stdout, /mjs\|js\|ts\|tsx\|rs\|go\|yaml\|yml\|md\|json\|proto\|ps1/);
  assert.match(help.stdout, /\[a-z\]\[a-z0-9:-\]\*/);
});

test("unresolved class A and dead class B anchors report exact fields in unit and anchor order", async () => {
  const state = await repository([
    activeRule("rule.a", "definition.z", {
      statement: "Use z/missing.ts",
      condition: "pnpm missing:a",
      failure: "Use a/missing.ts",
    }),
    activeDefinition("definition.z", "Use z/missing.ts a/missing.ts pnpm missing:z"),
  ]);
  const { output, report } = await jsonAnchors(state);
  assert.equal(output.code, 1, output.stderr || output.stdout);
  assert.equal(report.semantic_status, "invalid");
  assert.equal(report.complete, true);
  assert.deepEqual(report.summary, { units: 2, anchorsChecked: 6, diagnostics: 6 });
  assert.deepEqual(report.diagnostics.map(({ unitId, anchor, field, code }) => ({ unitId, anchor, field, code })), [
    { unitId: "definition.z", anchor: "a/missing.ts", field: "meaning", code: "AUTH_ANCHOR_PATH_UNRESOLVED" },
    { unitId: "definition.z", anchor: "pnpm missing:z", field: "meaning", code: "AUTH_ANCHOR_SCRIPT_UNRESOLVED" },
    { unitId: "definition.z", anchor: "z/missing.ts", field: "meaning", code: "AUTH_ANCHOR_PATH_UNRESOLVED" },
    { unitId: "rule.a", anchor: "a/missing.ts", field: "failure", code: "AUTH_ANCHOR_PATH_UNRESOLVED" },
    { unitId: "rule.a", anchor: "pnpm missing:a", field: "condition", code: "AUTH_ANCHOR_SCRIPT_UNRESOLVED" },
    { unitId: "rule.a", anchor: "z/missing.ts", field: "statement", code: "AUTH_ANCHOR_PATH_UNRESOLVED" },
  ]);
  for (const diagnostic of report.diagnostics) {
    assert(diagnostic.range.start.line > 0);
    assert(diagnostic.range.start.column > 0);
    assert.match(diagnostic.pointer, /^\/units\/\d+\/(?:meaning|statement|condition|failure)$/);
  }
  assert.match(report.diagnostics[1].reason, /absent from repository root package\.json scripts/);
});

test("scope path_glob requires a tracked match while module and command bindings remain structure-only", async () => {
  const state = await repository();
  const bindings = path.join(state.root, "scope-bindings.yaml");
  await writeFile(bindings, YAML.stringify({
    format: "nimicoding.scope-bindings/v1",
    scopes: [{
      scope: "api.anchor",
      bindings: [
        { kind: "path_glob", value: "src/**/*.ts" },
        { kind: "path_glob", value: "missing/**" },
        { kind: "module", value: "@app/missing" },
        { kind: "command", value: "pnpm missing:binding" },
      ],
    }],
  }, { indent: 2, lineWidth: 0 }), "utf8");
  assert.equal((await git(state.root, ["add", "--", "scope-bindings.yaml"])).code, 0);

  const { output, report } = await jsonAnchors(state, {}, ["--scope-bindings", bindings]);
  assert.equal(output.code, 1, output.stderr || output.stdout);
  assert.deepEqual(report.summary, { units: 2, anchorsChecked: 2, diagnostics: 1 });
  assert.equal(report.diagnostics[0].code, "AUTH_ANCHOR_SCOPE_GLOB_UNRESOLVED");
  assert.equal(report.diagnostics[0].scope, "api.anchor");
  assert.equal(report.diagnostics[0].glob, "missing/**");
  assert.match(report.diagnostics[0].reason, /scope=api\.anchor; glob=missing\/\*\*/);
  assert.match(report.diagnostics[0].pointer, /^\/scopes\/0\/bindings\/1\/value$/);
});

test("unit, anchor, and byte budgets admit N and refuse N-1 without partial results", async () => {
  const state = await repository();
  const exact = await jsonAnchors(state);
  assert.equal(exact.output.code, 0, exact.output.stderr || exact.output.stdout);
  const { units, anchorsChecked } = exact.report.summary;
  const bytes = exact.report.anchors_bytes;

  for (const [budget, value] of [["maxUnits", units], ["maxAnchors", anchorsChecked], ["maxBytes", bytes]]) {
    const admitted = await jsonAnchors(state, { [budget]: value });
    assert.equal(admitted.output.code, 0, `${budget}: ${admitted.output.stderr || admitted.output.stdout}`);
    const rejected = await jsonAnchors(state, { [budget]: value - 1 });
    assert.equal(rejected.output.code, 1, `${budget}: ${rejected.output.stderr || rejected.output.stdout}`);
    assert.equal(rejected.report.semantic_status, "refused");
    assert.equal(rejected.report.complete, false);
    assert.equal(rejected.report.partial, false);
    assert.deepEqual(rejected.report.summary, { units: 0, anchorsChecked: 0, diagnostics: 1 });
    assert.equal(rejected.report.diagnostics[0].code, "AUTH_ANCHOR_BUDGET");
  }
});

test("anchors CLI rejects missing, repeated, invalid, and unknown usage with exit 2", async () => {
  const state = await repository();
  const complete = anchorArgs(state);
  const cases = [
    complete.filter((value, index, values) => value !== "--spec" && values[index - 1] !== "--spec"),
    [...complete, "--spec", state.spec],
    complete.map((value, index, values) => values[index - 1] === "--max-anchors" ? "0" : value),
    [...complete, "--unknown"],
  ];
  for (const args of cases) {
    const output = await runCli(state.root, args);
    assert.equal(output.code, 2, output.stdout || output.stderr);
    assert.equal(output.stdout, "");
    assert.match(output.stderr, /^authority anchors /);
  }
});
