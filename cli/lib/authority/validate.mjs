import { compareText, makeDiagnostic, relatedLocation, REPAIRS, sortDiagnostics, sourcePointer } from "./diagnostics.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointAtEnd(range) {
  const end = range?.end ?? { line: 1, column: 1 };
  return { start: end, end };
}

function rangeFor(source, pointer, missing = false) {
  if (missing && source.insertionPoints?.has(pointer)) return source.insertionPoints.get(pointer);
  const range = source.locations.get(pointer) ?? source.locations.get("") ?? source.locator.range(0);
  return missing ? pointAtEnd(range) : range;
}

function add(diagnostics, source, code, pointer, reason, repair, options = {}) {
  diagnostics.push(makeDiagnostic({
    code,
    file: source.file,
    range: rangeFor(source, pointer, options.missing),
    pointer: sourcePointer(source, pointer),
    reason,
    repair,
    related: options.related ?? [],
  }));
}

function structuralDiagnostics(source, contract) {
  const diagnostics = [];
  const data = source.data;
  if (!isObject(data)) {
    add(diagnostics, source, "AUTH_FIELD_INVALID", "", "each authority unit must be a mapping", REPAIRS.structural);
    return diagnostics;
  }
  const allowed = new Set(source.profile === "markdown"
    ? [...contract.fields.markdown_frontmatter_allowed, "title", "meaning", "statement", "condition", "failure", "reason"]
    : contract.fields.yaml_unit_allowed);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) add(diagnostics, source, "AUTH_UNKNOWN_FIELD", `/${key}`, `unknown authority field: ${key}`, "remove the field or choose an admitted field from the authoring contract");
  }
  if (source.profile === "markdown") {
    const allowedFront = new Set(contract.fields.markdown_frontmatter_allowed);
    for (const key of source.frontKeys ?? []) {
      if (!allowedFront.has(key)) add(diagnostics, source, "AUTH_UNKNOWN_FIELD", `/${key}`, `field ${key} is not admitted in Markdown front matter`, "move content only to its admitted Markdown slot without changing its product meaning");
    }
  }
  for (const [field, admitted] of [
    ...(source.profile === "markdown" ? [["format", [contract.format]]] : []),
    ["kind", contract.kinds],
    ["lifecycle", contract.lifecycles],
  ]) {
    if (!Object.hasOwn(data, field)) add(diagnostics, source, "AUTH_FIELD_REQUIRED", `/${field}`, `${field} is required before the formatter can select a source branch`, REPAIRS.required, { missing: true });
    else if (!admitted.includes(data[field])) add(diagnostics, source, "AUTH_FIELD_INVALID", `/${field}`, `${field} must be one of: ${admitted.join(", ")}`, REPAIRS.invalid);
  }
  if (Object.hasOwn(data, "relations")) {
    if (!Array.isArray(data.relations)) {
      add(diagnostics, source, "AUTH_FIELD_INVALID", "/relations", "relations must be a list", REPAIRS.structural);
    } else {
      data.relations.forEach((relation, index) => {
        const pointer = `/relations/${index}`;
        if (!isObject(relation)) {
          add(diagnostics, source, "AUTH_FIELD_INVALID", pointer, "each relation item must be a mapping with type and target", REPAIRS.structural);
          return;
        }
        const keys = Object.keys(relation);
        for (const field of contract.relation_item_fields) {
          if (!Object.hasOwn(relation, field)) add(diagnostics, source, "AUTH_FIELD_REQUIRED", `${pointer}/${field}`, `relation item requires ${field} before deterministic sorting`, REPAIRS.structural, { missing: true });
          else if (typeof relation[field] !== "string" || relation[field].length === 0) add(diagnostics, source, "AUTH_FIELD_INVALID", `${pointer}/${field}`, `relation ${field} must be a non-empty string`, REPAIRS.structural);
        }
        for (const key of keys) {
          if (!contract.relation_item_fields.includes(key)) add(diagnostics, source, "AUTH_UNKNOWN_FIELD", `${pointer}/${key}`, `unknown relation item field: ${key}`, "remove the field; relation items contain only type and target");
        }
      });
    }
  }
  return diagnostics;
}

function documentStructuralDiagnostics(document, contract) {
  if (document.profile !== "yaml") return document.units.length > 0 ? structuralDiagnostics(document.units[0], contract) : [];
  const diagnostics = [];
  const data = document.data;
  if (!isObject(data)) return diagnostics;
  for (const key of Object.keys(data)) {
    if (!contract.fields.yaml_document.includes(key)) add(diagnostics, document, "AUTH_UNKNOWN_FIELD", `/${key}`, `unknown authority document field: ${key}`, "remove the field; YAML authority documents contain only format and units");
  }
  if (!Object.hasOwn(data, "format")) add(diagnostics, document, "AUTH_FIELD_REQUIRED", "/format", "format is required before the formatter can select the YAML container profile", REPAIRS.required, { missing: true });
  else if (data.format !== contract.format) add(diagnostics, document, "AUTH_FIELD_INVALID", "/format", `format must be: ${contract.format}`, REPAIRS.invalid);
  if (!Object.hasOwn(data, "units")) add(diagnostics, document, "AUTH_FIELD_REQUIRED", "/units", "units is required and must be a non-empty sequence", REPAIRS.structural, { missing: true });
  else if (!Array.isArray(data.units) || data.units.length === 0) add(diagnostics, document, "AUTH_FIELD_INVALID", "/units", "units must be a non-empty sequence", REPAIRS.structural);
  if (Array.isArray(data.units)) diagnostics.push(...document.units.flatMap((source) => structuralDiagnostics(source, contract)));
  return diagnostics;
}

export function validateFormatStructure(source, contract) {
  const diagnostics = source.isDocument
    ? [...source.diagnostics, ...documentStructuralDiagnostics(source, contract)]
    : [...source.diagnostics, ...structuralDiagnostics(source, contract)];
  return sortDiagnostics(diagnostics);
}

function requireField(diagnostics, source, field, reason = null) {
  if (!Object.hasOwn(source.data, field)) {
    add(diagnostics, source, "AUTH_FIELD_REQUIRED", `/${field}`, reason ?? `${field} is required`, REPAIRS.required, { missing: true });
    return false;
  }
  return true;
}

function forbidField(diagnostics, source, field, branch) {
  if (Object.hasOwn(source.data, field)) add(diagnostics, source, "AUTH_FIELD_FORBIDDEN", `/${field}`, `${field} is forbidden for ${branch}`, "remove the field without changing the admitted branch");
}

const AUTHORITY_LINE_BREAK = /[\u000A\u000B\u000C\u000D\u0085\u2028\u2029]/u;

export function validAuthorityText(value) {
  return typeof value === "string"
    && value.length > 0
    && value.isWellFormed()
    && value.trim() === value
    && !AUTHORITY_LINE_BREAK.test(value);
}

function validateUnitFields(source, contract, diagnostics) {
  const data = source.data;
  for (const field of contract.fields.unit_common) requireField(diagnostics, source, field);
  if (source.profile === "markdown") requireField(diagnostics, source, "format");
  for (const field of ["id", "owner"]) {
    if (Object.hasOwn(data, field) && (typeof data[field] !== "string" || !(new RegExp(contract.identifier_pattern)).test(data[field]))) {
      add(diagnostics, source, "AUTH_FIELD_INVALID", `/${field}`, `${field} must be a dot-separated lower-case identifier`, REPAIRS.invalid);
    }
  }
  if (Object.hasOwn(data, "title") && !validAuthorityText(data.title)) add(diagnostics, source, "AUTH_FIELD_INVALID", "/title", "title must be one non-empty trimmed text line", REPAIRS.invalid);
  if (Object.hasOwn(data, "relations") && !Array.isArray(data.relations)) return;
  const active = data.lifecycle === "active";
  if (active && data.kind === "definition") {
    requireField(diagnostics, source, "meaning");
    if (Object.hasOwn(data, "meaning") && !validAuthorityText(data.meaning)) add(diagnostics, source, "AUTH_FIELD_INVALID", "/meaning", "meaning must be one non-empty trimmed text line", REPAIRS.invalid);
    for (const field of ["modality", "scope", "statement", "condition", "failure", "reason"]) forbidField(diagnostics, source, field, "active definition");
  } else if (active && data.kind === "rule") {
    for (const field of contract.fields.active_rule_required) requireField(diagnostics, source, field);
    if (Object.hasOwn(data, "modality") && !contract.modalities.includes(data.modality)) add(diagnostics, source, "AUTH_FIELD_INVALID", "/modality", `modality must be one of: ${contract.modalities.join(", ")}`, REPAIRS.invalid);
    if (Object.hasOwn(data, "scope")) {
      if (!Array.isArray(data.scope) || data.scope.length === 0) add(diagnostics, source, "AUTH_FIELD_INVALID", "/scope", "active rule scope must be a non-empty list", REPAIRS.invalid);
      else {
        const seen = new Set();
        data.scope.forEach((entry, index) => {
          if (typeof entry !== "string" || !(new RegExp(contract.identifier_pattern)).test(entry)) add(diagnostics, source, "AUTH_FIELD_INVALID", `/scope/${index}`, "scope values must be dot-separated lower-case identifiers", REPAIRS.invalid);
          else if (seen.has(entry)) add(diagnostics, source, "AUTH_FIELD_INVALID", `/scope/${index}`, "scope values must be unique", "remove the duplicate scope value");
          seen.add(entry);
        });
      }
    }
    for (const field of ["statement", "condition", "failure"]) {
      if (Object.hasOwn(data, field) && !validAuthorityText(data[field])) add(diagnostics, source, "AUTH_FIELD_INVALID", `/${field}`, `${field} must be one non-empty trimmed text line`, REPAIRS.invalid);
    }
    for (const field of ["meaning", "reason"]) forbidField(diagnostics, source, field, "active rule");
  } else if (data.lifecycle === "removed" && contract.kinds.includes(data.kind)) {
    requireField(diagnostics, source, "reason");
    if (Object.hasOwn(data, "reason") && !validAuthorityText(data.reason)) add(diagnostics, source, "AUTH_FIELD_INVALID", "/reason", "reason must be one non-empty trimmed text line", REPAIRS.invalid);
    for (const field of ["meaning", "modality", "scope", "statement", "condition", "failure"]) forbidField(diagnostics, source, field, `removed ${data.kind}`);
  }
}

function validateIdentity(sources, diagnostics) {
  const groups = new Map();
  for (const source of sources) {
    if (typeof source.data.id !== "string") continue;
    const group = groups.get(source.data.id) ?? [];
    group.push(source);
    groups.set(source.data.id, group);
  }
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    group.sort((left, right) => compareText(left.file, right.file) || compareText(left.sourcePrefix ?? "", right.sourcePrefix ?? ""));
    const [primary, ...rest] = group;
    const related = rest.map((source) => relatedLocation(source, "/id", "duplicate declaration"));
    add(diagnostics, primary, "AUTH_ID_DUPLICATE", "/id", `identity ${id} is declared more than once`, REPAIRS.duplicate, { related });
    if (new Set(group.map((source) => source.data.owner)).size > 1) {
      add(diagnostics, primary, "AUTH_OWNER_CONFLICT", "/owner", `identity ${id} declares more than one owner`, "choose the single owner from product authority and remove conflicting declarations", {
        related: rest.map((source) => relatedLocation(source, "/owner", "conflicting declaration")),
      });
    }
  }
}

function relationLocation(edge, pointer = "") {
  return relatedLocation(edge.source, `/relations/${edge.index}${pointer}`, "related relation");
}

function validateRelations(sources, contract, diagnostics) {
  const byId = new Map(sources.filter((source) => typeof source.data.id === "string").map((source) => [source.data.id, source]));
  const supersedes = [];
  for (const source of sources) {
    const relations = Array.isArray(source.data.relations) ? source.data.relations : [];
    const seen = new Map();
    let appliesTo = 0;
    let outgoingSupersedes = 0;
    relations.forEach((relation, index) => {
      const pointer = `/relations/${index}`;
      const key = `${relation.type}\0${relation.target}`;
      if (seen.has(key)) add(diagnostics, source, "AUTH_RELATION_CARDINALITY", pointer, "duplicate relation edges are not admitted", "remove the duplicate edge", { related: [relatedLocation(source, `/relations/${seen.get(key)}`, "first duplicate edge")] });
      else seen.set(key, index);
      if (!Object.hasOwn(contract.relation_types, relation.type)) {
        add(diagnostics, source, "AUTH_RELATION_UNKNOWN", `${pointer}/type`, `unknown relation type: ${relation.type}`, "choose an admitted relation type from product authority");
        return;
      }
      if (!(new RegExp(contract.identifier_pattern)).test(relation.target)) {
        add(diagnostics, source, "AUTH_FIELD_INVALID", `${pointer}/target`, "relation target must be a dot-separated lower-case identifier", REPAIRS.relation);
        return;
      }
      if (relation.type === "applies_to") appliesTo += 1;
      else outgoingSupersedes += 1;
      const target = byId.get(relation.target);
      if (!target) {
        add(diagnostics, source, "AUTH_RELATION_DANGLING", `${pointer}/target`, `relation target does not resolve: ${relation.target}`, REPAIRS.relation);
        return;
      }
      if (relation.type === "applies_to") {
        if (!(source.data.kind === "rule" && source.data.lifecycle === "active" && target.data.kind === "definition" && target.data.lifecycle === "active")) {
          add(diagnostics, source, "AUTH_RELATION_TYPE", pointer, "applies_to requires active rule to active definition", REPAIRS.relation, { related: [relatedLocation(target, "/kind", "relation target")] });
        }
      } else {
        supersedes.push({ source, target, index });
        if (source.data.id === target.data.id) add(diagnostics, source, "AUTH_RELATION_CYCLE", pointer, "supersedes cannot target its own unit", REPAIRS.relation);
        else if (!(target.data.lifecycle === "removed" && target.data.kind === source.data.kind)) {
          add(diagnostics, source, "AUTH_RELATION_TYPE", pointer, "supersedes requires a removed same-kind target", REPAIRS.relation, { related: [relatedLocation(target, "/lifecycle", "relation target")] });
        }
      }
    });
    if (source.data.kind === "rule" && source.data.lifecycle === "active" && appliesTo === 0) add(diagnostics, source, "AUTH_RELATION_CARDINALITY", "/relations", "active rule requires at least one applies_to relation", REPAIRS.relation);
    if (outgoingSupersedes > 1) add(diagnostics, source, "AUTH_RELATION_CARDINALITY", "/relations", "a unit may declare at most one supersedes relation", REPAIRS.relation);
    if (source.data.lifecycle === "removed" && relations.some((relation) => relation.type !== "supersedes")) add(diagnostics, source, "AUTH_RELATION_TYPE", "/relations", "removed units may only retain a supersedes relation", REPAIRS.relation);
    if (source.data.kind === "definition" && source.data.lifecycle === "active" && relations.some((relation) => relation.type === "applies_to")) add(diagnostics, source, "AUTH_RELATION_TYPE", "/relations", "active definitions cannot declare applies_to", REPAIRS.relation);
  }
  const incoming = new Map();
  for (const edge of supersedes) {
    const list = incoming.get(edge.target.data.id) ?? [];
    list.push(edge);
    incoming.set(edge.target.data.id, list);
  }
  for (const [targetId, edges] of incoming) {
    if (edges.length > 1) {
      edges.sort((left, right) => compareText(left.source.file, right.source.file) || compareText(left.source.sourcePrefix ?? "", right.source.sourcePrefix ?? ""));
      const [primary, ...rest] = edges;
      add(diagnostics, primary.source, "AUTH_RELATION_CARDINALITY", `/relations/${primary.index}`, `removed identity ${targetId} has more than one incoming supersedes relation`, REPAIRS.relation, { related: rest.map((edge) => relationLocation(edge)) });
    }
  }
  const next = new Map(supersedes.map((edge) => [edge.source.data.id, edge]));
  const reported = new Set();
  for (const start of next.keys()) {
    const path = [];
    const positions = new Map();
    let current = start;
    while (next.has(current)) {
      if (positions.has(current)) {
        const cycle = path.slice(positions.get(current));
        const cycleKey = cycle.map((edge) => edge.source.data.id).sort(compareText).join("|");
        if (!reported.has(cycleKey)) {
          reported.add(cycleKey);
          cycle.sort((left, right) => compareText(left.source.file, right.source.file) || compareText(left.source.sourcePrefix ?? "", right.source.sourcePrefix ?? ""));
          const [primary, ...rest] = cycle;
          add(diagnostics, primary.source, "AUTH_RELATION_CYCLE", `/relations/${primary.index}`, "supersedes relations must form an acyclic lineage", REPAIRS.relation, { related: rest.map((edge) => relationLocation(edge)) });
        }
        break;
      }
      positions.set(current, path.length);
      const edge = next.get(current);
      path.push(edge);
      current = edge.target.data.id;
    }
  }
}

export function validateAuthoritySources(sources, contract) {
  const structural = sources.flatMap((source) => validateFormatStructure(source, contract));
  if (structural.length > 0) return { ok: false, diagnostics: sortDiagnostics(structural) };
  const diagnostics = [];
  for (const source of sources) validateUnitFields(source, contract, diagnostics);
  validateIdentity(sources, diagnostics);
  validateRelations(sources, contract, diagnostics);
  return { ok: diagnostics.length === 0, diagnostics: sortDiagnostics(diagnostics) };
}
