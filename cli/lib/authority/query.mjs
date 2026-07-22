import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import path from "node:path";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, makeDiagnostic, portablePath } from "./diagnostics.mjs";

const PACKET_FORMAT = "nimicoding.authority-context/v1";
const CLOSURE_CATEGORIES = ["applies_to", "supersedes"];

async function inputLocation(inputPath) {
  const absolute = path.resolve(inputPath);
  const info = await stat(absolute);
  return {
    basePath: info.isDirectory() ? absolute : path.dirname(absolute),
    label: info.isDirectory() ? "." : path.basename(absolute),
  };
}

function queryDiagnostic(location, code, id, reason, repair, mapped = null) {
  return makeDiagnostic({
    code,
    file: mapped ? portablePath(mapped.file, location.basePath) : location.label,
    range: mapped?.range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "/id",
    reason: `${reason}: ${id}`,
    repair,
  });
}

function mappedId(compiled, unitIndex) {
  return compiled.sourceMap.fields[`/units/${unitIndex}/id`] ?? null;
}

function buildPacket(compiled, selectedIds, rootId, closure, basePath) {
  const sourceIndices = compiled.ir.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => selectedIds.has(unit.id))
    .sort((left, right) => compareText(left.unit.id, right.unit.id));
  const fields = {};
  sourceIndices.forEach(({ index: sourceIndex }, packetIndex) => {
    const prefix = `/units/${sourceIndex}`;
    for (const [pointer, mapped] of Object.entries(compiled.sourceMap.fields)) {
      if (pointer !== prefix && !pointer.startsWith(`${prefix}/`)) continue;
      const suffix = pointer.slice(prefix.length);
      fields[`/units/${packetIndex}${suffix}`] = {
        ...mapped,
        file: portablePath(mapped.file, basePath),
      };
    }
  });
  return {
    format: PACKET_FORMAT,
    root: rootId,
    closure,
    units: sourceIndices.map(({ unit }) => unit),
    sourceMap: { fields },
  };
}

export function canonicalPacketBytes(packet) {
  return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

function failedResult(compiled, diagnostics = compiled.diagnostics) {
  return {
    ok: false,
    diagnostics,
    fileCount: compiled.fileCount,
    unitCount: 0,
    packetBytes: 0,
    packet: null,
  };
}

function boundedPacketResult(compiled, packet, maxBytes, rootIndex, location) {
  const packetBytes = canonicalPacketBytes(packet);
  if (packetBytes > maxBytes) return failedResult(compiled, [queryDiagnostic(
    location,
    "AUTH_CONTEXT_BUDGET",
    packet.root,
    `complete canonical packet requires ${packetBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    "increase the explicit byte budget or choose a narrower exact root; partial context is forbidden",
    mappedId(compiled, rootIndex),
  )]);
  return {
    ok: true,
    diagnostics: [],
    fileCount: compiled.fileCount,
    unitCount: packet.units.length,
    packetBytes,
    packet,
  };
}

export async function queryAuthorityPath(inputPath, id, { maxBytes }) {
  const compiled = await compileAuthorityPath(inputPath);
  if (!compiled.ok) return failedResult(compiled);
  const location = await inputLocation(inputPath);
  const unitIndex = compiled.ir.units.findIndex((unit) => unit.id === id);
  if (unitIndex < 0) return failedResult(compiled, [queryDiagnostic(
    location,
    "AUTH_QUERY_NOT_FOUND",
    id,
    "authority identity does not resolve",
    "use an exact admitted authority ID; do not infer a near match",
  )]);
  const packet = buildPacket(compiled, new Set([id]), id, {
    direction: "exact",
    relationCategories: [],
    maxBytes,
    complete: true,
  }, location.basePath);
  return boundedPacketResult(compiled, packet, maxBytes, unitIndex, location);
}

export async function contextAuthorityPath(inputPath, id, { maxUnits, maxBytes }) {
  const compiled = await compileAuthorityPath(inputPath);
  if (!compiled.ok) return failedResult(compiled);
  const location = await inputLocation(inputPath);
  const byId = new Map(compiled.ir.units.map((unit, index) => [unit.id, { unit, index }]));
  const root = byId.get(id);
  if (!root) return failedResult(compiled, [queryDiagnostic(
    location,
    "AUTH_QUERY_NOT_FOUND",
    id,
    "context root does not resolve",
    "use an exact admitted authority ID; do not infer a near match",
  )]);

  const selected = new Set();
  const pending = [id];
  while (pending.length > 0) {
    const currentId = pending.shift();
    if (selected.has(currentId)) continue;
    selected.add(currentId);
    const current = byId.get(currentId).unit;
    const targets = current.relations
      .filter((relation) => CLOSURE_CATEGORIES.includes(relation.type))
      .map((relation) => relation.target)
      .sort(compareText);
    for (const target of targets) if (!selected.has(target)) pending.push(target);
  }

  if (selected.size > maxUnits) return failedResult(compiled, [queryDiagnostic(
    location,
    "AUTH_CONTEXT_BUDGET",
    id,
    `complete context requires ${selected.size} units but max-units is ${maxUnits}`,
    "increase the explicit unit budget or choose a narrower exact root; partial context is forbidden",
    mappedId(compiled, root.index),
  )]);

  const packet = buildPacket(compiled, selected, id, {
    direction: "outgoing_recursive",
    relationCategories: CLOSURE_CATEGORIES,
    maxUnits,
    maxBytes,
    complete: true,
  }, location.basePath);
  return boundedPacketResult(compiled, packet, maxBytes, root.index, location);
}
