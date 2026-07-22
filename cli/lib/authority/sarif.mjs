const SARIF_SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
const SARIF_VERSION = "2.1.0";
const TOOL_NAME = "@nimiplatform/nimi-coding";
const FINGERPRINT_KEY = "nimicoding.semanticFingerprint/v1";

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function portableUri(file) {
  return String(file)
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function physicalLocation(location) {
  const file = location?.file ?? location?.path;
  if (typeof file !== "string" || !location?.range) return null;
  const value = {
    artifactLocation: { uri: portableUri(file) },
    region: {
      startLine: location.range.start.line,
      startColumn: location.range.start.column,
      endLine: location.range.end.line,
      endColumn: location.range.end.column,
    },
  };
  const sourcePointer = location.sourcePointer ?? location.pointer;
  if (typeof sourcePointer === "string") value.properties = { sourcePointer };
  return value;
}

function primaryLocation(location) {
  const physical = physicalLocation(location);
  return physical ? [{ physicalLocation: physical }] : [];
}

function relatedLocations(values = []) {
  return values.flatMap((entry, index) => {
    const physical = physicalLocation(entry.location ?? entry);
    if (!physical) return [];
    const role = entry.role ?? entry.location?.role;
    const related = {
      id: index + 1,
      physicalLocation: physical,
    };
    if (typeof role === "string") {
      related.message = { text: role };
      related.properties = { role };
    }
    return [related];
  });
}

function itemLevel(kind, item) {
  if (kind === "observation") return "note";
  if (kind === "gap") return "error";
  return item.policy === "blocking" ? "error" : "warning";
}

function auditItemResult(kind, item) {
  const result = {
    ruleId: item.code,
    level: itemLevel(kind, item),
    message: { text: item.message },
    locations: primaryLocation(item.primaryLocation),
    relatedLocations: relatedLocations(item.relatedLocations),
    partialFingerprints: { [FINGERPRINT_KEY]: item.fingerprint },
    properties: {
      kind,
      code: item.code,
      fingerprint: item.fingerprint,
      detector: item.detector,
      binding: item.binding,
      premise: item.premise,
      basis: item.basis,
      policy: item.policy,
      authorityRefs: copy(item.authorityRefs),
      witness: copy(item.witness),
    },
  };
  if (typeof item.target === "string") result.properties.target = item.target;
  if (result.locations.length === 0) delete result.locations;
  if (result.relatedLocations.length === 0) delete result.relatedLocations;
  return result;
}

function diagnosticResult(diagnostic) {
  const result = {
    ruleId: diagnostic.code,
    level: "error",
    message: { text: diagnostic.reason },
    locations: primaryLocation({
      path: diagnostic.path,
      range: diagnostic.range,
      pointer: diagnostic.pointer,
    }),
    relatedLocations: relatedLocations(diagnostic.related),
    properties: {
      kind: "diagnostic",
      code: diagnostic.code,
      severity: diagnostic.severity,
      pointer: diagnostic.pointer,
      repair: diagnostic.repair,
    },
  };
  if (result.locations.length === 0) delete result.locations;
  if (result.relatedLocations.length === 0) delete result.relatedLocations;
  return result;
}

function rulesFor(results) {
  const codes = [...new Set(results.map((result) => result.ruleId))].sort();
  return codes.map((code) => ({
    id: code,
    shortDescription: { text: code },
  }));
}

function invocationProperties(result) {
  if (!result.audit) {
    return {
      operationStatus: "refused",
      policyStatus: "indeterminate",
      complete: false,
    };
  }
  return {
    format: result.audit.format,
    operationStatus: result.audit.operationStatus,
    policyStatus: result.audit.policyStatus,
    complete: result.audit.complete,
    counts: copy(result.audit.counts),
    budgets: copy(result.audit.budgets),
  };
}

export function authorityAuditResultToSarif(result, { toolVersion }) {
  if (!result || typeof result !== "object")
    throw new TypeError("authority audit result must be an object");
  if (typeof toolVersion !== "string" || toolVersion.length === 0)
    throw new TypeError("toolVersion must be a non-empty string");

  const results = result.audit
    ? [
        ...(result.audit.observations ?? []).map((item) => auditItemResult("observation", item)),
        ...(result.audit.findings ?? []).map((item) => auditItemResult("finding", item)),
        ...(result.audit.gaps ?? []).map((item) => auditItemResult("gap", item)),
      ]
    : (result.diagnostics ?? []).map(diagnosticResult);
  const rules = rulesFor(results);
  const ruleIndexes = new Map(rules.map((rule, index) => [rule.id, index]));
  for (const entry of results) entry.ruleIndex = ruleIndexes.get(entry.ruleId);

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: toolVersion,
            rules,
          },
        },
        columnKind: "unicodeCodePoints",
        invocations: [
          {
            executionSuccessful: result.ok === true,
            properties: invocationProperties(result),
          },
        ],
        results,
      },
    ],
  };
}
