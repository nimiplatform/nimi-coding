import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { auditAuthorityPath, canonicalAuditBytes } from "../cli/lib/authority/audit.mjs";
import { compileAuthorityPath } from "../cli/lib/authority/compile.mjs";
import { stringifyCanonicalYaml } from "../cli/lib/authority/source-yaml.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(packageRoot, "test", "fixtures", "authority", "audit");
const temporaryRoots = [];
const generousBudgets = { maxUnits: 100, maxEdges: 100, maxBytes: 1_000_000 };
const commonItemFields = [
  "authorityRefs",
  "basis",
  "binding",
  "code",
  "detector",
  "fingerprint",
  "message",
  "policy",
  "premise",
  "primaryLocation",
  "relatedLocations",
  "witness",
];

async function fixtureState(bindingName = "bindings.valid.yaml") {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-audit-"));
  temporaryRoots.push(root);
  const corpus = path.join(root, "corpus");
  const bindings = path.join(root, "bindings.yaml");
  await cp(path.join(fixtureRoot, "corpus"), corpus, { recursive: true });
  await cp(path.join(fixtureRoot, bindingName), bindings);
  return { root, corpus, bindings, source: path.join(corpus, "audit.authority.yaml") };
}

async function bindingDocument(state) {
  return YAML.parse(await readFile(state.bindings, "utf8"));
}

async function writeBinding(state, document) {
  await writeFile(state.bindings, YAML.stringify(document, { indent: 2, lineWidth: 0 }), "utf8");
}

async function removeIndependentAlphaReference(state) {
  const document = YAML.parse(await readFile(state.source, "utf8"));
  const support = document.units.find((unit) => unit.id === "rule.audit.support-alpha");
  support.relations = support.relations.filter((relation) => relation.target !== "definition.audit.alpha");
  await writeFile(state.source, stringifyCanonicalYaml(document, { container: true }), "utf8");
}

function assertLocation(location) {
  assert.deepEqual(Object.keys(location).sort(), ["file", "range", "sourcePointer"].sort());
  assert.equal(typeof location.file, "string");
  assert.equal(typeof location.sourcePointer, "string");
  assert(Number.isSafeInteger(location.range.start.line));
  assert(Number.isSafeInteger(location.range.start.column));
}

function assertCommonItem(item, extraFields = []) {
  assert.deepEqual(Object.keys(item).sort(), [...commonItemFields, ...extraFields].sort());
  assert.match(item.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assertLocation(item.primaryLocation);
  for (const related of item.relatedLocations) {
    assert.deepEqual(Object.keys(related).sort(), ["location", "role"]);
    assert.equal(typeof related.role, "string");
    assertLocation(related.location);
  }
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("baseline audit is complete, deterministic, byte-accounted, and carries authored relation witnesses", async () => {
  const state = await fixtureState();
  const first = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  const repeated = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.deepEqual(repeated, first);
  assert.deepEqual(Object.keys(first).sort(), ["audit", "auditBytes", "diagnostics", "fileCount", "ok", "partial", "unitCount"].sort());
  assert.equal(Object.hasOwn(first, "operationStatus"), false);
  assert.equal(first.fileCount, 1);
  assert.equal(first.unitCount, 7);
  assert.equal(first.partial, false);
  assert.equal(first.auditBytes, canonicalAuditBytes(first.audit));
  assert.equal(first.auditBytes, Buffer.byteLength(JSON.stringify(first.audit), "utf8"));
  assert.deepEqual(Object.keys(first.audit).sort(), [
    "budgets", "complete", "counts", "findings", "format", "gaps", "observations", "operationStatus", "policyStatus",
  ].sort());
  assert.equal(first.audit.format, "nimicoding.authority-audit/v1");
  assert.equal(first.audit.operationStatus, "completed");
  assert.equal(first.audit.policyStatus, "passed");
  assert.equal(first.audit.complete, true);
  assert.deepEqual(first.audit.findings, []);
  assert.deepEqual(first.audit.gaps, []);
  assert.deepEqual(first.audit.counts, {
    bindings: { required: 1, configured: 1, evaluated: 1 },
    returned: { observations: 1, findings: 0, gaps: 0 },
    traversal: { units: 5, edges: 4 },
  });
  assert.deepEqual(first.audit.budgets, generousBudgets);

  const observation = first.audit.observations[0];
  assertCommonItem(observation);
  assert.equal(observation.binding, "audit.registry-coverage");
  assert.equal(observation.detector, "minimum-independent-incoming-reference/v1");
  assert.equal(observation.premise, "rule.audit.registry");
  assert.equal(observation.basis, "governance_bound");
  assert.equal(observation.policy, "blocking");
  assert.deepEqual(observation.witness.targets, [
    { id: "definition.audit.alpha", attached: true, observed: 1, incomingRefs: ["rule.audit.support-alpha"] },
    { id: "definition.audit.beta", attached: true, observed: 1, incomingRefs: ["rule.audit.support-beta"] },
  ]);
  const roles = observation.relatedLocations.map((entry) => entry.role);
  assert.equal(roles.filter((role) => role === "premise-attachment").length, 2);
  assert.equal(roles.filter((role) => role === "incoming-reference").length, 2);
  assert.equal(roles.filter((role) => role === "binding-target").length, 2);
  for (const entry of observation.relatedLocations.filter(({ role }) => role === "premise-attachment" || role === "incoming-reference")) {
    assert.match(entry.location.sourcePointer, /^\/units\/\d+\/relations\/\d+\/target$/);
  }
});

test("a real independent-reference mutation blocks only blocking policy and fingerprints ignore policy", async () => {
  const state = await fixtureState();
  await removeIndependentAlphaReference(state);
  const compiled = await compileAuthorityPath(state.corpus);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));

  const blocked = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(blocked.ok, true, JSON.stringify(blocked.diagnostics));
  assert.equal(blocked.audit.operationStatus, "completed");
  assert.equal(blocked.audit.policyStatus, "blocked");
  assert.equal(blocked.audit.complete, true);
  assert.equal(blocked.audit.observations.length, 1);
  assert.equal(blocked.audit.findings.length, 1);
  const finding = blocked.audit.findings[0];
  assertCommonItem(finding, ["target"]);
  assert.equal(finding.code, "AUTH_AUDIT_MINIMUM_INDEPENDENT_INCOMING_REFERENCE");
  assert.equal(finding.target, "definition.audit.alpha");
  assert.equal(finding.policy, "blocking");
  assert.deepEqual(finding.witness, {
    type: "minimum-independent-incoming-reference",
    relation: "applies_to",
    minimum: 1,
    observed: 0,
    incomingRefs: [],
  });
  assert.match(finding.primaryLocation.file, /audit\.authority\.yaml$/);
  assert.deepEqual(new Set(finding.relatedLocations.map((entry) => entry.role)), new Set([
    "binding", "binding-target", "premise", "premise-attachment",
  ]));

  const document = await bindingDocument(state);
  document.bindings[0].policy = "advisory";
  await writeBinding(state, document);
  const advisory = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(advisory.ok, true, JSON.stringify(advisory.diagnostics));
  assert.equal(advisory.audit.policyStatus, "passed");
  assert.equal(advisory.audit.findings[0].policy, "advisory");
  assert.equal(advisory.audit.findings[0].fingerprint, finding.fingerprint);
  assert.equal(advisory.audit.observations[0].fingerprint, blocked.audit.observations[0].fingerprint);
});

test("missing premise attachment is distinct from independent-reference support", async () => {
  const state = await fixtureState();
  const document = await bindingDocument(state);
  document.bindings[0].targets = ["definition.audit.unattached"];
  await writeBinding(state, document);

  const result = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.audit.policyStatus, "blocked");
  assert.equal(result.audit.complete, true);
  assert.deepEqual(result.audit.findings.map((finding) => finding.code), ["AUTH_AUDIT_PREMISE_TARGET_UNATTACHED"]);
  const finding = result.audit.findings[0];
  assertCommonItem(finding, ["target"]);
  assert.equal(finding.target, "definition.audit.unattached");
  assert.deepEqual(finding.witness, {
    type: "premise-direct-attachment",
    relation: "applies_to",
    attached: false,
  });
  assert.deepEqual(result.audit.observations[0].witness.targets, [{
    id: "definition.audit.unattached",
    attached: false,
    observed: 2,
    incomingRefs: ["rule.audit.support-alpha", "rule.audit.support-unattached"],
  }]);
  assert.equal(result.audit.observations[0].relatedLocations.filter(({ role }) => role === "premise-attachment").length, 0);
  assert.equal(result.audit.observations[0].relatedLocations.filter(({ role }) => role === "incoming-reference").length, 2);
});

test("a missing required binding completes as an explicit required-coverage gap", async () => {
  const state = await fixtureState("bindings.gap.yaml");
  const result = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.unitCount, 7);
  assert.equal(result.audit.operationStatus, "completed");
  assert.equal(result.audit.policyStatus, "indeterminate");
  assert.equal(result.audit.complete, false);
  assert.deepEqual(result.audit.observations, []);
  assert.deepEqual(result.audit.findings, []);
  assert.deepEqual(result.audit.counts, {
    bindings: { required: 1, configured: 0, evaluated: 0 },
    returned: { observations: 0, findings: 0, gaps: 1 },
    traversal: { units: 0, edges: 0 },
  });
  const gap = result.audit.gaps[0];
  assertCommonItem(gap);
  assert.equal(gap.code, "AUTH_AUDIT_REQUIRED_BINDING_MISSING");
  assert.equal(gap.binding, "audit.registry-coverage");
  assert.equal(gap.detector, null);
  assert.equal(gap.premise, null);
  assert.equal(gap.basis, "required_coverage");
  assert.equal(gap.policy, "required");
  assert.deepEqual(gap.authorityRefs, []);
  assert.deepEqual(gap.relatedLocations, []);
});

test("closed binding documents and authority references fail closed with null audits", async () => {
  const state = await fixtureState();
  const original = await bindingDocument(state);
  const invalidDocuments = [
    { name: "empty required coverage", mutate: (value) => { value.required_bindings = []; } },
    { name: "wrong format", mutate: (value) => { value.format = "nimicoding.authority-verifier-bindings/v2"; } },
    { name: "extra top field", mutate: (value) => { value.extra = true; } },
    { name: "duplicate required binding", mutate: (value) => { value.required_bindings.push(value.required_bindings[0]); } },
    { name: "extra binding field", mutate: (value) => { value.bindings[0].extra = true; } },
    { name: "unknown detector", mutate: (value) => { value.bindings[0].detector = "unknown/v1"; } },
    { name: "duplicate target", mutate: (value) => { value.bindings[0].targets.push(value.bindings[0].targets[0]); } },
    { name: "zero minimum", mutate: (value) => { value.bindings[0].minimum = 0; } },
    { name: "unknown policy", mutate: (value) => { value.bindings[0].policy = "warning"; } },
    { name: "unknown premise", mutate: (value) => { value.bindings[0].premise = "rule.audit.missing"; } },
    { name: "definition premise", mutate: (value) => { value.bindings[0].premise = "definition.audit.alpha"; } },
    { name: "unknown target", mutate: (value) => { value.bindings[0].targets = ["definition.audit.missing"]; } },
    { name: "rule target", mutate: (value) => { value.bindings[0].targets = ["rule.audit.registry"]; } },
  ];
  for (const { name, mutate } of invalidDocuments) {
    const document = structuredClone(original);
    mutate(document);
    await writeBinding(state, document);
    const result = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
    assert.equal(result.ok, false, name);
    assert.equal(result.audit, null, name);
    assert.equal(result.partial, false, name);
    assert.equal(result.diagnostics[0].code, "AUTH_AUDIT_BINDING_INVALID", name);
  }

  await writeFile(state.bindings, [
    "format: nimicoding.authority-verifier-bindings/v1",
    "format: nimicoding.authority-verifier-bindings/v1",
    "required_bindings: [audit.registry-coverage]",
    "bindings: []",
    "",
  ].join("\n"), "utf8");
  const duplicateKey = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(duplicateKey.ok, false);
  assert.equal(duplicateKey.audit, null);
  assert.equal(duplicateKey.partial, false);
  assert.equal(duplicateKey.diagnostics[0].code, "AUTH_AUDIT_BINDING_INVALID");

  await writeFile(state.bindings, Buffer.from([0x66, 0x6f, 0x80, 0x0a]));
  const invalidUtf8 = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(invalidUtf8.ok, false);
  assert.equal(invalidUtf8.audit, null);
  assert.match(invalidUtf8.diagnostics[0].reason, /not valid UTF-8/);

  await rm(state.bindings);
  await symlink(path.join(fixtureRoot, "bindings.valid.yaml"), state.bindings);
  const symlinked = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(symlinked.ok, false);
  assert.equal(symlinked.audit, null);
  assert.match(symlinked.diagnostics[0].reason, /non-symlink/);
  await rm(state.bindings);

  await writeBinding(state, original);
  const source = await readFile(state.source, "utf8");
  await writeFile(state.source, source.replace("    title: Audit alpha\n", "    title: Audit alpha\n    unknown: forbidden\n"), "utf8");
  const invalidCorpus = await auditAuthorityPath(state.corpus, state.bindings, generousBudgets);
  assert.equal(invalidCorpus.ok, false);
  assert.equal(invalidCorpus.audit, null);
  assert.equal(invalidCorpus.partial, false);
  assert(invalidCorpus.diagnostics.some((diagnostic) => diagnostic.code === "AUTH_UNKNOWN_FIELD"));
});

test("unit, edge, and UTF-8 byte budgets admit exact N and refuse N-1 without partial output", async () => {
  const state = await fixtureState();
  const exactTraversal = await auditAuthorityPath(state.corpus, state.bindings, {
    maxUnits: 5,
    maxEdges: 4,
    maxBytes: 1_000_000,
  });
  assert.equal(exactTraversal.ok, true, JSON.stringify(exactTraversal.diagnostics));
  assert.deepEqual(exactTraversal.audit.counts.traversal, { units: 5, edges: 4 });

  for (const limits of [
    { maxUnits: 4, maxEdges: 4, maxBytes: 1_000_000 },
    { maxUnits: 5, maxEdges: 3, maxBytes: 1_000_000 },
  ]) {
    const refused = await auditAuthorityPath(state.corpus, state.bindings, limits);
    assert.equal(refused.ok, false);
    assert.equal(refused.audit, null);
    assert.equal(refused.auditBytes, 0);
    assert.equal(refused.partial, false);
    assert.equal(refused.diagnostics[0].code, "AUTH_AUDIT_BUDGET");
  }

  let exactBytes = exactTraversal.auditBytes;
  let exact;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    exact = await auditAuthorityPath(state.corpus, state.bindings, { maxUnits: 5, maxEdges: 4, maxBytes: exactBytes });
    assert.equal(exact.ok, true, JSON.stringify(exact.diagnostics));
    if (exact.auditBytes === exactBytes) break;
    exactBytes = exact.auditBytes;
  }
  assert.equal(exact.auditBytes, exactBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(exact.audit), "utf8"), exactBytes);
  const oneByteUnder = await auditAuthorityPath(state.corpus, state.bindings, { maxUnits: 5, maxEdges: 4, maxBytes: exactBytes - 1 });
  assert.equal(oneByteUnder.ok, false);
  assert.equal(oneByteUnder.audit, null);
  assert.equal(oneByteUnder.auditBytes, 0);
  assert.equal(oneByteUnder.partial, false);
  assert.equal(oneByteUnder.diagnostics[0].code, "AUTH_AUDIT_BUDGET");

  const invalidBudget = await auditAuthorityPath(state.corpus, state.bindings, { maxUnits: 0, maxEdges: 4, maxBytes: exactBytes });
  assert.equal(invalidBudget.ok, false);
  assert.equal(invalidBudget.audit, null);
  assert.equal(invalidBudget.partial, false);
  assert.equal(invalidBudget.diagnostics[0].code, "AUTH_AUDIT_BUDGET");
});

test("fingerprints survive source movement, regrouping, unit order, target order, and location changes", async () => {
  const firstState = await fixtureState();
  const movedState = await fixtureState();
  await removeIndependentAlphaReference(firstState);
  await removeIndependentAlphaReference(movedState);

  const first = await auditAuthorityPath(firstState.corpus, firstState.bindings, generousBudgets);
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(first.audit.findings.length, 1);

  const movedDocument = YAML.parse(await readFile(movedState.source, "utf8"));
  const alpha = movedDocument.units.find((unit) => unit.id === "definition.audit.alpha");
  const rest = movedDocument.units.filter((unit) => unit.id !== alpha.id).reverse();
  await rm(movedState.source);
  await writeFile(
    path.join(movedState.corpus, "moved-target.authority.yaml"),
    stringifyCanonicalYaml({ format: movedDocument.format, units: [alpha] }, { container: true }),
    "utf8",
  );
  await writeFile(
    path.join(movedState.corpus, "regrouped.authority.yaml"),
    stringifyCanonicalYaml({ format: movedDocument.format, units: rest }, { container: true }),
    "utf8",
  );
  const movedBinding = await bindingDocument(movedState);
  movedBinding.bindings[0].targets.reverse();
  await writeBinding(movedState, movedBinding);

  const moved = await auditAuthorityPath(movedState.corpus, movedState.bindings, generousBudgets);
  assert.equal(moved.ok, true, JSON.stringify(moved.diagnostics));
  assert.equal(moved.fileCount, 2);
  assert.equal(moved.unitCount, 7);
  assert.equal(moved.audit.findings.length, 1);
  assert.equal(moved.audit.findings[0].fingerprint, first.audit.findings[0].fingerprint);
  assert.equal(moved.audit.observations[0].fingerprint, first.audit.observations[0].fingerprint);
  assert.notEqual(moved.audit.findings[0].primaryLocation.file, first.audit.findings[0].primaryLocation.file);
  assert.match(moved.audit.findings[0].primaryLocation.file, /moved-target\.authority\.yaml$/);
  assert.deepEqual(moved.audit.findings[0].witness, first.audit.findings[0].witness);
});
