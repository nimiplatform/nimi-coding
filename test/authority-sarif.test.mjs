import assert from "node:assert/strict";
import test from "node:test";

import { authorityAuditResultToSarif } from "../cli/lib/authority/sarif.mjs";

const toolVersion = "0.3.1-test";

function location(file, line, column, sourcePointer) {
  return {
    file,
    range: {
      start: { line, column },
      end: { line, column: column + 3 },
    },
    sourcePointer,
  };
}

function item(overrides) {
  return {
    code: "AUTH_AUDIT_REFERENCE_COUNT",
    fingerprint: "sha256:reference-count",
    detector: "authority.definition-incoming-active-applies-to-count/v1",
    binding: "nimi-realm.reference-coverage/v1",
    premise: "rule.realm.reference-coverage",
    basis: "governance_bound",
    message: "definition.realm.target has no incoming active applies_to reference",
    policy: "blocking",
    authorityRefs: ["definition.realm.target", "rule.realm.reference-coverage"],
    primaryLocation: location("realm/spec folder/target-多.authority.yaml", 4, 7, "/units/0/id"),
    relatedLocations: [
      {
        role: "premise",
        location: location("realm/policy#rules.authority.yaml", 8, 5, "/units/1/id"),
      },
    ],
    witness: {
      type: "incoming_relation_count",
      observed: 0,
      minimum: 1,
      refs: [],
    },
    ...overrides,
  };
}

test("audit observations, findings, and gaps map without item deduplication and keep deterministic unique rules", () => {
  const observation = item({
    code: "AUTH_AUDIT_REFERENCE_OBSERVATION",
    fingerprint: "sha256:observation",
    message: "definition.realm.target has one incoming active applies_to reference",
    policy: "advisory",
    witness: {
      type: "incoming_relation_count",
      observed: 1,
      minimum: 1,
      refs: ["rule.realm.consumer"],
    },
  });
  const blocking = item({ target: "definition.realm.target" });
  const advisory = item({
    target: "definition.realm.target",
    fingerprint: "sha256:reference-count-advisory",
    policy: "advisory",
  });
  const gap = item({
    code: "AUTH_AUDIT_BINDING_MISSING",
    fingerprint: "sha256:binding-missing",
    detector: null,
    premise: null,
    basis: "required_coverage",
    message: "required audit binding is missing",
    policy: "required",
    authorityRefs: [],
    relatedLocations: [],
    witness: { type: "required_binding", present: false },
  });
  const report = {
    ok: true,
    audit: {
      format: "nimicoding.authority-audit/v1",
      operationStatus: "completed",
      policyStatus: "blocked",
      complete: true,
      observations: [observation, observation],
      findings: [blocking, advisory],
      gaps: [gap],
      counts: {
        bindings: { required: 1, configured: 1, evaluated: 1 },
        returned: { observations: 2, findings: 2, gaps: 1 },
        traversal: { units: 3, edges: 2 },
      },
      budgets: { maxUnits: 8, maxEdges: 16, maxBytes: 65536 },
    },
    diagnostics: [],
  };

  const sarif = authorityAuditResultToSarif(report, { toolVersion });
  assert.equal(sarif.version, "2.1.0");
  assert.equal(
    sarif.$schema,
    "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  );
  assert.equal(sarif.runs[0].tool.driver.name, "@nimiplatform/nimi-coding");
  assert.equal(sarif.runs[0].tool.driver.version, toolVersion);
  assert.equal(sarif.runs[0].columnKind, "unicodeCodePoints");
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);
  assert.deepEqual(sarif.runs[0].invocations[0].properties, {
    format: "nimicoding.authority-audit/v1",
    operationStatus: "completed",
    policyStatus: "blocked",
    complete: true,
    counts: {
      bindings: { required: 1, configured: 1, evaluated: 1 },
      returned: { observations: 2, findings: 2, gaps: 1 },
      traversal: { units: 3, edges: 2 },
    },
    budgets: { maxUnits: 8, maxEdges: 16, maxBytes: 65536 },
  });
  assert.equal(sarif.runs[0].results.length, 5);
  assert.deepEqual(
    sarif.runs[0].results.map((result) => result.level),
    ["note", "note", "error", "warning", "error"],
  );
  assert.deepEqual(
    sarif.runs[0].results.map((result) => result.properties.kind),
    ["observation", "observation", "finding", "finding", "gap"],
  );
  assert.deepEqual(
    sarif.runs[0].tool.driver.rules.map((rule) => rule.id),
    [
      "AUTH_AUDIT_BINDING_MISSING",
      "AUTH_AUDIT_REFERENCE_COUNT",
      "AUTH_AUDIT_REFERENCE_OBSERVATION",
    ],
  );
  assert.deepEqual(
    sarif.runs[0].results.map((result) => result.ruleIndex),
    [2, 2, 1, 1, 0],
  );

  const finding = sarif.runs[0].results[2];
  assert.equal(
    finding.partialFingerprints["nimicoding.semanticFingerprint/v1"],
    blocking.fingerprint,
  );
  assert.deepEqual(finding.properties, {
    kind: "finding",
    code: blocking.code,
    fingerprint: blocking.fingerprint,
    detector: blocking.detector,
    binding: blocking.binding,
    premise: blocking.premise,
    basis: blocking.basis,
    policy: blocking.policy,
    authorityRefs: blocking.authorityRefs,
    witness: blocking.witness,
    target: blocking.target,
  });
  assert.equal(
    finding.locations[0].physicalLocation.artifactLocation.uri,
    "realm/spec%20folder/target-%E5%A4%9A.authority.yaml",
  );
  assert.equal(finding.locations[0].physicalLocation.properties.sourcePointer, "/units/0/id");
  assert.equal(
    finding.relatedLocations[0].physicalLocation.artifactLocation.uri,
    "realm/policy%23rules.authority.yaml",
  );
  assert.equal(finding.relatedLocations[0].message.text, "premise");
  assert.equal(finding.relatedLocations[0].properties.role, "premise");
  assert.equal(sarif.runs[0].results[4].properties.detector, null);
  assert.equal(sarif.runs[0].results[4].properties.premise, null);
});

test("audit-null compiler or binding diagnostics become error results and mark invocation unsuccessful", () => {
  const report = {
    ok: false,
    audit: null,
    diagnostics: [
      {
        code: "AUTH_RELATION_DANGLING",
        severity: "error",
        path: "broken folder/多#one.authority.yaml",
        range: {
          start: { line: 12, column: 9 },
          end: { line: 12, column: 32 },
        },
        pointer: "/units/0/relations/0/target",
        reason: "relation target does not resolve",
        repair: "repair the exact relation target",
        related: [
          {
            path: "policy/binding.yaml",
            range: {
              start: { line: 3, column: 5 },
              end: { line: 3, column: 18 },
            },
            pointer: "/bindings/0",
            role: "binding",
          },
        ],
      },
    ],
  };

  const sarif = authorityAuditResultToSarif(report, { toolVersion });
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
  assert.deepEqual(sarif.runs[0].invocations[0].properties, {
    operationStatus: "refused",
    policyStatus: "indeterminate",
    complete: false,
  });
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].level, "error");
  assert.equal(sarif.runs[0].results[0].properties.kind, "diagnostic");
  assert.equal(sarif.runs[0].results[0].message.text, "relation target does not resolve");
  assert.equal(
    sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "broken%20folder/%E5%A4%9A%23one.authority.yaml",
  );
  assert.equal(sarif.runs[0].results[0].relatedLocations[0].properties.role, "binding");
  assert.deepEqual(sarif.runs[0].tool.driver.rules, [
    {
      id: "AUTH_RELATION_DANGLING",
      shortDescription: { text: "AUTH_RELATION_DANGLING" },
    },
  ]);
});

test("fingerprints survive source moves while encoded URIs update and identical inputs serialize byte-stably", () => {
  const beforeItem = item({
    primaryLocation: location("before folder/target-多.authority.yaml", 4, 7, "/units/0/id"),
  });
  const afterItem = item({
    primaryLocation: location("after folder/regrouped-多.authority.yaml", 19, 3, "/units/7/id"),
  });
  const beforeReport = {
    ok: true,
    audit: {
      operationStatus: "completed",
      policyStatus: "blocked",
      complete: true,
      observations: [],
      findings: [beforeItem],
      gaps: [],
    },
    diagnostics: [],
  };
  const afterReport = {
    ok: true,
    audit: {
      operationStatus: "completed",
      policyStatus: "blocked",
      complete: true,
      observations: [],
      findings: [afterItem],
      gaps: [],
    },
    diagnostics: [],
  };

  const first = authorityAuditResultToSarif(beforeReport, { toolVersion });
  const repeated = authorityAuditResultToSarif(beforeReport, { toolVersion });
  const moved = authorityAuditResultToSarif(afterReport, { toolVersion });
  assert.equal(JSON.stringify(first), JSON.stringify(repeated));
  assert.equal(
    first.runs[0].results[0].partialFingerprints["nimicoding.semanticFingerprint/v1"],
    moved.runs[0].results[0].partialFingerprints["nimicoding.semanticFingerprint/v1"],
  );
  assert.equal(
    first.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "before%20folder/target-%E5%A4%9A.authority.yaml",
  );
  assert.equal(
    moved.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "after%20folder/regrouped-%E5%A4%9A.authority.yaml",
  );
  assert.notEqual(
    first.runs[0].results[0].locations[0].physicalLocation.region.startLine,
    moved.runs[0].results[0].locations[0].physicalLocation.region.startLine,
  );
});
