import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML, { isMap, isScalar, isSeq } from "yaml";

import { compareText, createLocator, makeDiagnostic, portablePath, sortDiagnostics, sourcePointer } from "./diagnostics.mjs";

const SCOPE_BINDINGS_FORMAT = "nimicoding.scope-bindings/v1";
const contractPath = fileURLToPath(new URL("../../../contracts/authority-scope-bindings.schema.yaml", import.meta.url));
const LINE_BREAK = /[\u000A\u000B\u000C\u000D\u0085\u2028\u2029]/u;

let contractPromise = null;

function exactObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}

function pointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function nodeRange(node, locator) {
  const range = node?.range;
  if (!Array.isArray(range)) return locator.range(0);
  return locator.range(range[0], range[1] ?? range[0]);
}

function collectLocations(node, locator, pointer, locations) {
  if (!node) return;
  locations.set(pointer, nodeRange(node, locator));
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      const childPointer = `${pointer}/${pointerToken(key)}`;
      locations.set(childPointer, nodeRange(pair.value ?? pair.key, locator));
      collectLocations(pair.value, locator, childPointer, locations);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => collectLocations(item, locator, `${pointer}/${index}`, locations));
  }
}

async function loadContract() {
  if (!contractPromise) contractPromise = readFile(contractPath, "utf8").then((text) => {
    const contract = YAML.parse(text);
    if (contract?.version !== 1 || contract?.contract?.id !== "nimicoding.scope-bindings.v1") {
      throw new Error("installed scope binding contract is invalid");
    }
    return contract;
  });
  return contractPromise;
}

function scopeBindingDiagnostic(file, reason, location = null, code = "AUTH_SCOPE_BINDING_INVALID", repair = "declare the exact closed scope registry without inferring repository anchors") {
  return makeDiagnostic({
    code,
    file,
    range: location?.range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: location?.sourcePointer ?? "",
    reason,
    repair,
  });
}

function parsedLocation(parsed, pointer) {
  return {
    file: parsed.file,
    range: parsed.locations.get(pointer) ?? parsed.locations.get("") ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    sourcePointer: pointer,
  };
}

function syntaxLocation(error, file, locator) {
  const positions = Array.isArray(error?.pos) ? error.pos : [0, 0];
  return {
    file,
    range: locator.range(positions[0] ?? 0, positions[1] ?? positions[0] ?? 0),
    sourcePointer: "",
  };
}

function validText(value) {
  return typeof value === "string"
    && value.length > 0
    && value.isWellFormed()
    && !LINE_BREAK.test(value);
}

async function loadScopeBindings(file) {
  const absolute = path.resolve(file);
  const label = portablePath(absolute);
  let bytes;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "scope bindings must be one regular non-symlink YAML file")] };
    }
    bytes = await readFile(absolute);
  } catch (error) {
    return { ok: false, diagnostics: [scopeBindingDiagnostic(label, `scope binding file is not readable: ${error.message}`)] };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "scope binding bytes are not valid UTF-8")] };
  }
  const locator = createLocator(text);
  const documents = YAML.parseAllDocuments(text, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (documents.length !== 1 || documents[0].errors.length > 0 || !isMap(documents[0].contents)) {
    const error = documents[0]?.errors?.[0];
    const location = syntaxLocation(error, label, locator);
    const reason = documents.length !== 1
      ? "scope bindings must contain exactly one YAML document"
      : error ? `invalid scope binding YAML: ${error.message.split(" at line")[0]}` : "scope bindings require one top-level mapping";
    return { ok: false, diagnostics: [scopeBindingDiagnostic(label, reason, location)] };
  }
  let data;
  try {
    data = documents[0].toJS({ maxAliasCount: 0 });
  } catch (error) {
    return { ok: false, diagnostics: [scopeBindingDiagnostic(label, `invalid scope binding YAML: ${error.message}`)] };
  }
  const locations = new Map();
  collectLocations(documents[0].contents, locator, "", locations);
  const parsed = { file: label, locations, data };
  const contract = await loadContract();
  if (!exactObject(data, contract.fields.top)
    || data.format !== SCOPE_BINDINGS_FORMAT
    || !Array.isArray(data.scopes)
    || data.scopes.length === 0) {
    return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "scope bindings require exact format and one non-empty scopes sequence", parsedLocation(parsed, ""))] };
  }
  const scopes = [];
  const seenScopes = new Set();
  for (let index = 0; index < data.scopes.length; index += 1) {
    const value = data.scopes[index];
    const pointer = `/scopes/${index}`;
    if (!exactObject(value, contract.fields.scope)) {
      return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "each scope entry requires exact scope and bindings fields", parsedLocation(parsed, pointer))] };
    }
    if (!validText(value.scope)) {
      return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "scope must be one non-empty text line", parsedLocation(parsed, `${pointer}/scope`))] };
    }
    if (seenScopes.has(value.scope)) {
      return { ok: false, diagnostics: [scopeBindingDiagnostic(label, `duplicate registered scope: ${value.scope}`, parsedLocation(parsed, `${pointer}/scope`))] };
    }
    seenScopes.add(value.scope);
    if (!Array.isArray(value.bindings) || value.bindings.length === 0) {
      return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "scope bindings must be a non-empty sequence", parsedLocation(parsed, `${pointer}/bindings`))] };
    }
    const bindings = [];
    for (let bindingIndex = 0; bindingIndex < value.bindings.length; bindingIndex += 1) {
      const binding = value.bindings[bindingIndex];
      const bindingPointer = `${pointer}/bindings/${bindingIndex}`;
      if (!exactObject(binding, contract.fields.binding)) {
        return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "each scope binding requires exact kind and value fields", parsedLocation(parsed, bindingPointer))] };
      }
      if (!contract.binding_kinds.includes(binding.kind)) {
        return { ok: false, diagnostics: [scopeBindingDiagnostic(label, `scope binding kind must be one of: ${contract.binding_kinds.join(", ")}`, parsedLocation(parsed, `${bindingPointer}/kind`))] };
      }
      if (!validText(binding.value)) {
        return { ok: false, diagnostics: [scopeBindingDiagnostic(label, "scope binding value must be one non-empty text line", parsedLocation(parsed, `${bindingPointer}/value`))] };
      }
      bindings.push({
        kind: binding.kind,
        value: binding.value,
        location: parsedLocation(parsed, `${bindingPointer}/value`),
      });
    }
    scopes.push({ scope: value.scope, location: parsedLocation(parsed, `${pointer}/scope`), bindings });
  }
  scopes.sort((left, right) => compareText(left.scope, right.scope));
  return { ok: true, diagnostics: [], scopes };
}

function sourceRange(source, pointer) {
  return source.locations.get(pointer) ?? source.locations.get("") ?? source.locator.range(0);
}

export async function validateAuthorityScopeBindings(sources, bindingsPath) {
  const parsed = await loadScopeBindings(bindingsPath);
  if (!parsed.ok) return parsed;
  const registered = new Set(parsed.scopes.map((entry) => entry.scope));
  const used = new Set();
  const diagnostics = [];
  for (const source of sources) {
    if (source.data.kind !== "rule" || source.data.lifecycle !== "active") continue;
    source.data.scope.forEach((scope, index) => {
      used.add(scope);
      if (registered.has(scope)) return;
      const pointer = `/scope/${index}`;
      diagnostics.push(makeDiagnostic({
        code: "AUTH_SCOPE_UNREGISTERED",
        file: source.file,
        range: sourceRange(source, pointer),
        pointer: sourcePointer(source, pointer),
        reason: `active rule ${source.data.id} uses unregistered scope: ${scope}`,
        repair: "register the exact scope and its declared bindings; repository anchor resolution is not performed by check",
      }));
    });
  }
  for (const entry of parsed.scopes) {
    if (used.has(entry.scope)) continue;
    diagnostics.push(scopeBindingDiagnostic(
      entry.location.file,
      `registered scope has no active rule use: ${entry.scope}`,
      entry.location,
      "AUTH_SCOPE_BINDING_UNUSED",
      "remove the dead registration or declare an active rule use only from product authority",
    ));
  }
  return { ok: diagnostics.length === 0, diagnostics: sortDiagnostics(diagnostics) };
}

export { loadScopeBindings, SCOPE_BINDINGS_FORMAT };
