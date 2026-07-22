import { Buffer } from "node:buffer";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { compareText, makeDiagnostic, portablePath, sortDiagnostics } from "./diagnostics.mjs";
import { diffAuthorityPaths } from "./diff.mjs";

const contractUrl = new URL("../../../contracts/authority-impact-dispositions.schema.yaml", import.meta.url);
const IMPACT_FORMAT = "nimicoding.authority-impact/v1";
const IMPACT_RELATIONS = new Set(["applies_to", "supersedes"]);

async function rootFor(inputPath) {
  const absolute = path.resolve(inputPath);
  const info = await stat(absolute);
  return info.isDirectory() ? absolute : path.dirname(absolute);
}

function impactBudgetDiagnostic(requiredBytes, maxBytes) {
  return makeDiagnostic({
    code: "AUTH_IMPACT_BUDGET",
    file: ".",
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason: `complete semantic impact payload requires ${requiredBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    repair: "increase the explicit byte budget; partial diff or impact output is forbidden",
  });
}

export function canonicalImpactBytes(diff, impact) {
  return Buffer.byteLength(JSON.stringify({ diff, impact }), "utf8");
}

function overBudget(diffResult, impact, maxBytes) {
  const payloadBytes = canonicalImpactBytes(diffResult.diff, impact);
  if (maxBytes === null || payloadBytes <= maxBytes) return { payloadBytes, failure: null };
  return {
    payloadBytes,
    failure: {
      ok: false,
      diagnostics: [impactBudgetDiagnostic(payloadBytes, maxBytes)],
      fileCount: diffResult.fileCount,
      unitCount: 0,
      payloadBytes,
      diff: null,
      impact: null,
    },
  };
}

function invalidDisposition(file, reason) {
  return makeDiagnostic({
    code: "AUTH_IMPACT_DISPOSITION_INVALID",
    file: path.basename(file),
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason,
    repair: "declare each exact impacted rule consumer and test disposition with addressed status and explicit evidence",
  });
}

function exactObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key));
}

async function loadDispositions(file, label = file) {
  const absolute = path.resolve(file);
  let bytes;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, diagnostics: [invalidDisposition(label, "dispositions must be one regular non-symlink YAML file")] };
    }
    bytes = await readFile(absolute);
  } catch (error) {
    return { ok: false, diagnostics: [invalidDisposition(label, `disposition file is not readable: ${error.message}`)] };
  }
  const contractText = await readFile(contractUrl, "utf8");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, diagnostics: [invalidDisposition(label, "disposition bytes are not valid UTF-8")] };
  }
  const document = YAML.parseDocument(text, { uniqueKeys: true, version: "1.2" });
  if (document.errors.length > 0) return { ok: false, diagnostics: [invalidDisposition(label, document.errors[0].message)] };
  let data;
  try {
    data = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return { ok: false, diagnostics: [invalidDisposition(label, error.message)] };
  }
  const contract = YAML.parse(contractText);
  if (!exactObject(data, contract.fields.top) || data.format !== contract.format || !Array.isArray(data.rules)) {
    return { ok: false, diagnostics: [invalidDisposition(label, "dispositions require the exact format and rules list")] };
  }
  const entries = new Map();
  const ruleIds = new Set();
  const identifier = new RegExp(contract.identifier_pattern);
  for (const rule of data.rules) {
    if (!exactObject(rule, contract.fields.rule) || !identifier.test(rule.id) || !Array.isArray(rule.consumers) || !exactObject(rule.test, contract.fields.test)) {
      return { ok: false, diagnostics: [invalidDisposition(label, "each rule requires exact id, consumers, and test fields")] };
    }
    if (ruleIds.has(rule.id)) return { ok: false, diagnostics: [invalidDisposition(label, `duplicate rule disposition: ${rule.id}`)] };
    ruleIds.add(rule.id);
    for (const consumer of rule.consumers) {
      if (!exactObject(consumer, contract.fields.consumer) || !identifier.test(consumer.scope) || consumer.status !== contract.status || typeof consumer.evidence !== "string" || consumer.evidence.trim() !== consumer.evidence || consumer.evidence.length === 0) {
        return { ok: false, diagnostics: [invalidDisposition(label, `invalid consumer disposition for ${rule.id}`)] };
      }
      const key = `${rule.id}\0consumer\0${consumer.scope}`;
      if (entries.has(key)) return { ok: false, diagnostics: [invalidDisposition(label, `duplicate disposition for ${rule.id} consumer ${consumer.scope}`)] };
      entries.set(key, { ruleId: rule.id, type: "consumer", target: consumer.scope, status: consumer.status, evidence: consumer.evidence });
    }
    if (rule.test.status !== contract.status || typeof rule.test.evidence !== "string" || rule.test.evidence.trim() !== rule.test.evidence || rule.test.evidence.length === 0) {
      return { ok: false, diagnostics: [invalidDisposition(label, `invalid test disposition for ${rule.id}`)] };
    }
    const testKey = `${rule.id}\0test\0${rule.id}`;
    if (entries.has(testKey)) return { ok: false, diagnostics: [invalidDisposition(label, `duplicate rule disposition: ${rule.id}`)] };
    entries.set(testKey, { ruleId: rule.id, type: "test", target: rule.id, status: rule.test.status, evidence: rule.test.evidence });
  }
  return { ok: true, diagnostics: [], entries };
}

function allUnits(diffResult) {
  const units = new Map();
  for (const compiled of [diffResult.before, diffResult.after]) {
    for (const unit of compiled.ir.units) units.set(unit.id, unit);
  }
  return units;
}

function incomingGraph(diffResult) {
  const incoming = new Map();
  for (const compiled of [diffResult.before, diffResult.after]) {
    for (const unit of compiled.ir.units) {
      for (const relation of unit.relations) {
        if (!IMPACT_RELATIONS.has(relation.type)) continue;
        const sources = incoming.get(relation.target) ?? new Set();
        sources.add(unit.id);
        incoming.set(relation.target, sources);
      }
    }
  }
  return incoming;
}

function impactingChanges(diffResult) {
  return diffResult.diff.changes.filter((change) => !change.pointer.startsWith("/metadata/"));
}

function impactedIds(diffResult) {
  const incoming = incomingGraph(diffResult);
  const selected = new Set();
  const pending = [...new Set(impactingChanges(diffResult).map((change) => change.unitId))].sort(compareText);
  while (pending.length > 0) {
    const id = pending.shift();
    if (selected.has(id)) continue;
    selected.add(id);
    for (const dependent of [...(incoming.get(id) ?? [])].sort(compareText)) if (!selected.has(dependent)) pending.push(dependent);
  }
  return [...selected].sort(compareText);
}

function requiredObligations(diffResult, impacted) {
  const before = new Map(diffResult.before.ir.units.map((unit) => [unit.id, unit]));
  const after = new Map(diffResult.after.ir.units.map((unit) => [unit.id, unit]));
  const obligations = [];
  for (const id of impacted) {
    const candidates = [before.get(id), after.get(id)].filter(Boolean);
    if (!candidates.some((unit) => unit.kind === "rule" && unit.lifecycle === "active")) continue;
    const scopes = new Set(candidates.flatMap((unit) => unit.semantic?.scope ?? []));
    for (const scope of [...scopes].sort(compareText)) obligations.push({ ruleId: id, type: "consumer", target: scope });
    obligations.push({ ruleId: id, type: "test", target: id });
  }
  return obligations;
}

async function unitLocation(diffResult, id) {
  for (const [compiled, inputPath] of [[diffResult.after, diffResult.afterPath], [diffResult.before, diffResult.beforePath]]) {
    const index = compiled.ir.units.findIndex((unit) => unit.id === id);
    if (index < 0) continue;
    const mapped = compiled.sourceMap.fields[`/units/${index}/id`];
    return { ...mapped, file: portablePath(mapped.file, await rootFor(inputPath)) };
  }
  return { file: ".", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, sourcePointer: "/id" };
}

export async function impactAuthorityPaths(beforePath, afterPath, dispositionsPath, { maxBytes = null, dispositionLabel = null } = {}) {
  const diffResult = await diffAuthorityPaths(beforePath, afterPath);
  if (!diffResult.ok) return { ...diffResult, impact: null };
  diffResult.beforePath = beforePath;
  diffResult.afterPath = afterPath;
  const parsed = await loadDispositions(dispositionsPath, dispositionLabel ?? dispositionsPath);
  if (!parsed.ok) {
    const budget = overBudget(diffResult, null, maxBytes);
    if (budget.failure) return budget.failure;
    return {
      ok: false,
      diagnostics: parsed.diagnostics,
      fileCount: diffResult.fileCount,
      unitCount: 0,
      payloadBytes: budget.payloadBytes,
      diff: diffResult.diff,
      impact: null,
    };
  }
  const impacted = impactedIds(diffResult);
  const units = allUnits(diffResult);
  const required = requiredObligations(diffResult, impacted);
  const requiredKeys = new Set(required.map((item) => `${item.ruleId}\0${item.type}\0${item.target}`));
  const diagnostics = [];
  for (const obligation of required) {
    const key = `${obligation.ruleId}\0${obligation.type}\0${obligation.target}`;
    if (parsed.entries.has(key)) continue;
    const mapped = await unitLocation(diffResult, obligation.ruleId);
    diagnostics.push(makeDiagnostic({
      code: "AUTH_IMPACT_UNDISPOSED",
      file: mapped.file,
      range: mapped.range,
      pointer: mapped.sourcePointer,
      reason: `${obligation.type} obligation is not disposed for ${obligation.ruleId}: ${obligation.target}`,
      repair: "add an addressed disposition with explicit evidence; do not infer completion",
    }));
  }
  for (const [key, disposition] of parsed.entries) {
    if (requiredKeys.has(key)) continue;
    diagnostics.push(invalidDisposition(dispositionLabel ?? dispositionsPath, `disposition does not match a required impact obligation: ${disposition.ruleId} ${disposition.type} ${disposition.target}`));
  }
  const disposed = required.map((obligation) => ({
    ...obligation,
    disposition: parsed.entries.get(`${obligation.ruleId}\0${obligation.type}\0${obligation.target}`) ?? null,
  }));
  const impact = {
    format: IMPACT_FORMAT,
    changedUnits: [...new Set(impactingChanges(diffResult).map((change) => change.unitId))].sort(compareText),
    impactedUnits: impacted.map((id) => ({ id, kind: units.get(id)?.kind ?? null })),
    obligations: disposed,
    complete: diagnostics.length === 0,
  };
  const budget = overBudget(diffResult, impact, maxBytes);
  if (budget.failure) return budget.failure;
  return {
    ok: diagnostics.length === 0,
    diagnostics: sortDiagnostics(diagnostics),
    fileCount: diffResult.fileCount,
    unitCount: impacted.length,
    payloadBytes: budget.payloadBytes,
    diff: diffResult.diff,
    impact,
  };
}
