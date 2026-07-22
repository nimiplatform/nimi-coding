import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import YAML, { isAlias, isMap, isScalar, isSeq, visit } from "yaml";

import { compareText, createLocator, makeDiagnostic, portablePath, REPAIRS } from "./diagnostics.mjs";

const CONTRACT_PATH = fileURLToPath(new URL("../../../contracts/authority-source.schema.yaml", import.meta.url));
let contractPromise = null;

export async function loadAuthorityContract() {
  if (!contractPromise) {
    contractPromise = readFile(CONTRACT_PATH, "utf8").then((text) => {
      const value = YAML.parse(text);
      if (value?.version !== 1 || value?.contract?.id !== "nimicoding.authority-source.v1") {
        throw new Error("installed authority source contract is invalid");
      }
      return value;
    });
  }
  return contractPromise;
}

function pointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function nodeRange(node, locator, offset) {
  const range = node?.range;
  if (!Array.isArray(range)) return locator.range(offset, offset);
  return locator.range(offset + range[0], offset + (range[1] ?? range[0]));
}

function collectLocations(node, locator, offset, pointer, locations, keyLocations) {
  if (!node) return;
  locations.set(pointer, nodeRange(node, locator, offset));
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      const childPointer = `${pointer}/${pointerToken(key)}`;
      keyLocations.set(childPointer, nodeRange(pair.key, locator, offset));
      locations.set(childPointer, nodeRange(pair.value ?? pair.key, locator, offset));
      collectLocations(pair.value, locator, offset, childPointer, locations, keyLocations);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => collectLocations(item, locator, offset, `${pointer}/${index}`, locations, keyLocations));
  }
}

function zeroAt(position) {
  return { start: position, end: position };
}

export function buildInsertionPoints(data, locations, keyLocations, keyOrder) {
  const insertionPoints = new Map();
  const rootEnd = locations.get("")?.end ?? { line: 1, column: 1 };
  for (let index = 0; index < keyOrder.length; index += 1) {
    const field = keyOrder[index];
    if (Object.hasOwn(data, field)) continue;
    const nextField = keyOrder.slice(index + 1).find((candidate) => keyLocations.has(`/${candidate}`));
    insertionPoints.set(`/${field}`, nextField ? zeroAt(keyLocations.get(`/${nextField}`).start) : zeroAt(rootEnd));
  }
  if (Array.isArray(data.relations)) {
    data.relations.forEach((relation, index) => {
      if (!relation || typeof relation !== "object" || Array.isArray(relation)) return;
      const pointer = `/relations/${index}`;
      const relationEnd = locations.get(pointer)?.end ?? rootEnd;
      if (!Object.hasOwn(relation, "type")) {
        insertionPoints.set(`${pointer}/type`, keyLocations.has(`${pointer}/target`)
          ? zeroAt(keyLocations.get(`${pointer}/target`).start)
          : zeroAt(relationEnd));
      }
      if (!Object.hasOwn(relation, "target")) insertionPoints.set(`${pointer}/target`, zeroAt(relationEnd));
    });
  }
  return insertionPoints;
}

function yamlErrorDiagnostic(error, file, locator, offset) {
  const positions = Array.isArray(error.pos) ? error.pos : [0, 0];
  const duplicate = /keys must be unique|duplicate key/i.test(error.message);
  return makeDiagnostic({
    code: duplicate ? "AUTH_DUPLICATE_KEY" : "AUTH_SYNTAX_UNSUPPORTED",
    file,
    range: locator.range(offset + positions[0], offset + (positions[1] ?? positions[0])),
    reason: duplicate ? "YAML mapping keys must be unique" : `unsupported YAML syntax: ${error.message.split(" at line")[0]}`,
    repair: duplicate ? REPAIRS.duplicate : REPAIRS.structural,
  });
}

export function parseRestrictedYaml(text, absolutePath, options = {}) {
  const offset = options.offset ?? 0;
  const fullText = options.fullText ?? text;
  const file = portablePath(absolutePath, options.cwd);
  const locator = createLocator(fullText);
  const diagnostics = [];
  const documents = YAML.parseAllDocuments(text, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (documents.length !== 1) {
    diagnostics.push(makeDiagnostic({
      code: "AUTH_SYNTAX_UNSUPPORTED",
      file,
      range: locator.range(offset, offset + text.length),
      reason: "authority source must contain exactly one YAML document",
      repair: REPAIRS.structural,
    }));
  }
  const document = documents[0];
  for (const error of document?.errors ?? []) diagnostics.push(yamlErrorDiagnostic(error, file, locator, offset));
  if (diagnostics.length > 0 || !document) {
    return { ok: false, file, locator, diagnostics, locations: new Map(), keyLocations: new Map(), insertionPoints: new Map(), data: null };
  }
  if (!isMap(document.contents)) {
    diagnostics.push(makeDiagnostic({
      code: "AUTH_SYNTAX_UNSUPPORTED",
      file,
      range: nodeRange(document.contents, locator, offset),
      reason: "authority YAML must be one top-level mapping",
      repair: REPAIRS.structural,
    }));
  }
  if (/^%/.test(text)) {
    diagnostics.push(makeDiagnostic({
      code: "AUTH_SYNTAX_UNSUPPORTED",
      file,
      range: locator.range(offset, offset + Math.min(text.length, text.indexOf("\n") + 1 || text.length)),
      reason: "YAML directives are not admitted",
      repair: REPAIRS.structural,
    }));
  }
  if (document.comment || document.commentBefore) {
    const searchStart = document.contents?.range?.[2] ?? document.contents?.range?.[1] ?? 0;
    const commentStart = text.indexOf("#", searchStart);
    diagnostics.push(makeDiagnostic({
      code: "AUTH_SYNTAX_UNSUPPORTED",
      file,
      range: locator.range(offset + Math.max(0, commentStart), offset + (commentStart < 0 ? text.length : commentStart + 1)),
      reason: "YAML comments are not admitted in canonical authority",
      repair: REPAIRS.structural,
    }));
  }
  if (document.contents) {
    visit(document, (_key, node) => {
      if (!node || typeof node !== "object") return;
      let reason = null;
      if (node.comment || node.commentBefore) reason = "YAML comments are not admitted in canonical authority";
      else if (isAlias(node)) reason = "YAML aliases are not admitted";
      else if (node.anchor) reason = "YAML anchors are not admitted";
      else if (node.tag) reason = "explicit YAML tags are not admitted";
      if (reason) diagnostics.push(makeDiagnostic({
        code: "AUTH_SYNTAX_UNSUPPORTED",
        file,
        range: nodeRange(node, locator, offset),
        reason,
        repair: REPAIRS.structural,
      }));
      if (node.constructor?.name === "Pair" && !isScalar(node.key)) {
        diagnostics.push(makeDiagnostic({
          code: "AUTH_SYNTAX_UNSUPPORTED",
          file,
          range: nodeRange(node.key, locator, offset),
          reason: "complex YAML mapping keys are not admitted",
          repair: REPAIRS.structural,
        }));
      }
    });
  }
  if (diagnostics.length > 0) return { ok: false, file, locator, diagnostics, locations: new Map(), keyLocations: new Map(), insertionPoints: new Map(), data: null };
  const locations = new Map();
  const keyLocations = new Map();
  collectLocations(document.contents, locator, offset, "", locations, keyLocations);
  const data = document.toJS({ mapAsMap: false });
  const insertionPoints = buildInsertionPoints(data, locations, keyLocations, options.keyOrder ?? []);
  return {
    ok: true,
    file,
    locator,
    diagnostics,
    locations,
    keyLocations,
    insertionPoints,
    data,
    yamlDocument: document,
    sourceText: fullText,
  };
}

export const YAML_CONTAINER_KEY_ORDER = ["format", "units"];
export const YAML_UNIT_KEY_ORDER = [
  "id", "kind", "owner", "lifecycle", "title", "meaning", "modality", "scope",
  "statement", "condition", "failure", "reason", "relations",
];
export const FRONTMATTER_KEY_ORDER = ["format", "id", "kind", "owner", "lifecycle", "modality", "scope", "relations"];

function orderedObject(data, order) {
  return Object.fromEntries(order.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
}

function normalizedUnit(data, order = YAML_UNIT_KEY_ORDER) {
  const next = orderedObject(data, order);
  if (Array.isArray(next.scope)) next.scope = [...next.scope].sort(compareText);
  if (Array.isArray(next.relations)) {
    next.relations = next.relations.map((entry) => ({ type: entry.type, target: entry.target })).sort((left, right) => (
      compareText(left.type, right.type) || compareText(left.target, right.target)
    ));
  }
  return next;
}

export function normalizedData(data, { frontmatter = false, container = false } = {}) {
  if (frontmatter === container) throw new TypeError("canonical YAML serialization requires exactly one explicit profile: container or frontmatter");
  if (container) return {
    ...(Object.hasOwn(data, "format") ? { format: data.format } : {}),
    ...(Object.hasOwn(data, "units") ? { units: Array.isArray(data.units) ? data.units.map((unit) => normalizedUnit(unit)) : data.units } : {}),
  };
  return normalizedUnit(data, FRONTMATTER_KEY_ORDER);
}

export function stringifyCanonicalYaml(data, options = {}) {
  return YAML.stringify(normalizedData(data, options), {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

function localMap(map, prefix) {
  return new Map([...map.entries()]
    .filter(([pointer]) => pointer === prefix || pointer.startsWith(`${prefix}/`))
    .map(([pointer, range]) => [pointer.slice(prefix.length), range]));
}

function yamlUnitSource(parsed, index) {
  const prefix = `/units/${index}`;
  const locations = localMap(parsed.locations, prefix);
  const keyLocations = localMap(parsed.keyLocations, prefix);
  const data = parsed.data.units[index];
  return {
    ok: true,
    file: parsed.file,
    locator: parsed.locator,
    diagnostics: [],
    locations,
    keyLocations,
    insertionPoints: data && typeof data === "object" && !Array.isArray(data)
      ? buildInsertionPoints(data, locations, keyLocations, YAML_UNIT_KEY_ORDER)
      : new Map(),
    data,
    profile: "yaml",
    sourcePrefix: prefix,
    sourceIndex: index,
    sourceText: parsed.sourceText,
  };
}

export function parseYamlAuthority(text, absolutePath, options = {}) {
  const parsed = parseRestrictedYaml(text, absolutePath, { ...options, keyOrder: YAML_CONTAINER_KEY_ORDER });
  if (!parsed.ok) return { ...parsed, profile: "yaml", isDocument: true, units: [] };
  const units = Array.isArray(parsed.data?.units)
    ? parsed.data.units.map((_unit, index) => yamlUnitSource(parsed, index))
    : [];
  return { ...parsed, profile: "yaml", isDocument: true, units };
}
