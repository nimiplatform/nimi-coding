import { compareText, makeDiagnostic, REPAIRS, sortDiagnostics, sourcePointer as absoluteSourcePointer } from "./diagnostics.mjs";

function addMappedLeaf(source, fields, diagnostics, outputPointer, sourcePointer) {
  const range = source.locations.get(sourcePointer);
  if (!range) {
    diagnostics.push(makeDiagnostic({
      code: "AUTH_SOURCE_MAP_MISSING",
      file: source.file,
      range: source.locations.get("") ?? source.locator.range(0),
      pointer: absoluteSourcePointer(source, sourcePointer),
      reason: `AuthorityIR leaf ${outputPointer} has no source range at ${sourcePointer}`,
      repair: REPAIRS.structural,
    }));
  } else {
    fields[outputPointer] = { file: source.file, range, sourcePointer: absoluteSourcePointer(source, sourcePointer) };
  }
}

function collectIrLeaves(value, pointer = "", leaves = new Set()) {
  if (Array.isArray(value)) {
    if (value.length === 0) leaves.add(pointer);
    else value.forEach((entry, index) => collectIrLeaves(entry, `${pointer}/${index}`, leaves));
    return leaves;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) leaves.add(pointer);
    else entries.forEach(([key, entry]) => collectIrLeaves(entry, `${pointer}/${key}`, leaves));
    return leaves;
  }
  leaves.add(pointer);
  return leaves;
}

function mapUnit(source, outputIndex, fields, diagnostics) {
  const base = `/units/${outputIndex}`;
  for (const field of ["id", "kind", "owner", "lifecycle"]) {
    addMappedLeaf(source, fields, diagnostics, `${base}/${field}`, `/${field}`);
  }
  addMappedLeaf(source, fields, diagnostics, `${base}/metadata/title`, "/title");
  if (source.data.reason !== undefined) addMappedLeaf(source, fields, diagnostics, `${base}/metadata/reason`, "/reason");
  if (source.data.lifecycle === "active" && source.data.kind === "definition") {
    addMappedLeaf(source, fields, diagnostics, `${base}/semantic/meaning`, "/meaning");
  }
  if (source.data.lifecycle === "active" && source.data.kind === "rule") {
    for (const field of ["modality", "statement", "condition", "failure"]) {
      addMappedLeaf(source, fields, diagnostics, `${base}/semantic/${field}`, `/${field}`);
    }
    source.data.scope
      .map((value, sourceIndex) => ({ value, sourceIndex }))
      .sort((left, right) => compareText(left.value, right.value))
      .forEach((entry, scopeIndex) => addMappedLeaf(source, fields, diagnostics, `${base}/semantic/scope/${scopeIndex}`, `/scope/${entry.sourceIndex}`));
  }
  if (source.data.relations.length === 0) {
    addMappedLeaf(source, fields, diagnostics, `${base}/relations`, "/relations");
  } else {
    source.data.relations
      .map((relation, sourceIndex) => ({ relation, sourceIndex }))
      .sort((left, right) => compareText(left.relation.type, right.relation.type) || compareText(left.relation.target, right.relation.target))
      .forEach((entry, relationIndex) => {
        const outputPointer = `${base}/relations/${relationIndex}`;
        const sourcePointer = `/relations/${entry.sourceIndex}`;
        addMappedLeaf(source, fields, diagnostics, `${outputPointer}/type`, `${sourcePointer}/type`);
        addMappedLeaf(source, fields, diagnostics, `${outputPointer}/target`, `${sourcePointer}/target`);
      });
  }
}

export function buildSourceMap(sources, ir) {
  const diagnostics = [];
  const fields = {};
  const orderedSources = [...sources].sort((left, right) => compareText(left.data.id, right.data.id));
  orderedSources.forEach((source, outputIndex) => mapUnit(source, outputIndex, fields, diagnostics));
  const expectedLeaves = collectIrLeaves(ir);
  for (const pointer of Object.keys(fields)) {
    if (!expectedLeaves.has(pointer)) {
      const mapped = fields[pointer];
      diagnostics.push(makeDiagnostic({
        code: "AUTH_SOURCE_MAP_MISSING",
        file: mapped.file,
        range: mapped.range,
        pointer: mapped.sourcePointer,
        reason: `SourceMap entry does not address an AuthorityIR leaf: ${pointer}`,
        repair: REPAIRS.structural,
      }));
    }
  }
  for (const pointer of expectedLeaves) {
    if (!Object.hasOwn(fields, pointer)) {
      const match = pointer.match(/^\/units\/(\d+)/);
      const source = orderedSources[Number(match?.[1] ?? 0)] ?? orderedSources[0];
      diagnostics.push(makeDiagnostic({
        code: "AUTH_SOURCE_MAP_MISSING",
        file: source.file,
        range: source.locations.get("") ?? source.locator.range(0),
        pointer: absoluteSourcePointer(source, ""),
        reason: `AuthorityIR leaf is not mapped: ${pointer}`,
        repair: REPAIRS.structural,
      }));
    }
  }
  return { ok: diagnostics.length === 0, diagnostics: sortDiagnostics(diagnostics), sourceMap: { fields } };
}

export { collectIrLeaves };
