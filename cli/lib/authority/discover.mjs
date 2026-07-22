import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import path from "node:path";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, makeDiagnostic, portablePath } from "./diagnostics.mjs";
import { buildAuthorityGraphSnapshot } from "./graph.mjs";

const DISCOVERY_FORMAT = "nimicoding.authority-discovery/v2";
const FIELD_ORDER = ["id", "title", "owner", "scope", "meaning", "statement", "condition", "failure", "reason"];
const RANK_FIELDS = ["scope", "failure", "condition", "reason", "owner"];
const KINDS = new Set(["definition", "rule"]);
const LIFECYCLES = new Set(["active", "removed"]);
const DIRECTIONS = new Set(["incoming", "outgoing", "both"]);
const RELATION_TYPES = new Set(["applies_to", "supersedes"]);
const IDENTIFIER = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)+$/;

function orderedDiscoveryTerms(text) {
  const normalized = String(text).normalize("NFKC");
  const camelSplit = normalized.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").toLowerCase();
  return camelSplit.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function normalizeDiscoveryTerms(text) {
  return [...new Set(orderedDiscoveryTerms(text))];
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
      const orderedTerms = orderedDiscoveryTerms(value);
      const valueTerms = new Set(orderedTerms);
      const terms = queryTerms.filter((term) => valueTerms.has(term));
      if (terms.length === 0) return;
      terms.forEach((term) => fieldTerms.add(term));
      const mapped = compiled.sourceMap.fields[fieldPointer(unitIndex, field, valueIndex)];
      matches.push({ field, terms, location: portableLocation(mapped, basePath), orderedTerms });
    });
    termSets[field] = fieldTerms;
  }
  const all = new Set(FIELD_ORDER.flatMap((field) => [...termSets[field]]));
  if (all.size === 0) return null;
  const idMapped = compiled.sourceMap.fields[`/units/${unitIndex}/id`];
  return {
    candidate: {
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

function snippetWindow(orderedTerms, queryTerms, maxSnippetTerms) {
  const width = Math.min(maxSnippetTerms, orderedTerms.length);
  const querySet = new Set(queryTerms);
  let start = 0;
  if (width < orderedTerms.length) {
    const frequencies = new Map();
    const add = (term) => {
      if (querySet.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    };
    const remove = (term) => {
      if (!querySet.has(term)) return;
      const remaining = frequencies.get(term) - 1;
      if (remaining === 0) frequencies.delete(term);
      else frequencies.set(term, remaining);
    };
    for (let index = 0; index < width; index += 1) add(orderedTerms[index]);
    let bestScore = frequencies.size;
    for (let nextStart = 1; nextStart <= orderedTerms.length - width; nextStart += 1) {
      remove(orderedTerms[nextStart - 1]);
      add(orderedTerms[nextStart + width - 1]);
      if (frequencies.size > bestScore) {
        bestScore = frequencies.size;
        start = nextStart;
      }
    }
  }
  const end = start + width;
  const terms = orderedTerms.slice(start, end);
  const windowTerms = new Set(terms);
  const matchedTerms = queryTerms.filter((term) => windowTerms.has(term));
  const anchorOffset = terms.findIndex((term) => querySet.has(term));
  return {
    normalization: "NFKC_camel_boundary_lowercase_Unicode_Letter_Number_terms",
    terms,
    anchor: {
      term: terms[anchorOffset],
      fieldTermIndex: start + anchorOffset,
    },
    matchedTerms,
    omittedBeforeTerms: start,
    omittedAfterTerms: orderedTerms.length - end,
    complete: start === 0 && end === orderedTerms.length,
  };
}

function publicCandidate(ranked, rank, queryTerms, maxSnippetTerms) {
  const { candidate } = ranked;
  return {
    rank,
    id: candidate.id,
    kind: candidate.kind,
    lifecycle: candidate.lifecycle,
    owner: candidate.owner,
    title: candidate.title,
    scope: candidate.scope,
    matchedTerms: candidate.matchedTerms,
    matches: candidate.matches.map(({ field, terms, location, orderedTerms }) => ({
      field,
      terms,
      location,
      snippet: snippetWindow(orderedTerms, queryTerms, maxSnippetTerms),
    })),
    primaryIdLocation: candidate.primaryIdLocation,
  };
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

function exactFilterValue(value) {
  return typeof value === "string"
    && value === value.normalize("NFC")
    && IDENTIFIER.test(value);
}

function validateBudgets(options, compiled, location) {
  for (const [name, value] of [["maxCandidates", options.maxCandidates], ["maxSnippetTerms", options.maxSnippetTerms], ["maxBytes", options.maxBytes]]) {
    if (!Number.isSafeInteger(value) || value <= 0) return failedResult(compiled, [discoveryDiagnostic(
      location,
      "AUTH_DISCOVERY_BUDGET",
      `${name} must be one positive safe integer`,
      "provide explicit positive safe-integer discovery budgets",
    )]);
  }
  return null;
}

function validateFilters(compiled, location, filters) {
  if (filters.kind !== null && !KINDS.has(filters.kind)) return { result: failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_FILTER_INVALID",
    "kind filter must be exactly definition or rule",
    "provide one admitted exact kind or omit the filter",
  )]) };
  if (filters.lifecycle !== null && !LIFECYCLES.has(filters.lifecycle)) return { result: failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_FILTER_INVALID",
    "lifecycle filter must be exactly active or removed",
    "provide one admitted exact lifecycle or omit the filter",
  )]) };
  for (const key of ["owner", "scope"]) {
    if (filters[key] !== null && !exactFilterValue(filters[key])) return { result: failedResult(compiled, [discoveryDiagnostic(
      location,
      "AUTH_DISCOVERY_FILTER_INVALID",
      `${key} filter must be one exact NFC dotted lowercase identifier`,
      `provide one exact admitted ${key} value or omit the filter`,
    )]) };
  }

  const owners = new Set(compiled.ir.units.map((unit) => unit.owner));
  const scopes = new Set(compiled.ir.units.flatMap((unit) => unit.semantic?.scope ?? []));
  for (const [key, universe] of [["owner", owners], ["scope", scopes]]) {
    if (filters[key] !== null && !universe.has(filters[key])) return { result: failedResult(compiled, [discoveryDiagnostic(
      location,
      "AUTH_DISCOVERY_FILTER_UNKNOWN",
      `${key} filter does not resolve in the complete admitted corpus: ${filters[key]}`,
      `obtain one exact admitted ${key} value; unknown filters are not treated as an empty result`,
    )]) };
  }
  if (filters.scope !== null && (filters.kind === "definition" || filters.lifecycle === "removed")) return { result: failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_FILTER_CONTRADICTORY",
    "scope filters can select only active rules, but the exact structural filters exclude active rules",
    "remove the contradictory filter or provide a structurally possible exact filter combination",
  )]) };

  const eligible = compiled.ir.units.filter((unit) => (
    (filters.kind === null || unit.kind === filters.kind)
    && (filters.owner === null || unit.owner === filters.owner)
    && (filters.lifecycle === null || unit.lifecycle === filters.lifecycle)
    && (filters.scope === null || (unit.semantic?.scope ?? []).includes(filters.scope))
  ));
  if (eligible.length === 0) return { result: failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_FILTER_CONTRADICTORY",
    "the exact structural filter intersection contains no admitted unit",
    "remove or correct the contradictory exact filter combination; do not infer authority absence",
  )]) };
  return { eligible };
}

function validatePreview(compiled, location, options) {
  const values = [options.previewDirection, options.relations, options.maxEdges];
  const present = values.filter((value) => value !== null && value !== undefined).length;
  if (present === 0) return { preview: null };
  if (present !== values.length
    || !DIRECTIONS.has(options.previewDirection)
    || !Array.isArray(options.relations)
    || options.relations.length === 0
    || new Set(options.relations).size !== options.relations.length
    || options.relations.some((relation) => !RELATION_TYPES.has(relation))
    || !Number.isSafeInteger(options.maxEdges)
    || options.maxEdges <= 0) return { result: failedResult(compiled, [discoveryDiagnostic(
      location,
      "AUTH_DISCOVERY_PREVIEW_INVALID",
      "relation preview requires one direction, one non-empty unique closed relation set, and one positive safe-integer maxEdges budget",
      "provide previewDirection, relations, and maxEdges together or omit all three",
    )]) };
  return {
    preview: {
      direction: options.previewDirection,
      relations: [...options.relations].sort(compareText),
      maxEdges: options.maxEdges,
    },
  };
}

function edgeKey(edge) {
  return `${edge.source}\u0000${edge.type}\u0000${edge.target}`;
}

function compareEdge(left, right) {
  return compareText(left.source, right.source)
    || compareText(left.type, right.type)
    || compareText(left.target, right.target);
}

function relationPreview(compiled, basePath, candidates, preview) {
  if (preview === null) return { value: null };
  const snapshot = buildAuthorityGraphSnapshot(compiled, basePath, preview.relations);
  const selected = new Map();
  for (const candidate of candidates) {
    if (preview.direction === "outgoing" || preview.direction === "both") {
      for (const edge of snapshot.outgoing.get(candidate.id)) selected.set(edgeKey(edge), edge);
    }
    if (preview.direction === "incoming" || preview.direction === "both") {
      for (const edge of snapshot.incoming.get(candidate.id)) selected.set(edgeKey(edge), edge);
    }
  }
  const edges = [...selected.values()].sort(compareEdge);
  if (edges.length > preview.maxEdges) return {
    requiredEdges: edges.length,
  };
  const nodeIds = new Set(candidates.map((candidate) => candidate.id));
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  const nodes = [...nodeIds].sort(compareText).map((id) => snapshot.byId.get(id).node);
  return {
    value: {
      direction: preview.direction,
      relations: preview.relations,
      complete: true,
      roots: candidates.map((candidate) => candidate.id),
      nodes,
      edges,
      counts: {
        roots: candidates.length,
        units: nodes.length,
        edges: edges.length,
      },
      budgets: { maxEdges: preview.maxEdges },
      policy: {
        selection: "complete_direct_authored_edges_incident_to_returned_candidates",
        edgeRepresentation: "canonical_authored_source_to_target",
        duplicateNodesAndEdges: "suppressed",
        rankingEffect: "none",
      },
    },
  };
}

export function canonicalDiscoveryBytes(discovery) {
  return Buffer.byteLength(JSON.stringify(discovery), "utf8");
}

export async function discoverAuthorityPath(inputPath, query, {
  maxCandidates,
  maxSnippetTerms,
  maxBytes,
  kind = null,
  owner = null,
  scope = null,
  lifecycle = null,
  previewDirection = null,
  relations = null,
  maxEdges = null,
}) {
  const compiled = await compileAuthorityPath(inputPath);
  if (!compiled.ok) return failedResult(compiled);
  const location = await inputLocation(inputPath);
  const budgetFailure = validateBudgets({ maxCandidates, maxSnippetTerms, maxBytes }, compiled, location);
  if (budgetFailure) return budgetFailure;
  const filters = { kind, owner, scope, lifecycle };
  const filtered = validateFilters(compiled, location, filters);
  if (filtered.result) return filtered.result;
  const previewValidation = validatePreview(compiled, location, { previewDirection, relations, maxEdges });
  if (previewValidation.result) return previewValidation.result;

  const normalizedTerms = normalizeDiscoveryTerms(query);
  if (normalizedTerms.length === 0) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_QUERY_INVALID",
    "authority discovery query contains no Unicode Letter or Number lexical term",
    "provide one or more lexical terms; semantic inference, translation, fuzzy matching, and fallback queries are not performed",
  )]);

  const eligible = new Set(filtered.eligible);
  const ranked = compiled.ir.units
    .map((unit, unitIndex) => ({ unit, unitIndex }))
    .filter(({ unit }) => eligible.has(unit))
    .map(({ unit, unitIndex }) => matchedCandidate(compiled, unit, unitIndex, normalizedTerms, location.basePath))
    .filter((candidate) => candidate !== null)
    .sort(compareCandidates);
  if (ranked.length === 0) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_NOT_FOUND",
    "lexical discovery found no candidate in the exact eligible universe; this does not prove that authority does not exist",
    "rewrite the lexical query, revise exact filters, obtain an exact authority ID, or use an external semantic host; do not infer absence",
  )]);

  const candidates = ranked.slice(0, maxCandidates).map((entry, index) => publicCandidate(entry, index + 1, normalizedTerms, maxSnippetTerms));
  const previewResult = relationPreview(compiled, location.basePath, candidates, previewValidation.preview);
  if (previewResult.requiredEdges !== undefined) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_PREVIEW_BUDGET",
    `complete direct relation preview requires ${previewResult.requiredEdges} authored edges but max-edges is ${maxEdges}`,
    "increase the explicit edge budget; relation preview edges are not silently removed",
  )]);

  const discovery = {
    format: DISCOVERY_FORMAT,
    query: { text: query, normalizedTerms },
    filters,
    counts: {
      corpusUnits: compiled.ir.units.length,
      eligibleUnits: filtered.eligible.length,
      matchedUnits: ranked.length,
      returnedCandidates: candidates.length,
    },
    truncated: ranked.length > candidates.length,
    absenceProven: false,
    candidates,
    relationPreview: previewResult.value,
    budgets: {
      maxCandidates,
      maxSnippetTerms,
      maxEdges: previewValidation.preview?.maxEdges ?? null,
      maxBytes,
    },
  };
  const discoveryBytes = canonicalDiscoveryBytes(discovery);
  if (discoveryBytes > maxBytes) return failedResult(compiled, [discoveryDiagnostic(
    location,
    "AUTH_DISCOVERY_BUDGET",
    `complete bounded discovery payload requires ${discoveryBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    "increase the explicit byte budget; candidates, snippets, and relation preview are not silently removed",
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
