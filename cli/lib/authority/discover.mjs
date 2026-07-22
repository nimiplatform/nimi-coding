import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import path from "node:path";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, makeDiagnostic, portablePath } from "./diagnostics.mjs";

const DISCOVERY_FORMAT = "nimicoding.authority-discovery/v1";
const FIELD_ORDER = ["id", "title", "owner", "scope", "meaning", "statement", "condition", "failure", "reason"];
const RANK_FIELDS = ["scope", "failure", "condition", "reason", "owner"];

export function normalizeDiscoveryTerms(text) {
  const camelSplit = String(text).replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2");
  const normalized = camelSplit.normalize("NFKC").toLowerCase();
  return [...new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function fieldValues(unit) {
  return {
    id: [unit.id],
    title: [unit.metadata.title],
    owner: [unit.owner],
    scope: unit.semantic?.scope ?? [],
    meaning: unit.semantic?.meaning === undefined ? [] : [unit.semantic.meaning],
    statement: unit.semantic?.statement === undefined ? [] : [unit.semantic.statement],
    condition: unit.semantic?.condition === undefined ? [] : [unit.semantic.condition],
    failure: unit.semantic?.failure === undefined ? [] : [unit.semantic.failure],
    reason: unit.metadata.reason === undefined ? [] : [unit.metadata.reason],
  };
}

function fieldPointer(unitIndex, field, valueIndex) {
  if (field === "id" || field === "owner") return `/units/${unitIndex}/${field}`;
  if (field === "title" || field === "reason") return `/units/${unitIndex}/metadata/${field}`;
  if (field === "scope") return `/units/${unitIndex}/semantic/scope/${valueIndex}`;
  return `/units/${unitIndex}/semantic/${field}`;
}

function portableLocation(mapped, basePath) {
  return { ...mapped, file: portablePath(mapped.file, basePath) };
}

function matchedCandidate(compiled, unit, unitIndex, queryTerms, basePath) {
  const values = fieldValues(unit);
  const termSets = {};
  const matches = [];
  for (const field of FIELD_ORDER) {
    const fieldTerms = new Set();
    values[field].forEach((value, valueIndex) => {
      const valueTerms = new Set(normalizeDiscoveryTerms(value));
      const terms = queryTerms.filter((term) => valueTerms.has(term));
      if (terms.length === 0) return;
      terms.forEach((term) => fieldTerms.add(term));
      const mapped = compiled.sourceMap.fields[fieldPointer(unitIndex, field, valueIndex)];
      matches.push({ field, terms, location: portableLocation(mapped, basePath) });
    });
    termSets[field] = fieldTerms;
  }
  const all = new Set(FIELD_ORDER.flatMap((field) => [...termSets[field]]));
  if (all.size === 0) return null;
  const idMapped = compiled.sourceMap.fields[`/units/${unitIndex}/id`];
  return {
    candidate: {
      rank: 0,
      id: unit.id,
      kind: unit.kind,
      lifecycle: unit.lifecycle,
      owner: unit.owner,
      title: unit.metadata.title,
      scope: unit.semantic?.scope ?? [],
      matchedTerms: queryTerms.filter((term) => all.has(term)),
      matches,
      primaryIdLocation: portableLocation(idMapped, basePath),
    },
    counts: {
      identity: new Set([...termSets.id, ...termSets.title]).size,
      primaryMeaning: new Set([...termSets.meaning, ...termSets.statement]).size,
      all: all.size,
      ...Object.fromEntries(RANK_FIELDS.map((field) => [field, termSets[field].size])),
    },
  };
}

function compareCandidates(left, right) {
  return right.counts.identity - left.counts.identity
    || right.counts.primaryMeaning - left.counts.primaryMeaning
    || right.counts.all - left.counts.all
    || RANK_FIELDS.map((field) => right.counts[field] - left.counts[field]).find((value) => value !== 0)
    || compareText(left.candidate.id, right.candidate.id);
}

async function inputLocation(inputPath) {
  const absolute = path.resolve(inputPath);
  const info = await stat(absolute);
  return {
    basePath: info.isDirectory() ? absolute : path.dirname(absolute),
    label: info.isDirectory() ? "." : path.basename(absolute),
  };
}

function discoveryDiagnostic(location, code, reason, repair) {
  return makeDiagnostic({
    code,
    file: location.label,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason,
    repair,
  });
}

function failedResult(compiled, diagnostics = compiled.diagnostics) {
  return {
    ok: false,
    diagnostics,
    fileCount: compiled.fileCount,
    unitCount: 0,
    discoveryBytes: 0,
    discovery: null,
  };
}

export function canonicalDiscoveryBytes(discovery) {
  return Buffer.byteLength(JSON.stringify(discovery), "utf8");
}

export async function discoverAuthorityPath(inputPath, query, { maxCandidates, maxBytes }) {
  const compiled = await compileAuthorityPath(inputPath);
  if (!compiled.ok) return failedResult(compiled);
  const location = await inputLocation(inputPath);
  const normalizedTerms = normalizeDiscoveryTerms(query);
  if (normalizedTerms.length === 0) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_QUERY_INVALID",
    "authority discovery query contains no Unicode Letter or Number lexical term",
    "provide one or more lexical terms; semantic inference, translation, fuzzy matching, and fallback queries are not performed",
  )]);

  const ranked = compiled.ir.units
    .map((unit, unitIndex) => matchedCandidate(compiled, unit, unitIndex, normalizedTerms, location.basePath))
    .filter((candidate) => candidate !== null)
    .sort(compareCandidates);
  if (ranked.length === 0) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_NOT_FOUND",
    "lexical discovery found no candidate; this does not prove that authority does not exist",
    "rewrite the lexical query, obtain an exact authority ID, or use an external semantic host; do not infer absence",
  )]);

  const candidates = ranked.slice(0, maxCandidates).map(({ candidate }, index) => ({ ...candidate, rank: index + 1 }));
  const discovery = {
    format: DISCOVERY_FORMAT,
    query: { text: query, normalizedTerms },
    matchedTotal: ranked.length,
    returned: candidates.length,
    truncated: ranked.length > candidates.length,
    candidates,
  };
  const discoveryBytes = canonicalDiscoveryBytes(discovery);
  if (discoveryBytes > maxBytes) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_BUDGET",
    `complete top-${maxCandidates} discovery payload requires ${discoveryBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    "increase the explicit byte budget; candidates are not silently removed and partial discovery is forbidden",
  )]);
  return {
    ok: true,
    diagnostics: [],
    fileCount: compiled.fileCount,
    unitCount: candidates.length,
    discoveryBytes,
    discovery,
  };
}
