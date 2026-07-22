import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { diffAuthorityPaths } from "../cli/lib/authority/diff.mjs";
import { impactAuthorityPaths } from "../cli/lib/authority/impact.mjs";
import { stringifyCanonicalYaml } from "../cli/lib/authority/source-yaml.mjs";

import YAML from "yaml";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixtures = path.join(packageRoot, "test", "fixtures", "authority");
const temporaryRoots = [];

const unitFiles = new Map([
  ["definition.session", "session.authority.yaml"],
  ["definition.session-v0", "session-v0.authority.yaml"],
  ["rule.checkout-session", "checkout-session.authority.yaml"],
  ["rule.checkout-session-v0", "checkout-session-v0.authority.yaml"],
  ["rule.checkout-session-v00", "checkout-session-v00.authority.yaml"],
  ["rule.checkout-no-anonymous", "checkout-no-anonymous.authority.yaml"],
]);

async function splitContainers(directory) {
  const source = path.join(directory, "session.authority.yaml");
  const document = YAML.parse(await readFile(source, "utf8"));
  await rm(source);
  for (const unit of document.units) {
    await writeFile(path.join(directory, unitFiles.get(unit.id)), stringifyCanonicalYaml({ format: document.format, units: [unit] }, { container: true }), "utf8");
  }
}

async function comparison() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-impact-"));
  temporaryRoots.push(root);
  const before = path.join(root, "before");
  const afterPath = path.join(root, "after");
  await cp(path.join(fixtures, "valid", "yaml"), before, { recursive: true });
  await cp(path.join(fixtures, "valid", "yaml"), afterPath, { recursive: true });
  await splitContainers(before);
  await splitContainers(afterPath);
  return { root, before, after: afterPath };
}

async function replace(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.includes(before)) {
    await writeFile(file, source.replace(before, after), "utf8");
    return;
  }
  const indent = (value) => value.split("\n").map((line) => line.length > 0 ? `    ${line}` : line).join("\n");
  assert(source.includes(indent(before)));
  await writeFile(file, source.replace(indent(before), indent(after)), "utf8");
}

async function writeSingleUnit(file, unit) {
  await writeFile(file, stringifyCanonicalYaml({ format: "nimicoding.authority/v1", units: [unit] }, { container: true }), "utf8");
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

test("semantic diff ignores profile-only changes and precisely traces normative fields", async () => {
  const equivalent = await diffAuthorityPaths(
    path.join(fixtures, "valid", "yaml"),
    path.join(fixtures, "valid", "markdown"),
  );
  assert.equal(equivalent.ok, true);
  assert.deepEqual(equivalent.diff.changes, []);

  const state = await comparison();
  const rule = path.join(state.after, "checkout-session.authority.yaml");
  await replace(rule, "condition: Always.", "condition: For authenticated checkout.");
  const result = await diffAuthorityPaths(state.before, state.after);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diff, {
    format: "nimicoding.authority-diff/v1",
    changes: [{
      unitId: "rule.checkout-session",
      operation: "modified",
      pointer: "/semantic/condition",
      before: "Always.",
      after: "For authenticated checkout.",
      beforeSource: {
        file: "checkout-session.authority.yaml",
        range: {
          start: { line: 12, column: 16 },
          end: { line: 12, column: 23 },
        },
        sourcePointer: "/units/0/condition",
      },
      afterSource: {
        file: "checkout-session.authority.yaml",
        range: {
          start: { line: 12, column: 16 },
          end: { line: 12, column: 43 },
        },
        sourcePointer: "/units/0/condition",
      },
    }],
    summary: { units: 1, changes: 1 },
  });

  const repeated = await diffAuthorityPaths(state.before, state.after);
  assert.deepEqual(repeated.diff, result.diff);
});

test("multi-unit regroup, file rename, and source order are non-semantic while one-unit mutation stays precise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-regroup-"));
  temporaryRoots.push(root);
  const before = path.join(root, "before");
  const afterPath = path.join(root, "after");
  await cp(path.join(fixtures, "valid", "yaml"), before, { recursive: true });
  await cp(path.join(fixtures, "valid", "yaml"), afterPath, { recursive: true });
  const original = path.join(afterPath, "session.authority.yaml");
  const document = YAML.parse(await readFile(original, "utf8"));
  const reordered = [...document.units].reverse();
  await rm(original);
  await writeFile(path.join(afterPath, "renamed-b.authority.yaml"), stringifyCanonicalYaml({ format: document.format, units: reordered.slice(0, 2) }, { container: true }), "utf8");
  await writeFile(path.join(afterPath, "renamed-a.authority.yaml"), stringifyCanonicalYaml({ format: document.format, units: reordered.slice(2) }, { container: true }), "utf8");

  const regrouped = await diffAuthorityPaths(before, afterPath);
  assert.equal(regrouped.ok, true, JSON.stringify(regrouped.diagnostics));
  assert.deepEqual(regrouped.diff.changes, []);
  const empty = path.join(root, "empty.yaml");
  await writeFile(empty, "format: nimicoding.authority-impact-dispositions/v1\nrules: []\n", "utf8");
  const noImpact = await impactAuthorityPaths(before, afterPath, empty);
  assert.equal(noImpact.ok, true, JSON.stringify(noImpact.diagnostics));
  assert.deepEqual(noImpact.impact.changedUnits, []);
  assert.deepEqual(noImpact.impact.impactedUnits, []);

  const targetFile = path.join(afterPath, "renamed-a.authority.yaml");
  const target = YAML.parse(await readFile(targetFile, "utf8"));
  const sourceIndex = target.units.findIndex((unit) => unit.id === "rule.checkout-session");
  target.units[sourceIndex].condition = "For authenticated checkout.";
  await writeFile(targetFile, stringifyCanonicalYaml(target, { container: true }), "utf8");
  const changed = await diffAuthorityPaths(before, afterPath);
  assert.equal(changed.ok, true, JSON.stringify(changed.diagnostics));
  assert.equal(changed.diff.summary.changes, 1);
  assert.equal(changed.diff.changes[0].unitId, "rule.checkout-session");
  assert.equal(changed.diff.changes[0].pointer, "/semantic/condition");
  assert.equal(changed.diff.changes[0].afterSource.file, "renamed-a.authority.yaml");
  assert.equal(changed.diff.changes[0].afterSource.sourcePointer, `/units/${sourceIndex}/condition`);
});

test("modality, scope, failure, lifecycle, and relation changes produce stable semantic paths", async () => {
  const mutations = [
    ["modality", "modality: must", "modality: must_not", "/semantic/modality"],
    ["scope", "  - api.checkout", "  - api.orders", "/semantic/scope"],
    ["failure", "failure: Reject the request before creating an order.", "failure: Return an authentication failure.", "/semantic/failure"],
  ];
  for (const [, beforeText, afterText, pointer] of mutations) {
    const state = await comparison();
    await replace(path.join(state.after, "checkout-session.authority.yaml"), beforeText, afterText);
    const result = await diffAuthorityPaths(state.before, state.after);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert(result.diff.changes.some((change) => change.pointer === pointer));
  }

  const lifecycle = await comparison();
  await writeSingleUnit(path.join(lifecycle.after, "checkout-session.authority.yaml"), {
    id: "rule.checkout-session",
    kind: "rule",
    owner: "team.checkout",
    lifecycle: "removed",
    title: "Checkout requests require a session",
    reason: "Requirement retired by product authority.",
    relations: [{ type: "supersedes", target: "rule.checkout-session-v0" }],
  });
  const lifecycleDiff = await diffAuthorityPaths(lifecycle.before, lifecycle.after);
  assert.equal(lifecycleDiff.ok, true, JSON.stringify(lifecycleDiff.diagnostics));
  assert(lifecycleDiff.diff.changes.some((change) => change.pointer === "/lifecycle"));
  assert(lifecycleDiff.diff.changes.some((change) => change.pointer === "/relations" && change.operation === "removed"));
});

test("physical deletion is rejected so a two-step tombstone resurrection cannot begin", async () => {
  const state = await comparison();
  await rm(path.join(state.after, "session-v0.authority.yaml"));
  await replace(
    path.join(state.after, "session.authority.yaml"),
    "relations:\n  - type: supersedes\n    target: definition.session-v0",
    "relations: []",
  );
  const deletedTombstone = await diffAuthorityPaths(state.before, state.after);
  assert.equal(deletedTombstone.ok, false);
  assert.equal(deletedTombstone.diff, null);
  const deletedTombstoneDiagnostic = deletedTombstone.diagnostics.find((entry) => entry.code === "AUTH_DIFF_TRANSITION_INVALID" && /physically disappear/.test(entry.reason));
  assert.deepEqual({
    path: deletedTombstoneDiagnostic.path,
    pointer: deletedTombstoneDiagnostic.pointer,
    range: deletedTombstoneDiagnostic.range,
  }, {
    path: "before/session-v0.authority.yaml",
    pointer: "/units/0/id",
    range: { start: { line: 3, column: 9 }, end: { line: 3, column: 30 } },
  });

  const active = await comparison();
  await rm(path.join(active.after, "checkout-no-anonymous.authority.yaml"));
  const deletedActive = await diffAuthorityPaths(active.before, active.after);
  assert.equal(deletedActive.ok, false);
  const deletedActiveDiagnostic = deletedActive.diagnostics.find((entry) => /removed tombstone/.test(entry.repair));
  assert.deepEqual({
    path: deletedActiveDiagnostic.path,
    pointer: deletedActiveDiagnostic.pointer,
    range: deletedActiveDiagnostic.range,
  }, {
    path: "before/checkout-no-anonymous.authority.yaml",
    pointer: "/units/0/id",
    range: { start: { line: 3, column: 9 }, end: { line: 3, column: 35 } },
  });
});

test("multi-unit array deletion diagnostics use exact before-side identity and relocate byte-identically", async () => {
  async function state(prefix) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(root);
    const before = path.join(root, "before");
    const afterPath = path.join(root, "after");
    await cp(path.join(fixtures, "valid", "yaml"), before, { recursive: true });
    await cp(path.join(fixtures, "valid", "yaml"), afterPath, { recursive: true });
    return { root, before, after: afterPath };
  }

  const active = await state("nimicoding-multi-delete-active-");
  const activeFile = path.join(active.after, "session.authority.yaml");
  const activeDocument = YAML.parse(await readFile(activeFile, "utf8"));
  activeDocument.units = activeDocument.units.filter((unit) => unit.id !== "rule.checkout-no-anonymous");
  await writeFile(activeFile, stringifyCanonicalYaml(activeDocument, { container: true }), "utf8");
  const activeResult = await diffAuthorityPaths(active.before, active.after);
  assert.equal(activeResult.ok, false);
  assert.equal(activeResult.diff, null);
  assert.equal(activeResult.unitCount, 0);
  assert.deepEqual(activeResult.diagnostics.map((entry) => ({ path: entry.path, pointer: entry.pointer, range: entry.range })), [{
    path: "before/session.authority.yaml",
    pointer: "/units/2/id",
    range: { start: { line: 28, column: 9 }, end: { line: 28, column: 35 } },
  }]);

  const relocated = await state("nimicoding-multi-delete-relocated-");
  const relocatedFile = path.join(relocated.after, "session.authority.yaml");
  const relocatedDocument = YAML.parse(await readFile(relocatedFile, "utf8"));
  relocatedDocument.units = relocatedDocument.units.filter((unit) => unit.id !== "rule.checkout-no-anonymous");
  await writeFile(relocatedFile, stringifyCanonicalYaml(relocatedDocument, { container: true }), "utf8");
  const firstCli = await runCli(active.root, ["authority", "diff", active.before, active.after, "--max-bytes", "65536", "--json"]);
  const relocatedCli = await runCli(relocated.root, ["authority", "diff", relocated.before, relocated.after, "--max-bytes", "65536", "--json"]);
  assert.equal(firstCli.code, 1);
  assert.equal(relocatedCli.code, 1);
  assert.equal(relocatedCli.stdout, firstCli.stdout);

  const removed = await state("nimicoding-multi-delete-removed-");
  const removedFile = path.join(removed.after, "session.authority.yaml");
  const removedDocument = YAML.parse(await readFile(removedFile, "utf8"));
  removedDocument.units = removedDocument.units.filter((unit) => unit.id !== "rule.checkout-session-v00");
  removedDocument.units.find((unit) => unit.id === "rule.checkout-session-v0").relations = [];
  await writeFile(removedFile, stringifyCanonicalYaml(removedDocument, { container: true }), "utf8");
  const removedResult = await diffAuthorityPaths(removed.before, removed.after);
  assert.equal(removedResult.ok, false);
  assert.equal(removedResult.diff, null);
  assert.equal(removedResult.unitCount, 0);
  assert.deepEqual(removedResult.diagnostics.map((entry) => ({ path: entry.path, pointer: entry.pointer, range: entry.range })), [{
    path: "before/session.authority.yaml",
    pointer: "/units/5/id",
    range: { start: { line: 58, column: 9 }, end: { line: 58, column: 34 } },
  }]);
});

test("relation added and removed operations match the diff v1 record contract", async () => {
  const state = await comparison();
  const relation = "  - type: supersedes\n    target: rule.checkout-session-v0\n";
  await replace(path.join(state.after, "checkout-session.authority.yaml"), relation, "");
  const removed = await diffAuthorityPaths(state.before, state.after);
  assert.equal(removed.ok, true, JSON.stringify(removed.diagnostics));
  const removedRelation = removed.diff.changes.find((change) => change.pointer === "/relations" && change.operation === "removed");
  assert(removedRelation);
  assert.equal(removedRelation.beforeSource.file, "checkout-session.authority.yaml");
  assert.equal(removedRelation.beforeSource.sourcePointer, "/units/0/relations/1/target");
  assert.deepEqual(removedRelation.beforeSource.range, {
    start: { line: 18, column: 17 },
    end: { line: 18, column: 41 },
  });
  assert.equal(Object.hasOwn(removedRelation, "afterSource"), false);
  assert(!removed.diff.changes.some((change) => change.operation === "unit_removed"));

  const added = await diffAuthorityPaths(state.after, state.before);
  assert.equal(added.ok, true, JSON.stringify(added.diagnostics));
  const addedRelation = added.diff.changes.find((change) => change.pointer === "/relations" && change.operation === "added");
  assert(addedRelation);
  assert.equal(addedRelation.afterSource.file, "checkout-session.authority.yaml");
  assert.equal(addedRelation.afterSource.sourcePointer, "/units/0/relations/1/target");
  assert.deepEqual(addedRelation.afterSource.range, {
    start: { line: 18, column: 17 },
    end: { line: 18, column: 41 },
  });
  assert.equal(Object.hasOwn(addedRelation, "beforeSource"), false);
});

test("unit_added and scope set branches expose the complete expected SourceMap side", async () => {
  const state = await comparison();
  await writeSingleUnit(path.join(state.after, "added.authority.yaml"), {
    id: "definition.added",
    kind: "definition",
    owner: "team.added",
    lifecycle: "removed",
    title: "Added tombstone",
    reason: "Reserved by explicit product authority.",
    relations: [],
  });
  const unitResult = await diffAuthorityPaths(state.before, state.after);
  assert.equal(unitResult.ok, true, JSON.stringify(unitResult.diagnostics));
  const unit = unitResult.diff.changes.find((change) => change.operation === "unit_added");
  assert.deepEqual({ unitId: unit.unitId, pointer: unit.pointer, before: unit.before }, { unitId: "definition.added", pointer: "", before: null });
  assert.deepEqual(unit.after, {
    id: "definition.added",
    kind: "definition",
    owner: "team.added",
    lifecycle: "removed",
    metadata: {
      title: "Added tombstone",
      reason: "Reserved by explicit product authority.",
    },
    relations: [],
  });
  assert.equal(unit.afterSource.file, "added.authority.yaml");
  assert.equal(unit.afterSource.sourcePointer, "/units/0/id");
  assert.deepEqual(unit.afterSource.range, {
    start: { line: 3, column: 9 },
    end: { line: 3, column: 25 },
  });
  assert.equal(Object.hasOwn(unit, "beforeSource"), false);

  const scoped = await comparison();
  await replace(path.join(scoped.after, "checkout-session.authority.yaml"), "scope:\n  - api.checkout", "scope:\n  - api.checkout\n  - api.orders");
  const scopeAddedResult = await diffAuthorityPaths(scoped.before, scoped.after);
  const scopeAdded = scopeAddedResult.diff.changes.find((change) => change.pointer === "/semantic/scope" && change.operation === "added");
  assert.deepEqual({ before: scopeAdded.before, after: scopeAdded.after }, { before: null, after: "api.orders" });
  assert.equal(scopeAdded.afterSource.sourcePointer, "/units/0/scope/1");
  assert.deepEqual(scopeAdded.afterSource.range, {
    start: { line: 11, column: 9 },
    end: { line: 11, column: 19 },
  });
  assert.equal(Object.hasOwn(scopeAdded, "beforeSource"), false);

  const scopeRemovedResult = await diffAuthorityPaths(scoped.after, scoped.before);
  const scopeRemoved = scopeRemovedResult.diff.changes.find((change) => change.pointer === "/semantic/scope" && change.operation === "removed");
  assert.deepEqual({ before: scopeRemoved.before, after: scopeRemoved.after }, { before: "api.orders", after: null });
  assert.equal(scopeRemoved.beforeSource.sourcePointer, "/units/0/scope/1");
  assert.deepEqual(scopeRemoved.beforeSource.range, {
    start: { line: 11, column: 9 },
    end: { line: 11, column: 19 },
  });
  assert.equal(Object.hasOwn(scopeRemoved, "afterSource"), false);
});

test("same-ID kind changes fail between independently valid snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-kind-transition-"));
  temporaryRoots.push(root);
  const before = path.join(root, "before");
  const afterPath = path.join(root, "after");
  await mkdir(before);
  await mkdir(afterPath);
  const unit = (kind) => ({
    id: "unit.kind-swap",
    kind,
    owner: "team.identity",
    lifecycle: "removed",
    title: "Kind tombstone",
    reason: "Retained transition fixture.",
    relations: [],
  });
  await writeSingleUnit(path.join(before, "kind.authority.yaml"), unit("definition"));
  await writeSingleUnit(path.join(afterPath, "kind.authority.yaml"), unit("rule"));
  const result = await diffAuthorityPaths(before, afterPath);
  assert.equal(result.ok, false);
  assert.equal(result.diff, null);
  const diagnostic = result.diagnostics.find((entry) => entry.code === "AUTH_DIFF_TRANSITION_INVALID" && /cannot change kind/.test(entry.reason));
  assert.deepEqual({ path: diagnostic.path, pointer: diagnostic.pointer, range: diagnostic.range }, {
    path: "after/kind.authority.yaml",
    pointer: "/units/0/id",
    range: { start: { line: 3, column: 9 }, end: { line: 3, column: 23 } },
  });
});

test("non-normative metadata diff does not create consumer or test impact obligations", async () => {
  const state = await comparison();
  await replace(path.join(state.after, "checkout-session.authority.yaml"), "title: Checkout requests require a session", "title: Checkout session requirement");
  const empty = path.join(state.root, "empty-dispositions.yaml");
  await writeFile(empty, "format: nimicoding.authority-impact-dispositions/v1\nrules: []\n", "utf8");
  const result = await impactAuthorityPaths(state.before, state.after, empty);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diff.summary.changes, 1);
  assert.deepEqual(result.impact.changedUnits, []);
  assert.deepEqual(result.impact.impactedUnits, []);
  assert.deepEqual(result.impact.obligations, []);
});

test("impact follows only declared reverse dependencies and requires exact consumer/test dispositions", async () => {
  const state = await comparison();
  await replace(path.join(state.after, "checkout-session.authority.yaml"), "condition: Always.", "condition: For authenticated checkout.");
  const dispositions = path.join(fixtures, "impact-dispositions.yaml");
  const complete = await impactAuthorityPaths(state.before, state.after, dispositions);
  assert.equal(complete.ok, true, JSON.stringify(complete.diagnostics));
  assert.deepEqual(complete.impact, {
    format: "nimicoding.authority-impact/v1",
    changedUnits: ["rule.checkout-session"],
    impactedUnits: [{ id: "rule.checkout-session", kind: "rule" }],
    obligations: [
      {
        ruleId: "rule.checkout-session",
        type: "consumer",
        target: "api.checkout",
        disposition: {
          ruleId: "rule.checkout-session",
          type: "consumer",
          target: "api.checkout",
          status: "addressed",
          evidence: "tests/checkout-session.test.mjs",
        },
      },
      {
        ruleId: "rule.checkout-session",
        type: "test",
        target: "rule.checkout-session",
        disposition: {
          ruleId: "rule.checkout-session",
          type: "test",
          target: "rule.checkout-session",
          status: "addressed",
          evidence: "tests/checkout-session.test.mjs",
        },
      },
    ],
    complete: true,
  });

  const missing = path.join(state.root, "missing.yaml");
  await writeFile(missing, [
    "format: nimicoding.authority-impact-dispositions/v1",
    "rules:",
    "  - id: rule.checkout-session",
    "    consumers: []",
    "    test:",
    "      status: addressed",
    "      evidence: tests/checkout-session.test.mjs",
    "",
  ].join("\n"), "utf8");
  const unresolved = await impactAuthorityPaths(state.before, state.after, missing);
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.impact.complete, false);
  assert(unresolved.diagnostics.some((entry) => entry.code === "AUTH_IMPACT_UNDISPOSED" && /consumer/.test(entry.reason)));
  assert(!unresolved.impact.impactedUnits.some((unit) => unit.id === "rule.checkout-no-anonymous"));

  const malformed = path.join(state.root, "malformed.yaml");
  await writeFile(malformed, "format: nimicoding.authority-impact-dispositions/v1\nrules: []\nunknown: true\n", "utf8");
  const malformedResult = await impactAuthorityPaths(state.before, state.after, malformed);
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.diagnostics[0].code, "AUTH_IMPACT_DISPOSITION_INVALID");

  const validText = await readFile(dispositions, "utf8");
  const invalidCases = [
    ["invalid-status", validText.replace("status: addressed", "status: pending")],
    ["empty-evidence", validText.replace("evidence: tests/checkout-session.test.mjs", "evidence: \"\"")],
    ["invalid-id", validText.replace("id: rule.checkout-session", "id: Rule.Invalid")],
    ["duplicate-rule", `${validText}${validText.slice(validText.indexOf("  - id:"))}`],
  ];
  for (const [name, content] of invalidCases) {
    const file = path.join(state.root, `${name}.yaml`);
    await writeFile(file, content, "utf8");
    const rejected = await impactAuthorityPaths(state.before, state.after, file);
    assert.equal(rejected.ok, false, name);
    assert(rejected.diagnostics.some((entry) => entry.code === "AUTH_IMPACT_DISPOSITION_INVALID"), name);
  }

  const duplicate = path.join(state.root, "duplicate.yaml");
  await writeFile(duplicate, (await readFile(dispositions, "utf8")).replace(
    "    test:\n",
    "      - scope: api.checkout\n        status: addressed\n        evidence: tests/duplicate.test.mjs\n    test:\n",
  ), "utf8");
  const duplicateResult = await impactAuthorityPaths(state.before, state.after, duplicate);
  assert.equal(duplicateResult.ok, false);
  assert(duplicateResult.diagnostics.some((entry) => entry.code === "AUTH_IMPACT_DISPOSITION_INVALID" && /duplicate/.test(entry.reason)));

  const extra = path.join(state.root, "extra.yaml");
  await writeFile(extra, (await readFile(dispositions, "utf8")).replace(
    "rules:\n",
    "rules:\n  - id: rule.checkout-no-anonymous\n    consumers: []\n    test:\n      status: addressed\n      evidence: tests/unrelated.test.mjs\n",
  ), "utf8");
  const extraResult = await impactAuthorityPaths(state.before, state.after, extra);
  assert.equal(extraResult.ok, false);
  assert(extraResult.diagnostics.some((entry) => entry.code === "AUTH_IMPACT_DISPOSITION_INVALID" && /does not match/.test(entry.reason)));
});

test("reverse supersedes closure is recursive and scope obligations use the before/after union", async () => {
  const lineage = await comparison();
  await replace(path.join(lineage.after, "checkout-session-v00.authority.yaml"), "owner: team.checkout", "owner: team.legacy");
  const recursive = await impactAuthorityPaths(lineage.before, lineage.after, path.join(fixtures, "impact-dispositions.yaml"));
  assert.equal(recursive.ok, true, JSON.stringify(recursive.diagnostics));
  assert.deepEqual(recursive.impact.impactedUnits.map((unit) => unit.id), [
    "rule.checkout-session",
    "rule.checkout-session-v0",
    "rule.checkout-session-v00",
  ]);

  const scoped = await comparison();
  await replace(path.join(scoped.after, "checkout-session.authority.yaml"), "scope:\n  - api.checkout", "scope:\n  - api.checkout\n  - api.orders");
  const dispositions = path.join(scoped.root, "scope-union.yaml");
  await writeFile(dispositions, [
    "format: nimicoding.authority-impact-dispositions/v1",
    "rules:",
    "  - id: rule.checkout-session",
    "    consumers:",
    "      - scope: api.checkout",
    "        status: addressed",
    "        evidence: src/checkout.ts",
    "      - scope: api.orders",
    "        status: addressed",
    "        evidence: src/orders.ts",
    "    test:",
    "      status: addressed",
    "      evidence: tests/checkout-session.test.ts",
    "",
  ].join("\n"), "utf8");
  const union = await impactAuthorityPaths(scoped.before, scoped.after, dispositions);
  assert.equal(union.ok, true, JSON.stringify(union.diagnostics));
  assert.deepEqual(union.impact.obligations.filter((item) => item.type === "consumer").map((item) => item.target), ["api.checkout", "api.orders"]);
});

test("active to removed retains old consumer and test obligations", async () => {
  const state = await comparison();
  await writeSingleUnit(path.join(state.after, "checkout-session.authority.yaml"), {
    id: "rule.checkout-session",
    kind: "rule",
    owner: "team.checkout",
    lifecycle: "removed",
    title: "Checkout requests require a session",
    reason: "Requirement retired by product authority.",
    relations: [{ type: "supersedes", target: "rule.checkout-session-v0" }],
  });
  const result = await impactAuthorityPaths(state.before, state.after, path.join(fixtures, "impact-dispositions.yaml"));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.impact.obligations.map(({ type, target }) => [type, target]), [
    ["consumer", "api.checkout"],
    ["test", "rule.checkout-session"],
  ]);
});

test("definition changes impact explicit incoming rules while unrelated and invalid inputs fail closed", async () => {
  const state = await comparison();
  await replace(
    path.join(state.after, "session.authority.yaml"),
    "meaning: A server-issued identity context presented with a protected request.",
    "meaning: A server-issued identity context required by a protected request.",
  );
  const dispositions = path.join(state.root, "definition-dispositions.yaml");
  await writeFile(dispositions, [
    "format: nimicoding.authority-impact-dispositions/v1",
    "rules:",
    "  - id: rule.checkout-no-anonymous",
    "    consumers:",
    "      - scope: api.checkout",
    "        status: addressed",
    "        evidence: tests/checkout-no-anonymous.test.mjs",
    "    test:",
    "      status: addressed",
    "      evidence: tests/checkout-no-anonymous.test.mjs",
    "  - id: rule.checkout-session",
    "    consumers:",
    "      - scope: api.checkout",
    "        status: addressed",
    "        evidence: tests/checkout-session.test.mjs",
    "    test:",
    "      status: addressed",
    "      evidence: tests/checkout-session.test.mjs",
    "",
  ].join("\n"), "utf8");
  const impact = await impactAuthorityPaths(state.before, state.after, dispositions);
  assert.equal(impact.ok, true, JSON.stringify(impact.diagnostics));
  assert.deepEqual(impact.impact.impactedUnits.map((unit) => unit.id), [
    "definition.session",
    "rule.checkout-no-anonymous",
    "rule.checkout-session",
  ]);
  assert(!impact.impact.impactedUnits.some((unit) => unit.id === "definition.session-v0"));

  await writeSingleUnit(path.join(state.after, "session-v0.authority.yaml"), {
    id: "definition.session-v0",
    kind: "definition",
    owner: "team.identity",
    lifecycle: "active",
    title: "Reused session identity",
    meaning: "An illegally reactivated removed identity.",
    relations: [],
  });
  await replace(
    path.join(state.after, "session.authority.yaml"),
    "relations:\n  - type: supersedes\n    target: definition.session-v0",
    "relations: []",
  );
  const reused = await diffAuthorityPaths(state.before, state.after);
  assert.equal(reused.ok, false);
  assert.equal(reused.diff, null);
  const reusedDiagnostic = reused.diagnostics.find((entry) => entry.code === "AUTH_DIFF_TRANSITION_INVALID");
  assert.deepEqual({ path: reusedDiagnostic.path, pointer: reusedDiagnostic.pointer, range: reusedDiagnostic.range }, {
    path: "after/session-v0.authority.yaml",
    pointer: "/units/0/id",
    range: { start: { line: 3, column: 9 }, end: { line: 3, column: 30 } },
  });

  await cp(path.join(state.after, "session.authority.yaml"), path.join(state.after, "session-copy.authority.yaml"));
  const invalid = await diffAuthorityPaths(state.before, state.after);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diff, null);
  assert(invalid.diagnostics.some((entry) => entry.code === "AUTH_ID_DUPLICATE"));
});

test("invalid before/after diagnostics are side-qualified, portable, related-normalized, and globally sorted", async () => {
  const state = await comparison();
  for (const side of [state.before, state.after]) {
    for (const branch of ["alpha", "omega"]) {
      const nested = path.join(side, "nested", branch);
      await mkdir(nested, { recursive: true });
      await cp(path.join(side, "checkout-no-anonymous.authority.yaml"), path.join(nested, "rule.authority.yaml"));
    }
    await rm(path.join(side, "checkout-no-anonymous.authority.yaml"));
  }

  const relocatedRoot = await mkdtemp(path.join(os.tmpdir(), "nimicoding-invalid-relocated-"));
  temporaryRoots.push(relocatedRoot);
  const relocatedBefore = path.join(relocatedRoot, "before");
  const relocatedAfter = path.join(relocatedRoot, "after");
  await cp(state.before, relocatedBefore, { recursive: true });
  await cp(state.after, relocatedAfter, { recursive: true });

  const first = await runCli(state.root, ["authority", "diff", state.before, state.after, "--max-bytes", "65536", "--json"]);
  const relocated = await runCli(relocatedRoot, ["authority", "diff", relocatedBefore, relocatedAfter, "--max-bytes", "65536", "--json"]);
  assert.equal(first.code, 1);
  assert.equal(relocated.code, 1);
  assert.equal(relocated.stdout, first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.diff, null);
  assert.deepEqual(report.diagnostics.map((entry) => ({
    code: entry.code,
    path: entry.path,
    range: entry.range,
    pointer: entry.pointer,
    related: entry.related.map((related) => ({
      path: related.path,
      range: related.range,
      pointer: related.pointer,
      role: related.role,
    })),
  })), [
    {
      code: "AUTH_ID_DUPLICATE",
      path: "after/nested/alpha/rule.authority.yaml",
      range: { start: { line: 3, column: 9 }, end: { line: 3, column: 35 } },
      pointer: "/units/0/id",
      related: [{
        path: "after/nested/omega/rule.authority.yaml",
        range: { start: { line: 3, column: 9 }, end: { line: 3, column: 35 } },
        pointer: "/units/0/id",
        role: "duplicate declaration",
      }],
    },
    {
      code: "AUTH_ID_DUPLICATE",
      path: "before/nested/alpha/rule.authority.yaml",
      range: { start: { line: 3, column: 9 }, end: { line: 3, column: 35 } },
      pointer: "/units/0/id",
      related: [{
        path: "before/nested/omega/rule.authority.yaml",
        range: { start: { line: 3, column: 9 }, end: { line: 3, column: 35 } },
        pointer: "/units/0/id",
        role: "duplicate declaration",
      }],
    },
  ]);
  assert(report.diagnostics.every((entry) => !path.isAbsolute(entry.path)
    && entry.related.every((related) => !path.isAbsolute(related.path))));
});

test("diff and impact enforce exact compact UTF-8 semantic payload byte budgets", async () => {
  const state = await comparison();
  await replace(path.join(state.after, "checkout-session.authority.yaml"), "condition: Always.", "condition: For 😀界 checkout.");

  const diff = await diffAuthorityPaths(state.before, state.after);
  const diffJson = JSON.stringify(diff.diff);
  const diffBytes = Buffer.byteLength(diffJson, "utf8");
  assert.notEqual(diffBytes, diffJson.length);
  assert.equal(diff.payloadBytes, diffBytes);
  assert.equal((await diffAuthorityPaths(state.before, state.after, { maxBytes: diffBytes })).ok, true);
  const diffOverflow = await diffAuthorityPaths(state.before, state.after, { maxBytes: diffBytes - 1 });
  assert.equal(diffOverflow.ok, false);
  assert.equal(diffOverflow.diff, null);
  assert.equal(diffOverflow.diagnostics[0].code, "AUTH_DIFF_BUDGET");

  const dispositions = path.join(fixtures, "impact-dispositions.yaml");
  const impact = await impactAuthorityPaths(state.before, state.after, dispositions);
  const impactJson = JSON.stringify({ diff: impact.diff, impact: impact.impact });
  const impactBytes = Buffer.byteLength(impactJson, "utf8");
  assert.notEqual(impactBytes, impactJson.length);
  assert.equal(impact.payloadBytes, impactBytes);
  assert.equal((await impactAuthorityPaths(state.before, state.after, dispositions, { maxBytes: impactBytes })).ok, true);
  const impactOverflow = await impactAuthorityPaths(state.before, state.after, dispositions, { maxBytes: impactBytes - 1 });
  assert.equal(impactOverflow.ok, false);
  assert.equal(impactOverflow.diff, null);
  assert.equal(impactOverflow.impact, null);
  assert.equal(impactOverflow.diagnostics[0].code, "AUTH_IMPACT_BUDGET");
});

test("public diff/impact CLI enforces disposition input and deterministic failure", async () => {
  const state = await comparison();
  await replace(path.join(state.after, "checkout-session.authority.yaml"), "condition: Always.", "condition: For authenticated checkout.");
  assert.equal((await runCli(state.root, ["authority", "diff", state.before, state.after, "--json"])).code, 2);
  const diff = await runCli(state.root, ["authority", "diff", state.before, state.after, "--max-bytes", "65536", "--json"]);
  assert.equal(diff.code, 0);
  assert.equal(JSON.parse(diff.stdout).diff.summary.changes, 1);
  const diffOverflow = await runCli(state.root, ["authority", "diff", state.before, state.after, "--max-bytes", "1", "--json"]);
  assert.equal(diffOverflow.code, 1);
  assert.equal(JSON.parse(diffOverflow.stdout).diff, null);

  assert.equal((await runCli(state.root, ["authority", "impact", state.before, state.after, "--max-bytes", "65536", "--json"])).code, 2);
  const impact = await runCli(state.root, ["authority", "impact", state.before, state.after, "--dispositions", path.join(fixtures, "impact-dispositions.yaml"), "--max-bytes", "65536", "--json"]);
  assert.equal(impact.code, 0, impact.stderr || impact.stdout);
  assert.equal(JSON.parse(impact.stdout).impact.complete, true);
  const impactOverflow = await runCli(state.root, ["authority", "impact", state.before, state.after, "--dispositions", path.join(fixtures, "impact-dispositions.yaml"), "--max-bytes", "1", "--json"]);
  assert.equal(impactOverflow.code, 1);
  assert.equal(JSON.parse(impactOverflow.stdout).diff, null);
  assert.equal(JSON.parse(impactOverflow.stdout).impact, null);
});
