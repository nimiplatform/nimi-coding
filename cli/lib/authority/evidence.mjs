import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML, { isMap, isScalar, isSeq } from "yaml";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, createLocator, makeDiagnostic, portablePath, sortDiagnostics } from "./diagnostics.mjs";
import { AuthorityInputError } from "./format.mjs";
import { withGitEvidenceSnapshot } from "./evidence-snapshot.mjs";
import { AuthorityReviewRefusal, captureStableRegularFile } from "./git-snapshot.mjs";
import { buildAuthorityGraphSnapshot } from "./graph.mjs";

const EVIDENCE_FORMAT = "nimicoding.authority-evidence/v1";
const BINDING_FORMAT = "nimicoding.authority-evidence-bindings/v1";
const RESULT_FORMAT = "nimicoding.authority-evidence-probe-results/v1";
const PACKAGE_PROBE = "package-script-target-reachability/v1";
const BINDING_IDENTITY_FORMAT = "nimicoding.authority-evidence-binding/v1";
const REPOSITORY_INPUT_IDENTITY_FORMAT = "nimicoding.repository-evidence-input/v1";
const RESULT_CONTENT_IDENTITY_FORMAT = "nimicoding.authority-evidence-probe-result-content/v1";
const FINGERPRINT_FORMAT = "nimicoding.authority-evidence-fingerprint/v1";
const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/;
const VERSION = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/;
const bindingContractPath = fileURLToPath(new URL("../../../contracts/authority-evidence-bindings.schema.yaml", import.meta.url));
const resultContractPath = fileURLToPath(new URL("../../../contracts/authority-evidence-probe-results.schema.yaml", import.meta.url));
const UTF8 = new TextDecoder("utf-8", { fatal: true });

let contractsPromise = null;

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

async function loadContracts() {
  if (!contractsPromise) contractsPromise = Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(bindingContractPath, "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(resultContractPath, "utf8")),
  ]).then(([bindingText, resultText]) => {
    const binding = YAML.parse(bindingText);
    const result = YAML.parse(resultText);
    if (binding?.version !== 1 || binding?.contract?.id !== "nimicoding.authority-evidence-bindings.v1") {
      throw new Error("installed authority evidence binding contract is invalid");
    }
    if (result?.version !== 1 || result?.contract?.id !== "nimicoding.authority-evidence-probe-results.v1") {
      throw new Error("installed authority evidence result contract is invalid");
    }
    return { binding, result };
  });
  return contractsPromise;
}

function location(parsed, pointer) {
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

function evidenceDiagnostic(code, file, reason, at = null, repair = "declare one exact project-owned evidence binding without adding product semantics or executable behavior") {
  return makeDiagnostic({
    code,
    file,
    range: at?.range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: at?.sourcePointer ?? "",
    reason,
    repair,
  });
}

function bindingDiagnostic(file, reason, at = null) {
  return evidenceDiagnostic("AUTH_EVIDENCE_BINDING_INVALID", file, reason, at);
}

function resultDiagnostic(file, reason, at = null) {
  return evidenceDiagnostic(
    "AUTH_EVIDENCE_RESULT_INVALID",
    file,
    reason,
    at,
    "supply one closed external result whose repository, authority, binding, and probe identities match this exact evidence input",
  );
}

function parseYamlBytes(bytes, file, kind) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    const diagnostic = kind === "binding" ? bindingDiagnostic(file, "evidence binding bytes are not valid UTF-8") : resultDiagnostic(file, "evidence probe result bytes are not valid UTF-8");
    return { ok: false, diagnostics: [diagnostic] };
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
    const at = syntaxLocation(error, file, locator);
    const reason = documents.length !== 1
      ? `evidence ${kind} must contain exactly one YAML document`
      : error ? `invalid evidence ${kind} YAML: ${error.message.split(" at line")[0]}` : `evidence ${kind} requires one top-level mapping`;
    return { ok: false, diagnostics: [kind === "binding" ? bindingDiagnostic(file, reason, at) : resultDiagnostic(file, reason, at)] };
  }
  let data;
  try {
    data = documents[0].toJS({ maxAliasCount: 0 });
  } catch (error) {
    const diagnostic = kind === "binding" ? bindingDiagnostic(file, `invalid evidence binding YAML: ${error.message}`) : resultDiagnostic(file, `invalid evidence probe result YAML: ${error.message}`);
    return { ok: false, diagnostics: [diagnostic] };
  }
  const locations = new Map();
  collectLocations(documents[0].contents, locator, "", locations);
  return { ok: true, parsed: { data, file, text, locator, locations } };
}

function validRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC") || value.startsWith("-") || value.includes("\\") || value.includes("\0") || value.includes("\n") || value.includes("\r") || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function pathCollisionKey(value) {
  return value.normalize("NFC").toLowerCase();
}

export async function parseEvidenceBindings(bytes, file) {
  const decoded = parseYamlBytes(bytes, file, "binding");
  if (!decoded.ok) return decoded;
  const { binding: contract } = await loadContracts();
  const parsed = decoded.parsed;
  const data = parsed.data;
  if (!exactObject(data, contract.fields.top) || data.format !== BINDING_FORMAT || !Array.isArray(data.required_bindings) || data.required_bindings.length === 0 || !Array.isArray(data.bindings)) {
    return { ok: false, diagnostics: [bindingDiagnostic(file, "evidence bindings require exact format, required_bindings, and bindings fields", location(parsed, ""))] };
  }
  const required = [];
  const requiredIds = new Set();
  for (let index = 0; index < data.required_bindings.length; index += 1) {
    const id = data.required_bindings[index];
    const pointer = `/required_bindings/${index}`;
    if (typeof id !== "string" || !IDENTIFIER.test(id)) return { ok: false, diagnostics: [bindingDiagnostic(file, "required evidence binding IDs must be exact dotted lowercase identifiers", location(parsed, pointer))] };
    if (requiredIds.has(id)) return { ok: false, diagnostics: [bindingDiagnostic(file, `duplicate required evidence binding ID: ${id}`, location(parsed, pointer))] };
    requiredIds.add(id);
    required.push({ id, location: location(parsed, pointer) });
  }
  const bindings = [];
  const bindingIds = new Set();
  const globalLocatorPaths = new Map();
  for (let index = 0; index < data.bindings.length; index += 1) {
    const value = data.bindings[index];
    const pointer = `/bindings/${index}`;
    if (!exactObject(value, contract.fields.binding)) return { ok: false, diagnostics: [bindingDiagnostic(file, "each evidence binding requires exact id, authority, probe, manifest, command, tests, and external_probe fields", location(parsed, pointer))] };
    if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) return { ok: false, diagnostics: [bindingDiagnostic(file, "evidence binding id must be one exact dotted lowercase identifier", location(parsed, `${pointer}/id`))] };
    if (bindingIds.has(value.id)) return { ok: false, diagnostics: [bindingDiagnostic(file, `duplicate evidence binding ID: ${value.id}`, location(parsed, `${pointer}/id`))] };
    bindingIds.add(value.id);
    if (!exactObject(value.authority, contract.fields.authority)
      || typeof value.authority.unit !== "string" || !IDENTIFIER.test(value.authority.unit)
      || typeof value.authority.scope !== "string" || !IDENTIFIER.test(value.authority.scope)) {
      return { ok: false, diagnostics: [bindingDiagnostic(file, "binding authority requires one exact active rule ID and one exact declared scope", location(parsed, `${pointer}/authority`))] };
    }
    if (value.probe !== PACKAGE_PROBE) return { ok: false, diagnostics: [bindingDiagnostic(file, `unknown package evidence probe: ${String(value.probe)}`, location(parsed, `${pointer}/probe`))] };
    if (!validRepositoryPath(value.manifest)) return { ok: false, diagnostics: [bindingDiagnostic(file, "binding manifest must be one normalized safe repository-relative path", location(parsed, `${pointer}/manifest`))] };
    if (!exactObject(value.command, contract.fields.command) || typeof value.command.script !== "string" || !SCRIPT_NAME.test(value.command.script) || !validRepositoryPath(value.command.target)) {
      return { ok: false, diagnostics: [bindingDiagnostic(file, "binding command requires one exact safe script name and repository-relative target", location(parsed, `${pointer}/command`))] };
    }
    if (!exactObject(value.tests, contract.fields.tests) || typeof value.tests.script !== "string" || !SCRIPT_NAME.test(value.tests.script) || !Array.isArray(value.tests.targets) || value.tests.targets.length === 0) {
      return { ok: false, diagnostics: [bindingDiagnostic(file, "binding tests require one exact safe script name and a non-empty target list", location(parsed, `${pointer}/tests`))] };
    }
    if (value.tests.script === value.command.script) {
      return { ok: false, diagnostics: [bindingDiagnostic(file, "binding command and test script keys must be distinct", location(parsed, `${pointer}/tests/script`))] };
    }
    const testTargets = [];
    const targetPaths = new Set();
    for (let targetIndex = 0; targetIndex < value.tests.targets.length; targetIndex += 1) {
      const target = value.tests.targets[targetIndex];
      const targetPointer = `${pointer}/tests/targets/${targetIndex}`;
      if (!validRepositoryPath(target)) return { ok: false, diagnostics: [bindingDiagnostic(file, "test targets must be normalized safe repository-relative paths", location(parsed, targetPointer))] };
      const collision = pathCollisionKey(target);
      if (targetPaths.has(collision)) return { ok: false, diagnostics: [bindingDiagnostic(file, `duplicate or portable-colliding test target: ${target}`, location(parsed, targetPointer))] };
      targetPaths.add(collision);
      testTargets.push({ path: target, location: location(parsed, targetPointer) });
    }
    const locatorPaths = [value.manifest, value.command.target, ...testTargets.map((entry) => entry.path)];
    const locatorCollisions = new Set();
    for (const locatorPath of locatorPaths) {
      const collision = pathCollisionKey(locatorPath);
      if (locatorCollisions.has(collision)) return { ok: false, diagnostics: [bindingDiagnostic(file, `binding locator roles must resolve to distinct portable paths: ${locatorPath}`, location(parsed, pointer))] };
      locatorCollisions.add(collision);
    }
    for (const entry of [
      { path: value.manifest, location: location(parsed, `${pointer}/manifest`) },
      { path: value.command.target, location: location(parsed, `${pointer}/command/target`) },
      ...testTargets,
    ]) {
      const collision = pathCollisionKey(entry.path);
      const existing = globalLocatorPaths.get(collision);
      if (existing && existing.path !== entry.path) {
        return { ok: false, diagnostics: [bindingDiagnostic(file, `cross-binding repository locators must not portable-collide: ${existing.path} and ${entry.path}`, entry.location)] };
      }
      globalLocatorPaths.set(collision, entry);
    }
    let externalProbe = null;
    if (value.external_probe !== null) {
      if (!exactObject(value.external_probe, contract.fields.external_probe)
        || typeof value.external_probe.id !== "string" || !IDENTIFIER.test(value.external_probe.id)
        || typeof value.external_probe.version !== "string" || !VERSION.test(value.external_probe.version)
        || typeof value.external_probe.required !== "boolean") {
        return { ok: false, diagnostics: [bindingDiagnostic(file, "external_probe must be null or exact id, explicit version, and required fields", location(parsed, `${pointer}/external_probe`))] };
      }
      externalProbe = {
        ...value.external_probe,
        location: location(parsed, `${pointer}/external_probe`),
      };
    }
    bindings.push({
      id: value.id,
      authority: { unit: value.authority.unit, scope: value.authority.scope },
      probe: value.probe,
      manifest: value.manifest,
      command: value.command,
      tests: { script: value.tests.script, targets: testTargets },
      externalProbe,
      location: location(parsed, `${pointer}/id`),
      authorityLocation: location(parsed, `${pointer}/authority/unit`),
      scopeLocation: location(parsed, `${pointer}/authority/scope`),
      manifestLocation: location(parsed, `${pointer}/manifest`),
      commandScriptLocation: location(parsed, `${pointer}/command/script`),
      commandTargetLocation: location(parsed, `${pointer}/command/target`),
      testScriptLocation: location(parsed, `${pointer}/tests/script`),
    });
  }
  required.sort((left, right) => compareText(left.id, right.id));
  bindings.sort((left, right) => compareText(left.id, right.id));
  return { ok: true, diagnostics: [], required, bindings };
}

export async function parseEvidenceProbeResults(bytes, file) {
  const decoded = parseYamlBytes(bytes, file, "result");
  if (!decoded.ok) return decoded;
  const { result: contract } = await loadContracts();
  const parsed = decoded.parsed;
  const data = parsed.data;
  if (!exactObject(data, contract.fields.top) || data.format !== RESULT_FORMAT || !Array.isArray(data.results)) {
    return { ok: false, diagnostics: [resultDiagnostic(file, "probe results require exact format, authority_content_identity, repository_input_identity, binding_identity, and results fields", location(parsed, ""))] };
  }
  for (const [field, pointer] of [
    [data.authority_content_identity, "/authority_content_identity"],
    [data.repository_input_identity, "/repository_input_identity"],
    [data.binding_identity, "/binding_identity"],
  ]) {
    if (typeof field !== "string" || !SHA256_IDENTITY.test(field)) return { ok: false, diagnostics: [resultDiagnostic(file, "probe result identities must be sha256-prefixed lowercase hexadecimal values", location(parsed, pointer))] };
  }
  const results = [];
  const seen = new Set();
  for (let index = 0; index < data.results.length; index += 1) {
    const value = data.results[index];
    const pointer = `/results/${index}`;
    if (!exactObject(value, contract.fields.item) || !exactObject(value?.adapter, contract.fields.adapter)) return { ok: false, diagnostics: [resultDiagnostic(file, "each probe result requires exact binding, probe, version, adapter, execution, and outcome fields", location(parsed, pointer))] };
    if (typeof value.binding !== "string" || !IDENTIFIER.test(value.binding) || typeof value.probe !== "string" || !IDENTIFIER.test(value.probe) || typeof value.version !== "string" || !VERSION.test(value.version)) {
      return { ok: false, diagnostics: [resultDiagnostic(file, "probe result binding, probe, and version must be exact identifiers", location(parsed, pointer))] };
    }
    if (seen.has(value.binding)) return { ok: false, diagnostics: [resultDiagnostic(file, `duplicate external probe result for binding: ${value.binding}`, location(parsed, `${pointer}/binding`))] };
    seen.add(value.binding);
    if (typeof value.adapter.id !== "string" || !IDENTIFIER.test(value.adapter.id) || typeof value.adapter.version !== "string" || !VERSION.test(value.adapter.version)) {
      return { ok: false, diagnostics: [resultDiagnostic(file, "external adapter requires one exact identifier and explicit version", location(parsed, `${pointer}/adapter`))] };
    }
    if (!contract.execution.includes(value.execution)) return { ok: false, diagnostics: [resultDiagnostic(file, "external execution must be completed, failed, or unsupported", location(parsed, `${pointer}/execution`))] };
    const validOutcome = value.execution === "completed" ? ["passed", "failed"].includes(value.outcome) : value.outcome === null;
    if (!validOutcome) return { ok: false, diagnostics: [resultDiagnostic(file, "completed external execution requires passed or failed outcome; failed or unsupported execution requires null outcome", location(parsed, `${pointer}/outcome`))] };
    results.push({ ...value, location: location(parsed, pointer) });
  }
  results.sort((left, right) => compareText(left.binding, right.binding));
  return {
    ok: true,
    diagnostics: [],
    authorityContentIdentity: data.authority_content_identity,
    repositoryInputIdentity: data.repository_input_identity,
    bindingIdentity: data.binding_identity,
    results,
  };
}

function frame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function identity(domain, values) {
  const hash = createHash("sha256");
  frame(hash, domain);
  for (const value of values) frame(hash, value);
  return `sha256:${hash.digest("hex")}`;
}

export function evidenceBindingIdentity(bytes) {
  return identity(BINDING_IDENTITY_FORMAT, [bytes]);
}

export function evidenceRepositoryInputIdentity(locatorEntries) {
  const ordered = [...locatorEntries].sort((left, right) => compareText(left.path, right.path));
  const values = [String(ordered.length)];
  for (const entry of ordered) values.push(entry.path, entry.type, entry.bytes ?? Buffer.alloc(0));
  return identity(REPOSITORY_INPUT_IDENTITY_FORMAT, values);
}

export function evidenceProbeResultContentIdentity(bytes) {
  return identity(RESULT_CONTENT_IDENTITY_FORMAT, [bytes]);
}

function fingerprint(parts) {
  return identity(FINGERPRINT_FORMAT, parts);
}

function locatorPaths(parsedBindings) {
  const values = new Map();
  for (const binding of parsedBindings.bindings) {
    for (const value of [binding.manifest, binding.command.target, ...binding.tests.targets.map((target) => target.path)]) {
      const collision = pathCollisionKey(value);
      const existing = values.get(collision);
      if (existing && existing !== value) throw new Error("portable locator collision escaped binding validation");
      values.set(collision, value);
    }
  }
  return [...values.values()].sort(compareText);
}

function validBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function refused(diagnostics, evidenceBytes = 0) {
  return {
    ok: false,
    diagnostics: sortDiagnostics(diagnostics),
    fileCount: 0,
    unitCount: 0,
    evidenceBytes,
    evidence: null,
    partial: false,
  };
}

function budgetDiagnostic(kind, required, admitted, at = null) {
  return evidenceDiagnostic(
    "AUTH_EVIDENCE_BUDGET",
    at?.file ?? ".",
    `complete authority evidence requires ${required} ${kind} but the explicit budget is ${admitted}`,
    at,
    "increase the explicit evidence budget; partial locator, edge, input, or output evidence is forbidden",
  );
}

function snapshotDiagnostic(error) {
  const code = error.code === "AUTH_EVIDENCE_INPUT_BUDGET"
    ? "AUTH_EVIDENCE_BUDGET"
    : error.code?.startsWith("AUTH_EVIDENCE_") ? error.code : "AUTH_EVIDENCE_CAPTURE_INVALID";
  return evidenceDiagnostic(
    code,
    error.file ?? ".",
    error.message,
    null,
    "provide one complete stable repository evidence input; no partial evidence snapshot is admitted",
  );
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function portableLocation(file, range = null, sourcePointer = "") {
  return {
    file,
    range: range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    sourcePointer,
  };
}

function relatedLocation(role, value) {
  return { role, location: value };
}

function compareRelatedLocation(left, right) {
  return compareText(left.role, right.role)
    || compareText(left.location.file, right.location.file)
    || left.location.range.start.line - right.location.range.start.line
    || left.location.range.start.column - right.location.range.start.column
    || compareText(left.location.sourcePointer, right.location.sourcePointer);
}

function compareItem(left, right) {
  return compareText(left.binding, right.binding)
    || compareText(left.code, right.code)
    || compareText(left.logicalTarget ?? "", right.logicalTarget ?? "");
}

function commonItem(code, binding, basis, message, primaryLocation, relatedLocations, witness, logicalTarget = "") {
  return {
    code,
    fingerprint: fingerprint([code, PACKAGE_PROBE, binding.id, binding.authority.unit, binding.authority.scope, logicalTarget]),
    binding: binding.id,
    required: binding.required,
    authority: binding.authority.unit,
    scope: binding.authority.scope,
    basis,
    message,
    primaryLocation,
    relatedLocations: [...relatedLocations].sort(compareRelatedLocation),
    witness,
    logicalTarget,
  };
}

function requiredBindingGap(required) {
  const code = "AUTH_EVIDENCE_REQUIRED_BINDING_MISSING";
  return {
    code,
    fingerprint: fingerprint([code, required.id]),
    binding: required.id,
    required: true,
    authority: null,
    scope: null,
    basis: "required_coverage",
    message: `required authority evidence binding is missing: ${required.id}`,
    primaryLocation: required.location,
    relatedLocations: [],
    witness: { type: "required-binding", required: true, present: false },
    logicalTarget: required.id,
  };
}

function parseManifest(bytes, file) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { ok: false, reason: "manifest bytes are not valid UTF-8", location: portableLocation(file) };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `manifest is not valid JSON: ${error.message}`, location: portableLocation(file) };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "manifest JSON must be one top-level object", location: portableLocation(file) };
  }
  const locator = createLocator(text);
  const document = YAML.parseDocument(text, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    const error = document.errors[0];
    return { ok: false, reason: `manifest cannot be uniquely addressed: ${error?.message?.split(" at line")[0] ?? "invalid object"}`, location: portableLocation(file, syntaxLocation(error, file, locator).range) };
  }
  const scriptsPair = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === "scripts");
  if (!scriptsPair || !isMap(scriptsPair.value)) {
    return { ok: false, reason: "manifest requires one scripts object for this probe", location: portableLocation(file) };
  }
  function script(name) {
    const pair = scriptsPair.value.items.find((entry) => isScalar(entry.key) && entry.key.value === name);
    const pointer = `/scripts/${pointerToken(name)}`;
    if (!pair) return { state: "missing", value: null, location: portableLocation(file, nodeRange(scriptsPair.value, locator), pointer) };
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") {
      return { state: "unsupported", value: null, location: portableLocation(file, nodeRange(pair.value ?? pair.key, locator), pointer), reason: `manifest script ${name} must be one string` };
    }
    return { state: "present", value: pair.value.value, location: portableLocation(file, nodeRange(pair.value, locator), pointer) };
  }
  return { ok: true, script };
}

function scriptTokens(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(value)) return null;
  return value.split(" ");
}

function validScriptTarget(value) {
  return validRepositoryPath(value) && /^[A-Za-z0-9._/-]+$/.test(value);
}

function parseCommandScript(value) {
  const tokens = scriptTokens(value);
  if (!tokens || tokens.length !== 4 || tokens[0] !== "node" || tokens[1] !== "--import" || tokens[2] !== "tsx" || !validScriptTarget(tokens[3])) {
    return { ok: false, reason: "command script is outside the closed `node --import tsx <target>` grammar" };
  }
  return { ok: true, target: tokens[3] };
}

function parseTestScript(value) {
  const tokens = scriptTokens(value);
  if (!tokens || tokens.length < 5 || tokens[0] !== "pnpm" || tokens[1] !== "exec" || tokens[2] !== "vitest" || tokens[3] !== "run") {
    return { ok: false, reason: "test script is outside the closed `pnpm exec vitest run <targets...>` grammar" };
  }
  const targets = tokens.slice(4);
  if (targets.some((target) => !validScriptTarget(target)) || new Set(targets.map(pathCollisionKey)).size !== targets.length) {
    return { ok: false, reason: "test script targets must be unique safe repository-relative paths without flags, globs, quoting, or shell syntax" };
  }
  return { ok: true, targets };
}

function inputState(inputByPath, file) {
  const input = inputByPath.get(file);
  if (!input || input.role !== "locator") throw new Error(`captured evidence locator is missing from snapshot adapter output: ${file}`);
  return input;
}

function locatorRecord(id, role, file, input, declaredLocation) {
  return {
    id,
    role,
    path: file,
    existence: input.type === "regular-file" ? "present" : "missing",
    declarationLocation: declaredLocation,
    ...(input.type === "regular-file" ? { repositoryLocation: portableLocation(file) } : {}),
  };
}

function reachabilityFinding(binding, logicalTarget, message, primaryLocation, relatedLocations, witness) {
  return commonItem(
    "AUTH_EVIDENCE_REQUIRED_TARGET_UNREACHABLE",
    binding,
    "governance_bound_package_probe",
    message,
    primaryLocation,
    relatedLocations,
    witness,
    logicalTarget,
  );
}

function capabilityGap(binding, logicalTarget, message, primaryLocation, relatedLocations, witness) {
  return commonItem(
    "AUTH_EVIDENCE_PROBE_UNSUPPORTED",
    binding,
    "required_probe_capability",
    message,
    primaryLocation,
    relatedLocations,
    witness,
    logicalTarget,
  );
}

function proofEdge(id, source, target, basis, status, sourceLocation = null, targetLocation = null, extra = {}) {
  return { id, source, target, basis, status, sourceLocation, targetLocation, ...extra };
}

function compareProofEdge(left, right) {
  return compareText(left.source, right.source)
    || compareText(left.target, right.target)
    || compareText(left.id, right.id);
}

function evaluatePackageProbe(binding, authorityNode, inputByPath) {
  const observations = [];
  const findings = [];
  const gaps = [];
  const manifestInput = inputState(inputByPath, binding.manifest);
  const commandInput = inputState(inputByPath, binding.command.target);
  const testInputs = binding.tests.targets.map((target) => ({ target, input: inputState(inputByPath, target.path) }));
  const commandScriptLocator = {
    id: "command-script",
    role: "producer",
    path: `${binding.manifest}#scripts/${binding.command.script}`,
    existence: "indeterminate",
    declarationLocation: binding.commandScriptLocation,
  };
  const testScriptLocator = {
    id: "test-script",
    role: "test-producer",
    path: `${binding.manifest}#scripts/${binding.tests.script}`,
    existence: "indeterminate",
    declarationLocation: binding.testScriptLocation,
  };
  const locators = [
    {
      id: "authority",
      role: "authority",
      authorityId: binding.authority.unit,
      existence: "present",
      declarationLocation: binding.authorityLocation,
      repositoryLocation: authorityNode.node.location,
      scopeRepositoryLocation: authorityNode.scopeLocation,
    },
    locatorRecord("manifest", "manifest", binding.manifest, manifestInput, binding.manifestLocation),
    commandScriptLocator,
    locatorRecord("command-target", "implementation", binding.command.target, commandInput, binding.commandTargetLocation),
    testScriptLocator,
    ...testInputs.map(({ target, input }, index) => locatorRecord(`test-target-${index + 1}`, "test", target.path, input, target.location)),
  ];
  const baseRelated = [
    relatedLocation("authority", authorityNode.node.location),
    relatedLocation("authority-scope", authorityNode.scopeLocation),
    relatedLocation("binding", binding.location),
    relatedLocation("binding-manifest", binding.manifestLocation),
  ];
  if (commandInput.type !== "regular-file") {
    findings.push(reachabilityFinding(
      binding,
      "command-target",
      `bound command target is missing: ${binding.command.target}`,
      binding.commandTargetLocation,
      baseRelated,
      { type: "locator-existence", role: "implementation", path: binding.command.target, existence: "missing" },
    ));
  }
  for (let index = 0; index < testInputs.length; index += 1) {
    const target = testInputs[index];
    if (target.input.type === "regular-file") continue;
    findings.push(reachabilityFinding(
      binding,
      `test-target-${index + 1}`,
      `bound test target is missing: ${target.target.path}`,
      target.target.location,
      baseRelated,
      { type: "locator-existence", role: "test", path: target.target.path, existence: "missing" },
    ));
  }
  let manifest = null;
  if (manifestInput.type !== "regular-file") {
    findings.push(reachabilityFinding(
      binding,
      "manifest",
      `bound manifest locator is missing: ${binding.manifest}`,
      binding.manifestLocation,
      baseRelated,
      { type: "locator-existence", role: "manifest", path: binding.manifest, existence: "missing" },
    ));
  } else {
    manifest = parseManifest(manifestInput.bytes, binding.manifest);
    if (!manifest.ok) {
      gaps.push(capabilityGap(
        binding,
        "manifest",
        `package script probe cannot decide manifest ${binding.manifest}: ${manifest.reason}`,
        manifest.location,
        baseRelated,
        { type: "manifest-parse", supported: false, reason: manifest.reason },
      ));
    }
  }

  const commandEdge = {
    source: "command-script",
    target: "command-target",
    basis: "closed_package_script_grammar",
    status: "indeterminate",
  };
  let commandScript = null;
  if (manifest?.ok) {
    commandScript = manifest.script(binding.command.script);
    if (commandScript.state === "missing") {
      commandScriptLocator.existence = "missing";
      commandEdge.status = "missing";
      findings.push(reachabilityFinding(
        binding,
        `script:${binding.command.script}`,
        `bound command script is missing from ${binding.manifest}: ${binding.command.script}`,
        binding.commandScriptLocation,
        [...baseRelated, relatedLocation("manifest", portableLocation(binding.manifest))],
        { type: "manifest-script", script: binding.command.script, present: false },
      ));
    } else if (commandScript.state === "unsupported") {
      commandScriptLocator.existence = "present";
      commandScriptLocator.repositoryLocation = commandScript.location;
      gaps.push(capabilityGap(
        binding,
        `script:${binding.command.script}`,
        commandScript.reason,
        commandScript.location,
        baseRelated,
        { type: "manifest-script", script: binding.command.script, supported: false },
      ));
    } else {
      commandScriptLocator.existence = "present";
      commandScriptLocator.repositoryLocation = commandScript.location;
      const parsed = parseCommandScript(commandScript.value);
      commandEdge.sourceLocation = commandScript.location;
      if (!parsed.ok) {
        gaps.push(capabilityGap(
          binding,
          `script:${binding.command.script}`,
          parsed.reason,
          commandScript.location,
          baseRelated,
          { type: "closed-command-grammar", script: binding.command.script, supported: false },
        ));
      } else if (parsed.target !== binding.command.target) {
        commandEdge.status = "mismatch";
        findings.push(reachabilityFinding(
          binding,
          "command-script-target-match",
          `command script target does not match the bound implementation locator: expected ${binding.command.target}; observed ${parsed.target}`,
          commandScript.location,
          [...baseRelated, relatedLocation("binding-target", binding.commandTargetLocation)],
          { type: "command-target", expected: binding.command.target, observed: parsed.target, match: false },
        ));
      } else if (commandInput.type !== "regular-file") {
        commandEdge.status = "missing";
      } else {
        commandEdge.status = "reachable";
        commandEdge.targetLocation = portableLocation(binding.command.target);
      }
    }
  }

  const expectedTestTargets = binding.tests.targets.map((target) => target.path);
  const testEdges = expectedTestTargets.map((target, index) => ({
    source: "test-script",
    target: `test-target-${index + 1}`,
    targetPath: target,
    basis: "closed_package_script_grammar",
    status: "indeterminate",
  }));
  let testScript = null;
  if (manifest?.ok) {
    testScript = manifest.script(binding.tests.script);
    if (testScript.state === "missing") {
      testScriptLocator.existence = "missing";
      for (const edge of testEdges) edge.status = "missing";
      findings.push(reachabilityFinding(
        binding,
        `script:${binding.tests.script}`,
        `bound test script is missing from ${binding.manifest}: ${binding.tests.script}`,
        binding.testScriptLocation,
        [...baseRelated, relatedLocation("manifest", portableLocation(binding.manifest))],
        { type: "manifest-script", script: binding.tests.script, present: false },
      ));
    } else if (testScript.state === "unsupported") {
      testScriptLocator.existence = "present";
      testScriptLocator.repositoryLocation = testScript.location;
      gaps.push(capabilityGap(
        binding,
        `script:${binding.tests.script}`,
        testScript.reason,
        testScript.location,
        baseRelated,
        { type: "manifest-script", script: binding.tests.script, supported: false },
      ));
    } else {
      testScriptLocator.existence = "present";
      testScriptLocator.repositoryLocation = testScript.location;
      const parsed = parseTestScript(testScript.value);
      for (const edge of testEdges) edge.sourceLocation = testScript.location;
      if (!parsed.ok) {
        gaps.push(capabilityGap(
          binding,
          `script:${binding.tests.script}`,
          parsed.reason,
          testScript.location,
          baseRelated,
          { type: "closed-test-grammar", script: binding.tests.script, supported: false },
        ));
      } else if (!sameStrings(parsed.targets, expectedTestTargets)) {
        const expectedSet = new Set(expectedTestTargets);
        const observedSet = new Set(parsed.targets);
        for (const edge of testEdges) edge.status = observedSet.has(edge.targetPath) ? "mismatch" : "missing";
        findings.push(reachabilityFinding(
          binding,
          "test-targets",
          `test script targets do not exactly match the bound ordered test locator set for ${binding.tests.script}`,
          testScript.location,
          [...baseRelated, ...binding.tests.targets.map((target) => relatedLocation("binding-test-target", target.location))],
          {
            type: "test-target-set",
            expected: expectedTestTargets,
            observed: parsed.targets,
            missing: expectedTestTargets.filter((target) => !observedSet.has(target)),
            unexpected: parsed.targets.filter((target) => !expectedSet.has(target)),
            orderedMatch: false,
          },
        ));
      } else {
        for (let index = 0; index < testEdges.length; index += 1) {
          const edge = testEdges[index];
          const target = testInputs[index];
          if (target.input.type !== "regular-file") {
            edge.status = "missing";
          } else {
            edge.status = "reachable";
            edge.targetLocation = portableLocation(target.target.path);
          }
        }
      }
    }
  }

  const hasGap = gaps.length > 0;
  const hasFinding = findings.length > 0;
  const reachability = hasFinding ? "unreachable" : hasGap ? "indeterminate" : "reachable";
  const manifestRepositoryLocation = manifestInput.type === "regular-file" ? portableLocation(binding.manifest) : null;
  const commandScriptEntryStatus = !manifest?.ok ? "indeterminate" : commandScript?.state === "missing" ? "missing" : "reachable";
  const testScriptEntryStatus = !manifest?.ok ? "indeterminate" : testScript?.state === "missing" ? "missing" : "reachable";
  const edges = [
    proofEdge("authority-binding", "authority", "binding", "project_binding", "bound", authorityNode.node.location, binding.location),
    proofEdge(
      "binding-manifest",
      "binding",
      "manifest",
      "declared_locator",
      manifestInput.type === "regular-file" ? "reachable" : "missing",
      binding.location,
      manifestRepositoryLocation,
    ),
    proofEdge(
      "manifest-command-script",
      "manifest",
      "command-script",
      "manifest_scripts_entry",
      commandScriptEntryStatus,
      manifestRepositoryLocation,
      commandScriptEntryStatus === "reachable" ? commandScript.location : null,
    ),
    proofEdge(
      "command-script-command-target",
      commandEdge.source,
      commandEdge.target,
      commandEdge.basis,
      commandEdge.status,
      commandEdge.sourceLocation ?? null,
      commandEdge.targetLocation ?? null,
    ),
    proofEdge(
      "manifest-test-script",
      "manifest",
      "test-script",
      "manifest_scripts_entry",
      testScriptEntryStatus,
      manifestRepositoryLocation,
      testScriptEntryStatus === "reachable" ? testScript.location : null,
    ),
    ...testEdges.map((edge) => proofEdge(
      `${edge.source}-${edge.target}`,
      edge.source,
      edge.target,
      edge.basis,
      edge.status,
      edge.sourceLocation ?? null,
      edge.targetLocation ?? null,
      { targetPath: edge.targetPath },
    )),
  ].sort(compareProofEdge);
  observations.push(commonItem(
    "AUTH_EVIDENCE_PACKAGE_PROBE_OBSERVATION",
    binding,
    "project_binding_package_probe",
    `evaluated declared package-script targets for evidence binding ${binding.id}`,
    binding.location,
    [
      relatedLocation("authority", authorityNode.node.location),
      relatedLocation("authority-scope", authorityNode.scopeLocation),
      ...(commandScript?.location ? [relatedLocation("command-script", commandScript.location)] : []),
      ...(testScript?.location ? [relatedLocation("test-script", testScript.location)] : []),
      ...(commandInput.type === "regular-file" ? [relatedLocation("command-target", portableLocation(binding.command.target))] : []),
      ...testInputs.filter(({ input }) => input.type === "regular-file").map(({ target }) => relatedLocation("test-target", portableLocation(target.path))),
    ],
    {
      type: "package-script-target-reachability",
      probe: PACKAGE_PROBE,
      reachability,
      execution: "not_executed",
      conformance: "not_evaluated",
      command: commandEdge,
      tests: testEdges,
    },
    "package-probe",
  ));

  locators.sort((left, right) => compareText(left.id, right.id));

  return {
    reachability,
    locators,
    edges,
    command: {
      script: binding.command.script,
      target: binding.command.target,
      scriptLocation: commandScript?.location ?? null,
      edge: commandEdge,
    },
    tests: {
      script: binding.tests.script,
      targets: expectedTestTargets,
      scriptLocation: testScript?.location ?? null,
      edges: testEdges,
    },
    observations,
    findings,
    gaps,
  };
}

function externalObservation(binding, externalProbe, status, reportedOutcome, adapter, primaryLocation) {
  const code = "AUTH_EVIDENCE_EXTERNAL_PROBE_OBSERVATION";
  const logicalTarget = `${externalProbe.id}@${externalProbe.version}`;
  return {
    code,
    fingerprint: fingerprint([code, externalProbe.id, externalProbe.version, binding.id, binding.authority.unit, binding.authority.scope]),
    binding: binding.id,
    required: externalProbe.required,
    authority: binding.authority.unit,
    scope: binding.authority.scope,
    basis: "external_supplied",
    message: `external probe state for ${binding.id}: ${status}${reportedOutcome === null ? "" : `/${reportedOutcome}`}`,
    primaryLocation,
    relatedLocations: [relatedLocation("binding", binding.location)],
    witness: {
      type: "external-supplied-probe-result",
      probe: externalProbe.id,
      version: externalProbe.version,
      status,
      reportedOutcome,
      adapter,
      source: "external_supplied",
      packageAttestation: false,
    },
    logicalTarget,
  };
}

function externalGap(binding, externalProbe, code, status, reportedOutcome, adapter, primaryLocation) {
  const logicalTarget = `${externalProbe.id}@${externalProbe.version}`;
  return {
    code,
    fingerprint: fingerprint([code, externalProbe.id, externalProbe.version, binding.id, binding.authority.unit, binding.authority.scope]),
    binding: binding.id,
    required: true,
    authority: binding.authority.unit,
    scope: binding.authority.scope,
    basis: "required_external_evidence",
    message: `required external probe evidence for ${binding.id} is ${status}${reportedOutcome === null ? "" : `/${reportedOutcome}`}`,
    primaryLocation,
    relatedLocations: [relatedLocation("binding", binding.location)],
    witness: {
      type: "external-supplied-probe-result",
      probe: externalProbe.id,
      version: externalProbe.version,
      status,
      reportedOutcome,
      adapter,
      source: "external_supplied",
      packageAttestation: false,
    },
    logicalTarget,
  };
}

function evaluateExternalProbe(binding, result) {
  const externalProbe = binding.externalProbe;
  if (externalProbe === null) return { record: null, observations: [], gaps: [] };
  let status = "not_provided";
  let reportedOutcome = null;
  let adapter = null;
  let primaryLocation = externalProbe.location;
  if (result) {
    adapter = result.adapter;
    primaryLocation = result.location;
    if (result.execution === "completed") {
      status = "reported_completed";
      reportedOutcome = result.outcome === "passed" ? "reported_passed" : "reported_failed";
    } else if (result.execution === "failed") status = "reported_execution_failed";
    else status = "reported_unsupported";
  }
  const record = {
    id: externalProbe.id,
    version: externalProbe.version,
    required: externalProbe.required,
    status,
    reportedOutcome,
    source: result ? "external_supplied" : "not_provided",
    packageAttestation: false,
    adapter,
  };
  const observation = externalObservation(binding, externalProbe, status, reportedOutcome, adapter, primaryLocation);
  if (!externalProbe.required || (status === "reported_completed" && reportedOutcome === "reported_passed")) {
    return { record, observations: [observation], gaps: [] };
  }
  const code = status === "not_provided"
    ? "AUTH_EVIDENCE_EXTERNAL_PROBE_NOT_PROVIDED"
    : status === "reported_execution_failed"
      ? "AUTH_EVIDENCE_EXTERNAL_PROBE_EXECUTION_FAILED"
      : status === "reported_unsupported"
        ? "AUTH_EVIDENCE_EXTERNAL_PROBE_UNSUPPORTED"
        : "AUTH_EVIDENCE_EXTERNAL_PROBE_REPORTED_FAILURE";
  return {
    record,
    observations: [observation],
    gaps: [externalGap(binding, externalProbe, code, status, reportedOutcome, adapter, primaryLocation)],
  };
}

function validateExternalResults(parsed, parsedBindings, identities, file) {
  if (parsed === null) return { ok: true, byBinding: new Map() };
  for (const [actual, expected, label] of [
    [parsed.authorityContentIdentity, identities.authorityContentIdentity, "authority content identity"],
    [parsed.repositoryInputIdentity, identities.repositoryInputIdentity, "repository input identity"],
    [parsed.bindingIdentity, identities.bindingIdentity, "binding identity"],
  ]) {
    if (actual !== expected) return { ok: false, diagnostics: [resultDiagnostic(file, `external probe result ${label} does not match this exact captured input`)] };
  }
  const bindings = new Map(parsedBindings.bindings.map((binding) => [binding.id, binding]));
  const byBinding = new Map();
  for (const result of parsed.results) {
    const binding = bindings.get(result.binding);
    if (!binding || binding.externalProbe === null) return { ok: false, diagnostics: [resultDiagnostic(file, `external probe result does not match one configured external probe binding: ${result.binding}`, result.location)] };
    if (result.probe !== binding.externalProbe.id || result.version !== binding.externalProbe.version) {
      return { ok: false, diagnostics: [resultDiagnostic(file, `external probe ID or version does not match binding ${binding.id}`, result.location)] };
    }
    byBinding.set(binding.id, result);
  }
  return { ok: true, byBinding };
}

function normalizeCompilerPath(file, root) {
  const relative = portablePath(file, root);
  if (path.isAbsolute(relative)) return path.basename(relative);
  if (relative === ".nimi/spec" || relative.startsWith(".nimi/spec/")) return relative;
  const rootPortable = root.split(path.sep).join(path.posix.sep);
  if (rootPortable.endsWith("/.nimi/spec")) return path.posix.join(".nimi/spec", relative);
  return relative;
}

function normalizeCompilerDiagnostics(diagnostics, root) {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: normalizeCompilerPath(diagnostic.path, root),
    related: diagnostic.related.map((related) => ({ ...related, path: normalizeCompilerPath(related.path, root) })),
  }));
}

function corpusInputDiagnostic(error, root) {
  const portableRoot = root.split(path.sep).join(path.posix.sep);
  const reason = error.message
    .split(root).join(".nimi/spec")
    .split(portableRoot).join(".nimi/spec")
    .split(path.sep).join(path.posix.sep);
  return evidenceDiagnostic(
    "AUTH_EVIDENCE_CORPUS_INVALID",
    ".nimi/spec",
    reason,
    null,
    "provide one complete canonical authority corpus; unsupported or partial inputs are refused",
  );
}

function manifestInputDiagnostic(binding, parsedManifest) {
  return evidenceDiagnostic(
    "AUTH_EVIDENCE_MANIFEST_INVALID",
    binding.manifest,
    `bound manifest is not an admitted input for ${PACKAGE_PROBE}: ${parsedManifest.reason}`,
    parsedManifest.location,
    "provide one valid UTF-8 JSON object with one uniquely addressable scripts object; unsupported script commands are reported separately as probe gaps",
  );
}

async function compileEvidenceAuthority(root) {
  try {
    const result = await compileAuthorityPath(root);
    if (result.ok) return { result, diagnostics: [] };
    return { result: null, diagnostics: normalizeCompilerDiagnostics(result.diagnostics, root) };
  } catch (error) {
    if (error instanceof AuthorityInputError) return { result: null, diagnostics: [corpusInputDiagnostic(error, root)] };
    throw error;
  }
}

function validateBindingAuthority(binding, graph) {
  const resolved = graph.byId.get(binding.authority.unit);
  if (!resolved || resolved.unit.kind !== "rule" || resolved.unit.lifecycle !== "active") {
    return bindingDiagnostic(
      binding.authorityLocation.file,
      `binding authority must resolve to one exact active rule: ${binding.authority.unit}`,
      binding.authorityLocation,
    );
  }
  if (!resolved.unit.semantic.scope.includes(binding.authority.scope)) {
    return bindingDiagnostic(
      binding.scopeLocation.file,
      `binding scope must be an exact declared member of ${binding.authority.unit}: ${binding.authority.scope}`,
      binding.scopeLocation,
    );
  }
  return null;
}

function authorityScopeLocation(binding, resolved, compiled, basePath) {
  const scopeIndex = resolved.unit.semantic.scope.indexOf(binding.authority.scope);
  const mapped = compiled.sourceMap.fields[`/units/${resolved.unitIndex}/semantic/scope/${scopeIndex}`];
  if (!mapped) throw new Error(`admitted authority scope has no SourceMap location: ${binding.authority.unit}/${binding.authority.scope}`);
  return {
    file: portablePath(mapped.file, basePath),
    range: mapped.range,
    sourcePointer: mapped.sourcePointer,
  };
}

function proofCounts(parsedBindings) {
  let locators = 0;
  let edges = 0;
  for (const binding of parsedBindings.bindings) {
    const tests = binding.tests.targets.length;
    locators += 5 + tests;
    edges += 5 + tests;
  }
  return { locators, edges };
}

function distinctBindingCount(parsedBindings) {
  return new Set([
    ...parsedBindings.required.map((entry) => entry.id),
    ...parsedBindings.bindings.map((binding) => binding.id),
  ]).size;
}

function authorityBasePath(root) {
  const portable = root.split(path.sep).join(path.posix.sep);
  return portable.endsWith("/.nimi/spec") ? path.dirname(path.dirname(root)) : root;
}

function canonicalEvidenceBytes(evidence) {
  return Buffer.byteLength(JSON.stringify(evidence), "utf8");
}

async function composeEvidence(snapshot, initialBindings, bindingPath, probeResultsPath, budgets) {
  const inputByPath = new Map(snapshot.inputs.map((entry) => [entry.path, entry]));
  const capturedBinding = inputByPath.get(bindingPath);
  if (!capturedBinding || capturedBinding.role !== "binding" || capturedBinding.type !== "regular-file") throw new Error("evidence snapshot omitted the captured binding file");
  const parsedBindings = await parseEvidenceBindings(capturedBinding.bytes, bindingPath);
  if (!parsedBindings.ok) return refused(parsedBindings.diagnostics);
  const initialPaths = locatorPaths(initialBindings);
  const capturedPaths = locatorPaths(parsedBindings);
  if (!sameStrings(initialPaths, capturedPaths)) {
    throw new AuthorityReviewRefusal(
      "AUTH_EVIDENCE_CAPTURE_CHANGED",
      "evidence binding changed its declared locator universe while the repository snapshot was captured",
      bindingPath,
    );
  }
  const compiled = await compileEvidenceAuthority(snapshot.authority.root);
  if (!compiled.result) return refused(compiled.diagnostics);
  if (compiled.result.fileCount !== snapshot.authority.fileCount) throw new Error("captured authority file count does not match complete compiler admission");
  const firstLocation = parsedBindings.bindings[0]?.location ?? parsedBindings.required[0]?.location ?? null;
  if (compiled.result.unitCount > budgets.maxUnits) return refused([budgetDiagnostic("authority units", compiled.result.unitCount, budgets.maxUnits, firstLocation)]);
  const bindingCount = distinctBindingCount(parsedBindings);
  if (bindingCount > budgets.maxBindings) return refused([budgetDiagnostic("binding IDs", bindingCount, budgets.maxBindings, firstLocation)]);
  const proof = proofCounts(parsedBindings);
  if (proof.locators > budgets.maxLocators) return refused([budgetDiagnostic("logical evidence locators", proof.locators, budgets.maxLocators, firstLocation)]);
  if (proof.edges > budgets.maxEdges) return refused([budgetDiagnostic("declared evidence edges", proof.edges, budgets.maxEdges, firstLocation)]);

  const authorityBase = authorityBasePath(snapshot.authority.root);
  const graph = buildAuthorityGraphSnapshot(compiled.result, authorityBase, []);
  for (const binding of parsedBindings.bindings) {
    const diagnostic = validateBindingAuthority(binding, graph);
    if (diagnostic) return refused([diagnostic]);
    const manifestInput = inputState(inputByPath, binding.manifest);
    if (manifestInput.type === "regular-file") {
      const parsedManifest = parseManifest(manifestInput.bytes, binding.manifest);
      if (!parsedManifest.ok) return refused([manifestInputDiagnostic(binding, parsedManifest)]);
    }
  }
  const bindingIdentity = evidenceBindingIdentity(capturedBinding.bytes);
  const locatorEntries = capturedPaths.map((file) => inputByPath.get(file));
  if (locatorEntries.some((entry) => !entry || entry.role !== "locator")) throw new Error("evidence snapshot did not return the exact declared locator universe");
  const repositoryInputIdentity = evidenceRepositoryInputIdentity(locatorEntries);
  const identities = {
    authorityContentIdentity: snapshot.authority.contentIdentity,
    repositoryInputIdentity,
    bindingIdentity,
  };

  let parsedResults = null;
  let resultContentIdentity = null;
  if (probeResultsPath !== null) {
    const capturedResults = inputByPath.get(probeResultsPath);
    if (!capturedResults || capturedResults.role !== "probe-results" || capturedResults.type !== "regular-file") throw new Error("evidence snapshot omitted the supplied probe result file");
    parsedResults = await parseEvidenceProbeResults(capturedResults.bytes, probeResultsPath);
    if (!parsedResults.ok) return refused(parsedResults.diagnostics);
    resultContentIdentity = evidenceProbeResultContentIdentity(capturedResults.bytes);
  }
  const validatedResults = validateExternalResults(parsedResults, parsedBindings, identities, probeResultsPath ?? bindingPath);
  if (!validatedResults.ok) return refused(validatedResults.diagnostics);

  const requiredIds = new Set(parsedBindings.required.map((entry) => entry.id));
  const configuredIds = new Set(parsedBindings.bindings.map((binding) => binding.id));
  const observations = [];
  const findings = [];
  const gaps = parsedBindings.required.filter((entry) => !configuredIds.has(entry.id)).map(requiredBindingGap);
  const bindingRecords = [];
  for (const binding of parsedBindings.bindings) {
    binding.required = requiredIds.has(binding.id);
    const resolvedAuthority = graph.byId.get(binding.authority.unit);
    const authorityNode = {
      ...resolvedAuthority,
      scopeLocation: authorityScopeLocation(binding, resolvedAuthority, compiled.result, authorityBase),
    };
    const evaluated = evaluatePackageProbe(binding, authorityNode, inputByPath);
    observations.push(...evaluated.observations);
    findings.push(...evaluated.findings);
    gaps.push(...evaluated.gaps);
    const external = evaluateExternalProbe(binding, validatedResults.byBinding.get(binding.id) ?? null);
    observations.push(...external.observations);
    gaps.push(...external.gaps);
    bindingRecords.push({
      id: binding.id,
      required: binding.required,
      authority: {
        unit: binding.authority.unit,
        scope: binding.authority.scope,
        location: authorityNode.node.location,
        scopeLocation: authorityNode.scopeLocation,
      },
      packageProbe: {
        id: PACKAGE_PROBE,
        version: "1",
        execution: "package_computed",
        reachability: evaluated.reachability,
        conformance: "not_evaluated",
      },
      manifest: {
        path: binding.manifest,
        existence: inputState(inputByPath, binding.manifest).type === "regular-file" ? "present" : "missing",
      },
      command: evaluated.command,
      tests: evaluated.tests,
      locators: evaluated.locators,
      edges: evaluated.edges,
      externalProbe: external.record,
      obligationKeys: {
        consumer: { ruleId: binding.authority.unit, type: "consumer", target: binding.authority.scope },
        test: { ruleId: binding.authority.unit, type: "test", target: binding.authority.unit },
      },
    });
  }
  const returnedProof = bindingRecords.reduce((counts, binding) => ({
    locators: counts.locators + binding.locators.length,
    edges: counts.edges + binding.edges.length,
  }), { locators: 0, edges: 0 });
  if (returnedProof.locators !== proof.locators || returnedProof.edges !== proof.edges) {
    throw new Error("complete evidence graph counts do not match returned locator and edge records");
  }
  observations.sort(compareItem);
  findings.sort(compareItem);
  gaps.sort(compareItem);
  const requiredFinding = findings.some((finding) => finding.required);
  const requiredGap = gaps.some((gap) => gap.required);
  const complete = !requiredGap;
  const evidenceStatus = requiredFinding ? "unavailable" : requiredGap ? "indeterminate" : "available";
  const presentLocatorFiles = locatorEntries.filter((entry) => entry.type === "regular-file").length;
  const missingLocatorFiles = locatorEntries.length - presentLocatorFiles;
  const evidence = {
    format: EVIDENCE_FORMAT,
    operationStatus: "completed",
    evidenceStatus,
    complete,
    partial: false,
    conformanceStatus: "not_evaluated",
    identities: {
      headCommitOid: snapshot.headOid,
      authorityContentIdentity: identities.authorityContentIdentity,
      repositoryInputIdentity: identities.repositoryInputIdentity,
      bindingIdentity: identities.bindingIdentity,
      externalResultContentIdentity: resultContentIdentity,
      boundary: "complete_authority_and_binding_declared_repository_paths",
      unboundRepositoryFilesInspected: false,
    },
    bindings: bindingRecords,
    observations,
    findings,
    gaps,
    counts: {
      bindings: {
        required: parsedBindings.required.length,
        configured: parsedBindings.bindings.length,
        evaluated: parsedBindings.bindings.length,
      },
      inputs: {
        authorityFiles: snapshot.authority.fileCount,
        locatorFilesPresent: presentLocatorFiles,
        locatorFilesMissing: missingLocatorFiles,
        capturedFiles: snapshot.inputs.filter((entry) => entry.type === "regular-file").length + snapshot.authority.fileCount,
        capturedBytes: snapshot.capturedInputBytes,
        authorityUnits: compiled.result.unitCount,
      },
      proof,
      returned: {
        observations: observations.length,
        findings: findings.length,
        gaps: gaps.length,
      },
    },
    budgets,
  };
  const evidenceBytes = canonicalEvidenceBytes(evidence);
  if (evidenceBytes > budgets.maxBytes) return refused([budgetDiagnostic("output UTF-8 bytes", evidenceBytes, budgets.maxBytes, firstLocation)], evidenceBytes);
  return {
    ok: true,
    diagnostics: [],
    fileCount: snapshot.authority.fileCount + snapshot.inputs.filter((entry) => entry.type === "regular-file").length,
    unitCount: compiled.result.unitCount,
    evidenceBytes,
    evidence,
    partial: false,
  };
}

function validatePublicPath(value, requiredPrefix, label) {
  if (!validRepositoryPath(value) || !value.startsWith(requiredPrefix)) {
    return evidenceDiagnostic(
      "AUTH_EVIDENCE_INPUT_INVALID",
      typeof value === "string" ? value : ".",
      `${label} must be one safe repository-relative path under ${requiredPrefix}`,
      null,
      `place the ${label} under ${requiredPrefix} without path escape or option syntax`,
    );
  }
  return null;
}

async function captureInitialBinding(repositoryPath, bindingPath, maxInputBytes) {
  const requested = path.resolve(process.cwd(), repositoryPath);
  try {
    const requestedInfo = await lstat(requested, { bigint: true });
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) throw new AuthorityReviewRefusal("AUTH_EVIDENCE_REPOSITORY_INVALID", "repository path must be one regular non-symlink directory", ".");
    const repository = await realpath(requested);
    let absolute = repository;
    const parts = bindingPath.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      absolute = path.join(absolute, parts[index]);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new AuthorityReviewRefusal("AUTH_EVIDENCE_BINDING_INVALID", "evidence binding path and ancestors must be regular non-symlink entries", bindingPath);
      }
    }
    const info = await lstat(absolute, { bigint: true });
    if (info.size > BigInt(maxInputBytes)) throw new AuthorityReviewRefusal("AUTH_EVIDENCE_BUDGET", `evidence binding alone requires ${info.size} input bytes but max-input-bytes is ${maxInputBytes}`, bindingPath);
    return await captureStableRegularFile(absolute, bindingPath, repository, maxInputBytes);
  } catch (error) {
    if (error instanceof AuthorityReviewRefusal) throw error;
    throw new AuthorityReviewRefusal("AUTH_EVIDENCE_BINDING_INVALID", `evidence binding is not safely readable: ${error.message}`, bindingPath);
  }
}

export async function evidenceAuthorityRepository(repositoryPath, bindingPath, probeResultsPath, budgets, options = {}) {
  if (![budgets?.maxUnits, budgets?.maxBindings, budgets?.maxLocators, budgets?.maxEdges, budgets?.maxInputBytes, budgets?.maxBytes].every(validBudget)) {
    return refused([budgetDiagnostic("positive safe-integer budget values", "all", "invalid")]);
  }
  const bindingPathDiagnostic = validatePublicPath(bindingPath, ".nimi/config/", "binding");
  if (bindingPathDiagnostic) return refused([bindingPathDiagnostic]);
  if (probeResultsPath !== null) {
    const resultPathDiagnostic = validatePublicPath(probeResultsPath, ".nimi/local/", "probe result");
    if (resultPathDiagnostic) return refused([resultPathDiagnostic]);
    if (probeResultsPath === bindingPath) return refused([resultDiagnostic(probeResultsPath, "probe result path must be distinct from the tracked binding path")]);
  }
  try {
    const initialBytes = await captureInitialBinding(repositoryPath, bindingPath, budgets.maxInputBytes);
    const initialBindings = await parseEvidenceBindings(initialBytes, bindingPath);
    if (!initialBindings.ok) return refused(initialBindings.diagnostics);
    const paths = locatorPaths(initialBindings);
    if (paths.includes(bindingPath) || (probeResultsPath !== null && paths.includes(probeResultsPath))) {
      return refused([bindingDiagnostic(bindingPath, "binding, supplied-result, and locator paths must be distinct")]);
    }
    return await withGitEvidenceSnapshot({
      repositoryPath,
      bindingPath,
      probeResultsPath,
      locatorPaths: paths,
      maxInputBytes: budgets.maxInputBytes,
      hooks: options.snapshotHooks ?? null,
    }, (snapshot) => composeEvidence(snapshot, initialBindings, bindingPath, probeResultsPath, budgets));
  } catch (error) {
    if (error instanceof AuthorityReviewRefusal) return refused([snapshotDiagnostic(error)]);
    throw error;
  }
}

export {
  BINDING_FORMAT,
  EVIDENCE_FORMAT,
  PACKAGE_PROBE,
  RESULT_FORMAT,
  canonicalEvidenceBytes,
};
