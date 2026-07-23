import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, makeDiagnostic, sortDiagnostics } from "./diagnostics.mjs";
import { AuthorityInputError } from "./format.mjs";
import { AuthorityReviewRefusal, listGitTrackedFiles } from "./git-snapshot.mjs";
import { loadScopeBindings } from "./scope-bindings.mjs";

const ANCHORS_FORMAT = "nimicoding.authority-anchors/v1";
const CODE_EXTENSIONS = ["mjs", "js", "ts", "tsx", "rs", "go", "yaml", "yml", "md", "json", "proto", "ps1"];
const SCRIPT_NAME = /^[a-z][a-z0-9:-]*$/;
const NON_WHITESPACE = /\S+/gu;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const AUTHORITY_ANCHOR_GRAMMAR_HELP = [
  "Authority anchors use a closed lexical grammar over active statement, condition, failure, and meaning fields:",
  `  A: a maximal non-whitespace token containing "/" and ending exactly in .<${CODE_EXTENSIONS.join("|")}>.`,
  "  B: pnpm, one ASCII space, and a maximal non-whitespace script-name token; the name must contain ':' or fully match [a-z][a-z0-9:-]*.",
  "Tokens are checked exactly without path normalization or command execution.",
].join("\n");

function validBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function baseDiagnostic(code, reason, repair, file = ".", range = null, pointer = "") {
  return makeDiagnostic({
    code,
    file,
    range: range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer,
    reason,
    repair,
  });
}

function budgetDiagnostic(kind, required, admitted, mapped = null) {
  return baseDiagnostic(
    "AUTH_ANCHOR_BUDGET",
    `complete authority anchor validation requires ${required} ${kind} but ${kind === "UTF-8 bytes" ? "max-bytes" : kind === "active units" ? "max-units" : "max-anchors"} is ${admitted}`,
    "increase the explicit anchor budget; partial lexical anchor validation is forbidden",
    mapped?.file ?? ".",
    mapped?.range,
    mapped?.sourcePointer ?? "",
  );
}

function refused(diagnostics, { fileCount = 0, anchorsBytes = 0 } = {}) {
  return {
    ok: false,
    complete: false,
    partial: false,
    diagnostics: sortDiagnostics(diagnostics),
    fileCount,
    unitCount: 0,
    anchorsChecked: 0,
    anchorsBytes,
  };
}

function fieldLocation(compiled, unitIndex, field) {
  return compiled.sourceMap.fields[`/units/${unitIndex}/semantic/${field}`] ?? null;
}

function unitLocation(compiled, unitIndex) {
  return compiled.sourceMap.fields[`/units/${unitIndex}/id`] ?? null;
}

function tokenRecords(text) {
  return [...text.matchAll(NON_WHITESPACE)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

function isPathAnchor(token) {
  return token.includes("/") && CODE_EXTENSIONS.some((extension) => token.endsWith(`.${extension}`));
}

export function extractLexicalAnchors(text) {
  const tokens = tokenRecords(text);
  const anchors = [];
  for (const token of tokens) {
    if (isPathAnchor(token.text)) anchors.push({ type: "path", text: token.text });
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const command = tokens[index];
    const script = tokens[index + 1];
    if (command.text !== "pnpm" || text.slice(command.end, script.start) !== " ") continue;
    if (!script.text.includes(":") && !SCRIPT_NAME.test(script.text)) continue;
    anchors.push({ type: "script", text: `pnpm ${script.text}`, script: script.text });
  }
  return anchors;
}

function compareAnchor(left, right) {
  return compareText(left.unitId, right.unitId)
    || compareText(left.text, right.text)
    || compareText(left.field, right.field)
    || compareText(left.type, right.type);
}

function extractCorpusAnchors(compiled) {
  const active = [];
  const anchors = [];
  compiled.ir.units.forEach((unit, unitIndex) => {
    if (unit.lifecycle !== "active") return;
    active.push({ unit, unitIndex });
    const fields = unit.kind === "definition" ? ["meaning"] : ["statement", "condition", "failure"];
    for (const field of fields) {
      for (const anchor of extractLexicalAnchors(unit.semantic[field])) {
        anchors.push({
          ...anchor,
          unitId: unit.id,
          field,
          location: fieldLocation(compiled, unitIndex, field),
        });
      }
    }
  });
  anchors.sort(compareAnchor);
  return { active, anchors };
}

function anchorDiagnostic(anchor, code, reason, repair) {
  return {
    ...baseDiagnostic(
      code,
      reason,
      repair,
      anchor.location?.file ?? ".",
      anchor.location?.range,
      anchor.location?.sourcePointer ?? "",
    ),
    unitId: anchor.unitId,
    field: anchor.field,
    anchor: anchor.text,
  };
}

function globRegularExpression(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

function scopeGlobDiagnostics(scopes, trackedFiles) {
  const diagnostics = [];
  for (const entry of scopes) {
    for (const binding of entry.bindings) {
      if (binding.kind !== "path_glob") continue;
      const matches = globRegularExpression(binding.value);
      if (trackedFiles.some((file) => matches.test(file))) continue;
      diagnostics.push({
        ...baseDiagnostic(
          "AUTH_ANCHOR_SCOPE_GLOB_UNRESOLVED",
          `scope path_glob matches no Git tracked file: scope=${entry.scope}; glob=${binding.value}`,
          "correct the explicit scope path_glob or add the intended file to the Git index; do not infer a repository binding",
          binding.location.file,
          binding.location.range,
          binding.location.sourcePointer,
        ),
        scope: entry.scope,
        glob: binding.value,
      });
    }
  }
  return diagnostics;
}

async function repositoryScriptNames(repository) {
  const manifest = path.join(repository, "package.json");
  let bytes;
  try {
    bytes = await readFile(manifest);
  } catch (error) {
    return { names: new Set(), error: `repository root package.json is not readable: ${error.message}` };
  }
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { names: new Set(), error: "repository root package.json is not valid UTF-8" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { names: new Set(), error: `repository root package.json is not valid JSON: ${error.message}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.scripts === null || typeof value.scripts !== "object" || Array.isArray(value.scripts)) {
    return { names: new Set(), error: "repository root package.json requires one scripts object" };
  }
  return { names: new Set(Object.keys(value.scripts)), error: null };
}

function compareAnchorDiagnostic(left, right) {
  const leftAnchor = left.unitId !== undefined;
  const rightAnchor = right.unitId !== undefined;
  if (leftAnchor && rightAnchor) {
    return compareText(left.unitId, right.unitId)
      || compareText(left.anchor, right.anchor)
      || compareText(left.field, right.field)
      || compareText(left.code, right.code);
  }
  if (leftAnchor !== rightAnchor) return leftAnchor ? -1 : 1;
  if (left.scope !== undefined && right.scope !== undefined) {
    return compareText(left.scope, right.scope) || compareText(left.glob, right.glob);
  }
  return compareText(left.path, right.path)
    || left.range.start.line - right.range.start.line
    || left.range.start.column - right.range.start.column
    || compareText(left.code, right.code);
}

function canonicalAnchorsBytes(summary, diagnostics) {
  return Buffer.byteLength(JSON.stringify({
    format: ANCHORS_FORMAT,
    complete: true,
    summary,
    diagnostics,
  }), "utf8");
}

function corpusInputDiagnostic(error) {
  return baseDiagnostic(
    "AUTH_ANCHOR_CORPUS_INVALID",
    error.message,
    "provide one complete admitted canonical authority corpus; partial or unsupported input is forbidden",
  );
}

function repositoryDiagnostic(error) {
  return baseDiagnostic(
    "AUTH_ANCHOR_REPOSITORY_INVALID",
    error.message,
    "provide one exact readable Git worktree root; lexical anchors are never checked against a partial repository inventory",
    error.file ?? ".",
  );
}

export async function anchorsAuthorityRepository(repositoryPath, specPath, scopeBindingsPath, { maxUnits, maxAnchors, maxBytes }) {
  if (![maxUnits, maxAnchors, maxBytes].every(validBudget)) {
    return refused([baseDiagnostic(
      "AUTH_ANCHOR_BUDGET",
      "authority anchor budgets must be positive safe integers",
      "provide explicit positive safe max-units, max-anchors, and max-bytes budgets",
    )]);
  }

  let compiled;
  try {
    compiled = await compileAuthorityPath(specPath);
  } catch (error) {
    if (error instanceof AuthorityInputError) return refused([corpusInputDiagnostic(error)]);
    throw error;
  }
  if (!compiled.ok) return refused(compiled.diagnostics, { fileCount: compiled.fileCount });

  const extracted = extractCorpusAnchors(compiled);
  if (extracted.active.length > maxUnits) {
    return refused([budgetDiagnostic(
      "active units",
      extracted.active.length,
      maxUnits,
      unitLocation(compiled, extracted.active[0]?.unitIndex ?? 0),
    )], { fileCount: compiled.fileCount });
  }

  let scopes = [];
  if (scopeBindingsPath !== null) {
    const parsed = await loadScopeBindings(scopeBindingsPath);
    if (!parsed.ok) return refused(parsed.diagnostics, { fileCount: compiled.fileCount });
    scopes = parsed.scopes;
  }

  if (extracted.anchors.length > maxAnchors) {
    return refused([budgetDiagnostic(
      "lexical anchors",
      extracted.anchors.length,
      maxAnchors,
      extracted.anchors[0]?.location,
    )], { fileCount: compiled.fileCount });
  }

  let inventory;
  try {
    inventory = await listGitTrackedFiles(repositoryPath);
  } catch (error) {
    if (error instanceof AuthorityReviewRefusal) return refused([repositoryDiagnostic(error)], { fileCount: compiled.fileCount });
    throw error;
  }
  const tracked = new Set(inventory.files);
  const diagnostics = scopeGlobDiagnostics(scopes, inventory.files);
  const scriptAnchors = extracted.anchors.filter((anchor) => anchor.type === "script");
  const scripts = scriptAnchors.length > 0
    ? await repositoryScriptNames(inventory.repository)
    : { names: new Set(), error: null };

  for (const anchor of extracted.anchors) {
    if (anchor.type === "path" && !tracked.has(anchor.text)) {
      diagnostics.push(anchorDiagnostic(
        anchor,
        "AUTH_ANCHOR_PATH_UNRESOLVED",
        `active unit ${anchor.unitId} field ${anchor.field} references a path anchor that is not a Git tracked file: ${anchor.text}`,
        "correct the exact lexical path or add the intended file to the Git index; path normalization and inference are forbidden",
      ));
    } else if (anchor.type === "script" && !scripts.names.has(anchor.script)) {
      const detail = scripts.error === null ? "is absent from repository root package.json scripts" : `cannot be resolved because ${scripts.error}`;
      diagnostics.push(anchorDiagnostic(
        anchor,
        "AUTH_ANCHOR_SCRIPT_UNRESOLVED",
        `active unit ${anchor.unitId} field ${anchor.field} references script ${anchor.text}, which ${detail}`,
        "declare the exact repository-root package script or correct the lexical anchor; no command is executed",
      ));
    }
  }
  diagnostics.sort(compareAnchorDiagnostic);
  const summary = {
    units: extracted.active.length,
    anchorsChecked: extracted.anchors.length,
    diagnostics: diagnostics.length,
  };
  const anchorsBytes = canonicalAnchorsBytes(summary, diagnostics);
  if (anchorsBytes > maxBytes) {
    return refused([budgetDiagnostic("UTF-8 bytes", anchorsBytes, maxBytes)], {
      fileCount: compiled.fileCount,
      anchorsBytes,
    });
  }
  return {
    ok: diagnostics.length === 0,
    complete: true,
    partial: false,
    diagnostics,
    fileCount: compiled.fileCount,
    unitCount: extracted.active.length,
    anchorsChecked: extracted.anchors.length,
    anchorsBytes,
  };
}

export { ANCHORS_FORMAT, CODE_EXTENSIONS };
