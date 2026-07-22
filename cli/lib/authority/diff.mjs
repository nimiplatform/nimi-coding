import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import path from "node:path";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, makeDiagnostic, portablePath, sortDiagnostics } from "./diagnostics.mjs";

const DIFF_FORMAT = "nimicoding.authority-diff/v1";

async function sourceRoot(inputPath) {
  const absolute = path.resolve(inputPath);
  try {
    const info = await stat(absolute);
    return info.isDirectory() ? absolute : path.dirname(absolute);
  } catch {
    return path.dirname(absolute);
  }
}

function sidePath(file, basePath, side) {
  const relative = portablePath(file, basePath);
  const safe = path.isAbsolute(relative) ? path.basename(relative) : relative;
  return path.posix.join(side, safe || ".");
}

function compareRelated(left, right) {
  return compareText(left.path, right.path)
    || left.range.start.line - right.range.start.line
    || left.range.start.column - right.range.start.column
    || compareText(left.pointer, right.pointer)
    || compareText(left.role, right.role);
}

function sideDiagnostics(diagnostics, basePath, side) {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: sidePath(diagnostic.path, basePath, side),
    related: diagnostic.related
      .map((related) => ({ ...related, path: sidePath(related.path, basePath, side) }))
      .sort(compareRelated),
  }));
}

function portableMapping(mapping, basePath) {
  if (!mapping) return null;
  return { ...mapping, file: portablePath(mapping.file, basePath) };
}

function mappedAt(compiled, unitIndex, pointer, basePath) {
  const exact = compiled.sourceMap.fields[`/units/${unitIndex}${pointer}`];
  if (exact) return portableMapping(exact, basePath);
  const prefix = `/units/${unitIndex}${pointer}/`;
  const nested = Object.entries(compiled.sourceMap.fields)
    .filter(([candidate]) => candidate.startsWith(prefix))
    .sort(([left], [right]) => compareText(left, right))[0]?.[1];
  return portableMapping(nested, basePath);
}

function addChange(changes, { unitId, operation = "modified", pointer, before, after, beforeSource = null, afterSource = null }) {
  changes.push({
    unitId,
    operation,
    pointer,
    before,
    after,
    ...(beforeSource ? { beforeSource } : {}),
    ...(afterSource ? { afterSource } : {}),
  });
}

function compareScalar(changes, beforeEntry, afterEntry, pointer, beforeBase, afterBase) {
  const before = beforeEntry.unit;
  const after = afterEntry.unit;
  const read = (value, parts) => parts.reduce((current, part) => current?.[part], value);
  const parts = pointer.slice(1).split("/");
  const left = read(before, parts) ?? null;
  const right = read(after, parts) ?? null;
  if (JSON.stringify(left) === JSON.stringify(right)) return;
  addChange(changes, {
    unitId: after.id,
    pointer,
    before: left,
    after: right,
    beforeSource: mappedAt(beforeEntry.compiled, beforeEntry.index, pointer, beforeBase),
    afterSource: mappedAt(afterEntry.compiled, afterEntry.index, pointer, afterBase),
  });
}

function compareValueSet(changes, beforeEntry, afterEntry, pointer, beforeBase, afterBase) {
  const parts = pointer.slice(1).split("/");
  const read = (unit) => parts.reduce((current, part) => current?.[part], unit) ?? [];
  const beforeValues = read(beforeEntry.unit);
  const afterValues = read(afterEntry.unit);
  const beforeSet = new Set(beforeValues.map((value) => JSON.stringify(value)));
  const afterSet = new Set(afterValues.map((value) => JSON.stringify(value)));
  for (const [operation, values, otherSet, entry, basePath, sourceSide] of [
    ["removed", beforeValues, afterSet, beforeEntry, beforeBase, "beforeSource"],
    ["added", afterValues, beforeSet, afterEntry, afterBase, "afterSource"],
  ]) {
    values.forEach((value, index) => {
      if (otherSet.has(JSON.stringify(value))) return;
      addChange(changes, {
        unitId: afterEntry.unit.id,
        operation,
        pointer,
        before: operation === "removed" ? value : null,
        after: operation === "added" ? value : null,
        [sourceSide]: mappedAt(entry.compiled, entry.index, `${pointer}/${index}`, basePath),
      });
    });
  }
}

function compareRelations(changes, beforeEntry, afterEntry, beforeBase, afterBase) {
  const beforeRelations = beforeEntry.unit.relations;
  const afterRelations = afterEntry.unit.relations;
  const beforeSet = new Set(beforeRelations.map((edge) => `${edge.type}\0${edge.target}`));
  const afterSet = new Set(afterRelations.map((edge) => `${edge.type}\0${edge.target}`));
  for (const [operation, edges, otherSet, entry, basePath, sourceSide] of [
    ["removed", beforeRelations, afterSet, beforeEntry, beforeBase, "beforeSource"],
    ["added", afterRelations, beforeSet, afterEntry, afterBase, "afterSource"],
  ]) {
    edges.forEach((edge, index) => {
      if (otherSet.has(`${edge.type}\0${edge.target}`)) return;
      addChange(changes, {
        unitId: afterEntry.unit.id,
        operation,
        pointer: "/relations",
        before: operation === "removed" ? edge : null,
        after: operation === "added" ? edge : null,
        [sourceSide]: mappedAt(entry.compiled, entry.index, `/relations/${index}`, basePath),
      });
    });
  }
}

function sideMappedAt(compiled, unitIndex, pointer, basePath, side) {
  const mapped = mappedAt(compiled, unitIndex, pointer, basePath);
  return { ...mapped, file: path.posix.join(side, mapped.file) };
}

function transitionDiagnostics(before, after, beforeBase, afterBase) {
  const diagnostics = [];
  const afterById = new Map(after.ir.units.map((unit) => [unit.id, unit]));
  before.ir.units.forEach((unit, index) => {
    if (afterById.has(unit.id)) return;
    const mapped = sideMappedAt(before, index, "/id", beforeBase, "before");
    diagnostics.push(makeDiagnostic({
      code: "AUTH_DIFF_TRANSITION_INVALID",
      file: mapped.file,
      range: mapped.range,
      pointer: mapped.sourcePointer,
      reason: `authority identity cannot physically disappear: ${unit.id}`,
      repair: unit.lifecycle === "removed"
        ? "retain the removed tombstone; permanent reserved-ID storage is not admitted"
        : "replace the active unit with a valid removed tombstone carrying an explicit reason",
    }));
  });
  const beforeById = new Map(before.ir.units.map((unit) => [unit.id, unit]));
  after.ir.units.forEach((unit, index) => {
    const previous = beforeById.get(unit.id);
    if (!previous) return;
    const mapped = sideMappedAt(after, index, "/id", afterBase, "after");
    if (previous.lifecycle === "removed" && unit.lifecycle !== "removed") diagnostics.push(makeDiagnostic({
      code: "AUTH_DIFF_TRANSITION_INVALID",
      file: mapped.file,
      range: mapped.range,
      pointer: mapped.sourcePointer,
      reason: `removed identity cannot return to ${unit.lifecycle}: ${unit.id}`,
      repair: "retain the removed identity and declare a new product-authorized ID",
    }));
    if (previous.kind !== unit.kind) diagnostics.push(makeDiagnostic({
      code: "AUTH_DIFF_TRANSITION_INVALID",
      file: mapped.file,
      range: mapped.range,
      pointer: mapped.sourcePointer,
      reason: `authority identity cannot change kind from ${previous.kind} to ${unit.kind}: ${unit.id}`,
      repair: "retain the original identity and declare a distinct ID for the new kind",
    }));
  });
  return sortDiagnostics(diagnostics);
}

function compareUnits(before, after, beforeBase, afterBase) {
  const changes = [];
  const beforeById = new Map(before.ir.units.map((unit, index) => [unit.id, { unit, index, compiled: before }]));
  const afterById = new Map(after.ir.units.map((unit, index) => [unit.id, { unit, index, compiled: after }]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort(compareText);
  for (const id of ids) {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    if (!left) {
      addChange(changes, {
        unitId: id,
        operation: "unit_added",
        pointer: "",
        before: null,
        after: right.unit,
        afterSource: mappedAt(after, right.index, "/id", afterBase),
      });
      continue;
    }
    if (!right) continue;
    for (const pointer of ["/kind", "/owner", "/lifecycle", "/metadata/title", "/metadata/reason", "/semantic/meaning", "/semantic/modality", "/semantic/statement", "/semantic/condition", "/semantic/failure"]) {
      compareScalar(changes, left, right, pointer, beforeBase, afterBase);
    }
    compareValueSet(changes, left, right, "/semantic/scope", beforeBase, afterBase);
    compareRelations(changes, left, right, beforeBase, afterBase);
  }
  return changes.sort((left, right) => (
    compareText(left.unitId, right.unitId)
    || compareText(left.pointer, right.pointer)
    || compareText(left.operation, right.operation)
    || compareText(JSON.stringify(left.before), JSON.stringify(right.before))
    || compareText(JSON.stringify(left.after), JSON.stringify(right.after))
  ));
}

export function canonicalDiffBytes(diff) {
  return Buffer.byteLength(JSON.stringify(diff), "utf8");
}

function budgetDiagnostic(requiredBytes, maxBytes) {
  return makeDiagnostic({
    code: "AUTH_DIFF_BUDGET",
    file: ".",
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason: `complete semantic diff requires ${requiredBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    repair: "increase the explicit byte budget; partial semantic diff is forbidden",
  });
}

export async function diffAuthorityPaths(beforePath, afterPath, { maxBytes = null } = {}) {
  const [before, after, beforeBase, afterBase] = await Promise.all([
    compileAuthorityPath(beforePath),
    compileAuthorityPath(afterPath),
    sourceRoot(beforePath),
    sourceRoot(afterPath),
  ]);
  if (!before.ok || !after.ok) return {
    ok: false,
    diagnostics: sortDiagnostics([
      ...sideDiagnostics(before.diagnostics, beforeBase, "before"),
      ...sideDiagnostics(after.diagnostics, afterBase, "after"),
    ]),
    fileCount: before.fileCount + after.fileCount,
    unitCount: 0,
    diff: null,
  };
  const invalidTransitions = transitionDiagnostics(before, after, beforeBase, afterBase);
  if (invalidTransitions.length > 0) return {
    ok: false,
    diagnostics: invalidTransitions,
    fileCount: before.fileCount + after.fileCount,
    unitCount: 0,
    diff: null,
  };
  const changes = compareUnits(before, after, beforeBase, afterBase);
  const diff = {
    format: DIFF_FORMAT,
    changes,
    summary: {
      units: new Set(changes.map((change) => change.unitId)).size,
      changes: changes.length,
    },
  };
  const payloadBytes = canonicalDiffBytes(diff);
  if (maxBytes !== null && payloadBytes > maxBytes) return {
    ok: false,
    diagnostics: [budgetDiagnostic(payloadBytes, maxBytes)],
    fileCount: before.fileCount + after.fileCount,
    unitCount: 0,
    payloadBytes,
    diff: null,
  };
  return {
    ok: true,
    diagnostics: [],
    fileCount: before.fileCount + after.fileCount,
    unitCount: new Set([...before.ir.units, ...after.ir.units].map((unit) => unit.id)).size,
    payloadBytes,
    diff,
    before,
    after,
  };
}
