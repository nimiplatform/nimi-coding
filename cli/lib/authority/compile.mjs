import { compareText } from "./diagnostics.mjs";
import { formattingDiagnostics, parseAuthorityPath } from "./format.mjs";
import { validateAuthorityScopeBindings } from "./scope-bindings.mjs";
import { buildSourceMap } from "./source-map.mjs";
import { validateAuthoritySources } from "./validate.mjs";

function lowerUnit(source) {
  const data = source.data;
  const unit = {
    id: data.id,
    kind: data.kind,
    owner: data.owner,
    lifecycle: data.lifecycle,
    metadata: {
      title: data.title,
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    },
    relations: [...data.relations]
      .map((relation) => ({ type: relation.type, target: relation.target }))
      .sort((left, right) => compareText(left.type, right.type) || compareText(left.target, right.target)),
  };
  if (data.lifecycle === "active" && data.kind === "definition") unit.semantic = { meaning: data.meaning };
  if (data.lifecycle === "active" && data.kind === "rule") unit.semantic = {
    modality: data.modality,
    scope: [...data.scope].sort(compareText),
    statement: data.statement,
    condition: data.condition,
    failure: data.failure,
  };
  return unit;
}

async function admittedSources(inputPath) {
  const parsed = await parseAuthorityPath(inputPath);
  const formatDiagnostics = formattingDiagnostics(parsed.documents, parsed.contract);
  if (formatDiagnostics.length > 0) return { ok: false, diagnostics: formatDiagnostics, parsed };
  const validation = validateAuthoritySources(parsed.sources, parsed.contract);
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics, parsed };
  return { ok: true, diagnostics: [], parsed };
}

export async function checkAuthorityPath(inputPath, { scopeBindings = null } = {}) {
  const result = await admittedSources(inputPath);
  if (!result.ok || scopeBindings === null) return {
    ok: result.ok,
    diagnostics: result.diagnostics,
    fileCount: result.parsed.files.length,
    unitCount: result.ok ? result.parsed.sources.length : 0,
  };
  const scopeValidation = await validateAuthorityScopeBindings(result.parsed.sources, scopeBindings);
  return {
    ok: scopeValidation.ok,
    diagnostics: scopeValidation.diagnostics,
    fileCount: result.parsed.files.length,
    unitCount: scopeValidation.ok ? result.parsed.sources.length : 0,
  };
}

export async function compileAuthorityPath(inputPath) {
  const admitted = await admittedSources(inputPath);
  if (!admitted.ok) return {
    ok: false,
    diagnostics: admitted.diagnostics,
    fileCount: admitted.parsed.files.length,
    unitCount: 0,
    ir: null,
    sourceMap: null,
  };
  const sources = [...admitted.parsed.sources].sort((left, right) => compareText(left.data.id, right.data.id));
  const ir = { units: sources.map(lowerUnit) };
  const mapped = buildSourceMap(sources, ir);
  if (!mapped.ok) return {
    ok: false,
    diagnostics: mapped.diagnostics,
    fileCount: admitted.parsed.files.length,
    unitCount: 0,
    ir: null,
    sourceMap: null,
  };
  return {
    ok: true,
    diagnostics: [],
    fileCount: admitted.parsed.files.length,
    unitCount: ir.units.length,
    ir,
    sourceMap: mapped.sourceMap,
  };
}
