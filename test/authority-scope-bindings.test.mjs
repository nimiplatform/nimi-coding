import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const validYaml = path.join(packageRoot, "test", "fixtures", "authority", "valid", "yaml");
const temporaryRoots = [];

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function scopeEntry(scope, bindings = [{ kind: "path_glob", value: `src/${scope}/**` }]) {
  return { scope, bindings };
}

function registryDocument(scopes) {
  return {
    format: "nimicoding.scope-bindings/v1",
    scopes: scopes.map((scope) => typeof scope === "string" ? scopeEntry(scope) : scope),
  };
}

async function createState() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-scope-bindings-"));
  temporaryRoots.push(root);
  const corpus = path.join(root, "spec");
  const bindings = path.join(root, "scope-bindings.yaml");
  await cp(validYaml, corpus, { recursive: true });
  const source = path.join(corpus, "session.authority.yaml");
  const text = await readFile(source, "utf8");
  await writeFile(source, text.replace("      - api.checkout", "      - api.orders"), "utf8");
  return { corpus, bindings };
}

async function writeRegistry(file, document) {
  await writeFile(file, YAML.stringify(document, { indent: 2, lineWidth: 0 }), "utf8");
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("check accepts a closed scope registry and exposes the optional CLI syntax", async () => {
  const state = await createState();
  const document = registryDocument([
    scopeEntry("api.checkout", [
      { kind: "path_glob", value: "src/checkout/**" },
      { kind: "module", value: "@app/checkout" },
      { kind: "command", value: "pnpm test:checkout" },
    ]),
    "api.orders",
  ]);
  await writeRegistry(state.bindings, document);

  const result = await runCli(["authority", "check", state.corpus, "--scope-bindings", state.bindings, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    operation: "check",
    ok: true,
    semantic_status: "valid",
    summary: { files: 1, units: 6, diagnostics: 0 },
    diagnostics: [],
  });

  const help = await runCli(["authority", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /authority check <path> \[--scope-bindings <file>\] \[--json\]/);

  const missingValue = await runCli(["authority", "check", state.corpus, "--scope-bindings"]);
  assert.equal(missingValue.code, 2);
  assert.equal(missingValue.stdout, "");
  assert.match(missingValue.stderr, /^authority check requires --scope-bindings followed by one file\n/);

  const repeated = await runCli([
    "authority", "check", state.corpus,
    "--scope-bindings", state.bindings,
    "--scope-bindings", state.bindings,
  ]);
  assert.equal(repeated.code, 2);
  assert.equal(repeated.stdout, "");
  assert.match(repeated.stderr, /^authority check refused unknown or repeated option: --scope-bindings\n/);
});

test("check reports every active-rule use of an unregistered scope with its unit ID", async () => {
  const state = await createState();
  const source = path.join(state.corpus, "session.authority.yaml");
  const text = await readFile(source, "utf8");
  const lastCheckout = text.lastIndexOf("      - api.checkout");
  assert.notEqual(lastCheckout, -1);
  await writeFile(source, `${text.slice(0, lastCheckout)}      - api.checkout\n      - api.shipping${text.slice(lastCheckout + "      - api.checkout".length)}`, "utf8");
  await writeRegistry(state.bindings, registryDocument(["api.checkout"]));

  const result = await runCli(["authority", "check", state.corpus, "--scope-bindings", state.bindings, "--json"]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.semantic_status, "invalid");
  assert.deepEqual(report.summary, { files: 1, units: 0, diagnostics: 2 });
  assert.deepEqual(report.diagnostics.map(({ code, reason, pointer }) => ({ code, reason, pointer })), [
    {
      code: "AUTH_SCOPE_UNREGISTERED",
      reason: "active rule rule.checkout-session uses unregistered scope: api.orders",
      pointer: "/units/0/scope/0",
    },
    {
      code: "AUTH_SCOPE_UNREGISTERED",
      reason: "active rule rule.checkout-no-anonymous uses unregistered scope: api.shipping",
      pointer: "/units/2/scope/1",
    },
  ]);
});

test("check rejects every registered scope with no active-rule use", async () => {
  const state = await createState();
  await writeRegistry(state.bindings, registryDocument(["api.checkout", "api.orders", "api.dead"]));

  const result = await runCli(["authority", "check", state.corpus, "--scope-bindings", state.bindings, "--json"]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.summary, { files: 1, units: 0, diagnostics: 1 });
  assert.equal(report.diagnostics[0].code, "AUTH_SCOPE_BINDING_UNUSED");
  assert.equal(report.diagnostics[0].reason, "registered scope has no active rule use: api.dead");
  assert.equal(report.diagnostics[0].pointer, "/scopes/2/scope");
});

test("duplicate scope registrations fail closed", async () => {
  const state = await createState();
  await writeRegistry(state.bindings, registryDocument(["api.checkout", "api.checkout", "api.orders"]));

  const result = await runCli(["authority", "check", state.corpus, "--scope-bindings", state.bindings, "--json"]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.summary, { files: 1, units: 0, diagnostics: 1 });
  assert.equal(report.diagnostics[0].code, "AUTH_SCOPE_BINDING_INVALID");
  assert.equal(report.diagnostics[0].reason, "duplicate registered scope: api.checkout");
  assert.equal(report.diagnostics[0].pointer, "/scopes/1/scope");
});

test("closed scope registry parsing rejects structural and text adversaries without partial results", async (t) => {
  const state = await createState();
  const valid = registryDocument(["api.checkout", "api.orders"]);
  const invalidDocuments = [
    { name: "unknown top-level key", value: { ...valid, extra: true } },
    { name: "empty scopes", value: { ...valid, scopes: [] } },
    { name: "unknown scope key", value: { ...valid, scopes: [{ ...valid.scopes[0], extra: true }] } },
    { name: "empty bindings", value: { ...valid, scopes: [scopeEntry("api.checkout", [])] } },
    { name: "unknown binding key", value: { ...valid, scopes: [scopeEntry("api.checkout", [{ kind: "module", value: "@app/checkout", extra: true }])] } },
    { name: "unknown binding kind", value: { ...valid, scopes: [scopeEntry("api.checkout", [{ kind: "repository", value: "src/checkout" }])] } },
    { name: "multiline scope", value: { ...valid, scopes: [scopeEntry("api.checkout\napi.orders")] } },
    { name: "multiline binding value", value: { ...valid, scopes: [scopeEntry("api.checkout", [{ kind: "command", value: "pnpm test\npnpm build" }])] } },
  ];

  for (const adversary of invalidDocuments) {
    await t.test(adversary.name, async () => {
      await writeRegistry(state.bindings, adversary.value);
      const result = await runCli(["authority", "check", state.corpus, "--scope-bindings", state.bindings, "--json"]);
      assert.equal(result.code, 1, result.stderr || result.stdout);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.operation, "check");
      assert.equal(report.ok, false);
      assert.equal(report.semantic_status, "invalid");
      assert.deepEqual(report.summary, { files: 1, units: 0, diagnostics: 1 });
      assert.equal(report.diagnostics[0].code, "AUTH_SCOPE_BINDING_INVALID");
      assert.equal(Object.hasOwn(report, "scopeBindings"), false);
    });
  }
});

test("omitting --scope-bindings preserves check behavior and ignores registry files", async () => {
  const state = await createState();
  await writeFile(state.bindings, "format: invalid\nscopes: []\n", "utf8");

  const result = await runCli(["authority", "check", state.corpus, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    operation: "check",
    ok: true,
    semantic_status: "valid",
    summary: { files: 1, units: 6, diagnostics: 0 },
    diagnostics: [],
  });
});
