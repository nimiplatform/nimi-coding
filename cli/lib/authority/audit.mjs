import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML, { isMap, isScalar, isSeq } from "yaml";

import { compileAuthorityPath } from "./compile.mjs";
import { compareText, createLocator, makeDiagnostic, portablePath } from "./diagnostics.mjs";
import { buildAuthorityGraphSnapshot } from "./graph.mjs";

const AUDIT_FORMAT = "nimicoding.authority-audit/v1";
const BINDING_FORMAT = "nimicoding.authority-verifier-bindings/v1";
const DETECTOR = "minimum-independent-incoming-reference/v1";
const FINGERPRINT_FORMAT = "nimicoding.authority-audit-fingerprint/v1";
const contractPath = fileURLToPath(new URL("../../../contracts/authority-verifier-bindings.schema.yaml", import.meta.url));

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
    if (contract?.version !== 1 || contract?.contract?.id !== "nimicoding.authority-verifier-bindings.v1") {
      throw new Error("installed authority verifier binding contract is invalid");
    }
    return contract;
  });
  return contractPromise;
}

function bindingDiagnostic(file, reason, location = null) {
  return makeDiagnostic({
    code: "AUTH_AUDIT_BINDING_INVALID",
    file,
    range: location?.range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: location?.sourcePointer ?? "",
    reason,
    repair: "declare the exact closed verifier binding without inferring project policy from authority prose",
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

async function loadBindings(file) {
  const absolute = path.resolve(file);
  const label = portablePath(absolute);
  let bytes;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "verifier bindings must be one regular non-symlink YAML file")] };
    }
    bytes = await readFile(absolute);
  } catch (error) {
    return { ok: false, diagnostics: [bindingDiagnostic(label, `verifier binding file is not readable: ${error.message}`)] };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, diagnostics: [bindingDiagnostic(label, "verifier binding bytes are not valid UTF-8")] };
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
      ? "verifier bindings must contain exactly one YAML document"
      : error ? `invalid verifier binding YAML: ${error.message.split(" at line")[0]}` : "verifier bindings require one top-level mapping";
    return { ok: false, diagnostics: [bindingDiagnostic(label, reason, location)] };
  }
  let data;
  try {
    data = documents[0].toJS({ maxAliasCount: 0 });
  } catch (error) {
    return { ok: false, diagnostics: [bindingDiagnostic(label, `invalid verifier binding YAML: ${error.message}`)] };
  }
  const locations = new Map();
  collectLocations(documents[0].contents, locator, "", locations);
  const parsed = { file: label, locations, data };
  const contract = await loadContract();
  if (!exactObject(data, contract.fields.top) || data.format !== BINDING_FORMAT || !Array.isArray(data.required_bindings) || data.required_bindings.length === 0 || !Array.isArray(data.bindings)) {
    return { ok: false, diagnostics: [bindingDiagnostic(label, "verifier bindings require exact format, required_bindings, and bindings fields", parsedLocation(parsed, ""))] };
  }
  const identifier = new RegExp(contract.identifier_pattern);
  const required = [];
  const requiredIds = new Set();
  for (let index = 0; index < data.required_bindings.length; index += 1) {
    const id = data.required_bindings[index];
    const pointer = `/required_bindings/${index}`;
    if (typeof id !== "string" || !identifier.test(id)) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "required binding IDs must be exact dotted lowercase identifiers", parsedLocation(parsed, pointer))] };
    }
    if (requiredIds.has(id)) return { ok: false, diagnostics: [bindingDiagnostic(label, `duplicate required binding ID: ${id}`, parsedLocation(parsed, pointer))] };
    requiredIds.add(id);
    required.push({ id, location: parsedLocation(parsed, pointer) });
  }
  const bindings = [];
  const bindingIds = new Set();
  for (let index = 0; index < data.bindings.length; index += 1) {
    const value = data.bindings[index];
    const pointer = `/bindings/${index}`;
    if (!exactObject(value, contract.fields.binding)) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "each binding requires exact id, detector, premise, targets, minimum, and policy fields", parsedLocation(parsed, pointer))] };
    }
    if (typeof value.id !== "string" || !identifier.test(value.id)) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "binding id must be an exact dotted lowercase identifier", parsedLocation(parsed, `${pointer}/id`))] };
    }
    if (bindingIds.has(value.id)) return { ok: false, diagnostics: [bindingDiagnostic(label, `duplicate binding ID: ${value.id}`, parsedLocation(parsed, `${pointer}/id`))] };
    bindingIds.add(value.id);
    if (value.detector !== DETECTOR) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, `unknown detector: ${String(value.detector)}`, parsedLocation(parsed, `${pointer}/detector`))] };
    }
    if (typeof value.premise !== "string" || !identifier.test(value.premise)) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "binding premise must be one exact authority ID", parsedLocation(parsed, `${pointer}/premise`))] };
    }
    if (!Array.isArray(value.targets) || value.targets.length === 0) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "binding targets must be a non-empty exact ID list", parsedLocation(parsed, `${pointer}/targets`))] };
    }
    const targets = [];
    const targetIds = new Set();
    for (let targetIndex = 0; targetIndex < value.targets.length; targetIndex += 1) {
      const target = value.targets[targetIndex];
      const targetPointer = `${pointer}/targets/${targetIndex}`;
      if (typeof target !== "string" || !identifier.test(target)) {
        return { ok: false, diagnostics: [bindingDiagnostic(label, "binding targets must contain only exact authority IDs", parsedLocation(parsed, targetPointer))] };
      }
      if (targetIds.has(target)) return { ok: false, diagnostics: [bindingDiagnostic(label, `duplicate binding target: ${target}`, parsedLocation(parsed, targetPointer))] };
      targetIds.add(target);
      targets.push({ id: target, location: parsedLocation(parsed, targetPointer) });
    }
    if (!Number.isSafeInteger(value.minimum) || value.minimum <= 0) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "binding minimum must be a positive safe integer", parsedLocation(parsed, `${pointer}/minimum`))] };
    }
    if (!contract.policies.includes(value.policy)) {
      return { ok: false, diagnostics: [bindingDiagnostic(label, "binding policy must be advisory or blocking", parsedLocation(parsed, `${pointer}/policy`))] };
    }
    bindings.push({
      ...value,
      location: parsedLocation(parsed, `${pointer}/id`),
      premiseLocation: parsedLocation(parsed, `${pointer}/premise`),
      targetEntries: targets,
    });
  }
  required.sort((left, right) => compareText(left.id, right.id));
  bindings.sort((left, right) => compareText(left.id, right.id));
  return { ok: true, diagnostics: [], required, bindings };
}

function refused(compiled, diagnostics) {
  return {
    ok: false,
    diagnostics,
    fileCount: compiled?.fileCount ?? 0,
    unitCount: 0,
    auditBytes: 0,
    audit: null,
    partial: false,
  };
}

function fingerprint(parts) {
  const digest = createHash("sha256").update([FINGERPRINT_FORMAT, ...parts].join("\0")).digest("hex");
  return `sha256:${digest}`;
}

function relatedLocation(role, location) {
  return { role, location };
}

function compareRelatedLocation(left, right) {
  return compareText(left.role, right.role)
    || compareText(left.location.file, right.location.file)
    || left.location.range.start.line - right.location.range.start.line
    || left.location.range.start.column - right.location.range.start.column
    || compareText(left.location.sourcePointer, right.location.sourcePointer);
}

function edgeKey(edge) {
  return `${edge.source}\0${edge.type}\0${edge.target}`;
}

function auditBudgetDiagnostic(kind, required, admitted, location = null) {
  return makeDiagnostic({
    code: "AUTH_AUDIT_BUDGET",
    file: location?.file ?? ".",
    range: location?.range ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: location?.sourcePointer ?? "",
    reason: `complete authority audit requires ${required} ${kind} but the explicit budget is ${admitted}`,
    repair: "increase the explicit audit budget; partial observations, findings, or gaps are forbidden",
  });
}

function validBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateBindingAuthority(binding, snapshot, compiled) {
  const premise = snapshot.byId.get(binding.premise);
  if (!premise || premise.unit.kind !== "rule" || premise.unit.lifecycle !== "active") {
    return refused(compiled, [bindingDiagnostic(
      binding.premiseLocation.file,
      `binding premise must resolve to one exact active rule: ${binding.premise}`,
      binding.premiseLocation,
    )]);
  }
  for (const target of binding.targetEntries) {
    const resolved = snapshot.byId.get(target.id);
    if (!resolved || resolved.unit.kind !== "definition" || resolved.unit.lifecycle !== "active") {
      return refused(compiled, [bindingDiagnostic(
        target.location.file,
        `binding target must resolve to one exact active definition: ${target.id}`,
        target.location,
      )]);
    }
  }
  return { premise };
}

function findingBase(binding, target, code, message, witness, primaryLocation, relatedLocations) {
  const authorityRefs = [...new Set([binding.premise, target.id, ...(witness.incomingRefs ?? [])])].sort(compareText);
  return {
    code,
    detector: DETECTOR,
    binding: binding.id,
    premise: binding.premise,
    target: target.id,
    basis: "governance_bound",
    policy: binding.policy,
    fingerprint: fingerprint([code, DETECTOR, binding.id, binding.premise, target.id, `minimum=${binding.minimum}`]),
    message,
    authorityRefs,
    primaryLocation,
    relatedLocations: [...relatedLocations].sort(compareRelatedLocation),
    witness,
  };
}

export function canonicalAuditBytes(audit) {
  return Buffer.byteLength(JSON.stringify(audit), "utf8");
}

export async function auditAuthorityPath(inputPath, bindingsPath, { maxUnits, maxEdges, maxBytes }) {
  if (![maxUnits, maxEdges, maxBytes].every(validBudget)) {
    return refused(null, [auditBudgetDiagnostic("positive safe-integer budget values", "all", "invalid")]);
  }
  const compiled = await compileAuthorityPath(inputPath);
  if (!compiled.ok) return refused(compiled, compiled.diagnostics);
  const parsedBindings = await loadBindings(bindingsPath);
  if (!parsedBindings.ok) return refused(compiled, parsedBindings.diagnostics);
  const absoluteInput = path.resolve(inputPath);
  const inputInfo = await stat(absoluteInput);
  const basePath = inputInfo.isDirectory() ? absoluteInput : path.dirname(absoluteInput);
  const snapshot = buildAuthorityGraphSnapshot(compiled, basePath, ["applies_to"]);
  for (const binding of parsedBindings.bindings) {
    const validation = validateBindingAuthority(binding, snapshot, compiled);
    if (validation.ok === false) return validation;
  }

  const proofUnits = new Set();
  const proofEdges = new Set();
  const observations = [];
  const findings = [];
  const gaps = [];
  const presentBindings = new Set(parsedBindings.bindings.map((binding) => binding.id));

  for (const required of parsedBindings.required) {
    if (presentBindings.has(required.id)) continue;
    const code = "AUTH_AUDIT_REQUIRED_BINDING_MISSING";
    gaps.push({
      code,
      detector: null,
      binding: required.id,
      premise: null,
      basis: "required_coverage",
      policy: "required",
      fingerprint: fingerprint([code, required.id]),
      message: `required verifier binding is missing: ${required.id}`,
      authorityRefs: [],
      primaryLocation: required.location,
      relatedLocations: [],
      witness: { type: "required-binding", required: true, present: false },
    });
  }

  for (const binding of parsedBindings.bindings) {
    const premise = snapshot.byId.get(binding.premise);
    proofUnits.add(binding.premise);
    const premiseEdges = snapshot.outgoing.get(binding.premise).filter((edge) => edge.type === "applies_to");
    for (const edge of premiseEdges) {
      proofEdges.add(edgeKey(edge));
      proofUnits.add(edge.source);
      proofUnits.add(edge.target);
    }
    const targetObservations = [];
    const observationRelated = [relatedLocation("premise", premise.node.location)];
    for (const target of [...binding.targetEntries].sort((left, right) => compareText(left.id, right.id))) {
      const targetNode = snapshot.byId.get(target.id);
      proofUnits.add(target.id);
      const attachment = premiseEdges.find((edge) => edge.target === target.id) ?? null;
      if (attachment) proofEdges.add(edgeKey(attachment));
      const incomingCandidates = snapshot.incoming.get(target.id).filter((edge) => edge.type === "applies_to");
      for (const edge of incomingCandidates) {
        proofEdges.add(edgeKey(edge));
        proofUnits.add(edge.source);
        proofUnits.add(edge.target);
      }
      const incoming = incomingCandidates
        .filter((edge) => edge.source !== binding.premise)
        .filter((edge) => {
          const source = snapshot.byId.get(edge.source).unit;
          return source.kind === "rule" && source.lifecycle === "active";
        });
      targetObservations.push({
        id: target.id,
        attached: attachment !== null,
        observed: new Set(incoming.map((edge) => edge.source)).size,
        incomingRefs: [...new Set(incoming.map((edge) => edge.source))].sort(compareText),
      });
      observationRelated.push(relatedLocation("binding-target", target.location));
      observationRelated.push(relatedLocation("target", targetNode.node.location));
      if (attachment) observationRelated.push(relatedLocation("premise-attachment", attachment.relationLocation));
      for (const edge of incoming) observationRelated.push(relatedLocation("incoming-reference", edge.relationLocation));
      const commonRelated = [
        relatedLocation("binding", binding.location),
        relatedLocation("binding-target", target.location),
        relatedLocation("premise", premise.node.location),
      ];
      if (!attachment) {
        findings.push(findingBase(
          binding,
          target,
          "AUTH_AUDIT_PREMISE_TARGET_UNATTACHED",
          `premise ${binding.premise} does not directly attach required target ${target.id}`,
          { type: "premise-direct-attachment", relation: "applies_to", attached: false },
          targetNode.node.location,
          commonRelated,
        ));
      } else {
        commonRelated.push(relatedLocation("premise-attachment", attachment.relationLocation));
      }
      const observed = new Set(incoming.map((edge) => edge.source)).size;
      if (observed < binding.minimum) {
        for (const edge of incoming) commonRelated.push(relatedLocation("incoming-reference", edge.relationLocation));
        findings.push(findingBase(
          binding,
          target,
          "AUTH_AUDIT_MINIMUM_INDEPENDENT_INCOMING_REFERENCE",
          `target ${target.id} has ${observed} independent active-rule applies_to references; binding requires ${binding.minimum}`,
          {
            type: "minimum-independent-incoming-reference",
            relation: "applies_to",
            minimum: binding.minimum,
            observed,
            incomingRefs: [...new Set(incoming.map((edge) => edge.source))].sort(compareText),
          },
          targetNode.node.location,
          commonRelated,
        ));
      }
    }
    observations.push({
      code: "AUTH_AUDIT_INDEPENDENT_INCOMING_REFERENCE_OBSERVATION",
      detector: DETECTOR,
      binding: binding.id,
      premise: binding.premise,
      basis: "governance_bound",
      policy: binding.policy,
      fingerprint: fingerprint([
        "AUTH_AUDIT_INDEPENDENT_INCOMING_REFERENCE_OBSERVATION",
        DETECTOR,
        binding.id,
        binding.premise,
        `targets=${targetObservations.map((target) => target.id).join(",")}`,
        `minimum=${binding.minimum}`,
      ]),
      message: `evaluated ${targetObservations.length} exact targets for binding ${binding.id}`,
      authorityRefs: [...new Set([
        binding.premise,
        ...targetObservations.flatMap((target) => [target.id, ...target.incomingRefs]),
      ])].sort(compareText),
      primaryLocation: binding.location,
      relatedLocations: observationRelated.sort(compareRelatedLocation),
      witness: {
        type: "minimum-independent-incoming-reference",
        relation: "applies_to",
        minimum: binding.minimum,
        targets: targetObservations,
      },
    });
  }

  findings.sort((left, right) => compareText(left.binding, right.binding) || compareText(left.target, right.target) || compareText(left.code, right.code));
  gaps.sort((left, right) => compareText(left.binding, right.binding));
  const traversal = { units: proofUnits.size, edges: proofEdges.size };
  const firstLocation = parsedBindings.bindings[0]?.location ?? parsedBindings.required[0]?.location ?? null;
  if (traversal.units > maxUnits) return refused(compiled, [auditBudgetDiagnostic("units", traversal.units, maxUnits, firstLocation)]);
  if (traversal.edges > maxEdges) return refused(compiled, [auditBudgetDiagnostic("edges", traversal.edges, maxEdges, firstLocation)]);
  const blocking = findings.some((finding) => finding.policy === "blocking");
  const audit = {
    format: AUDIT_FORMAT,
    operationStatus: "completed",
    policyStatus: blocking ? "blocked" : gaps.length > 0 ? "indeterminate" : "passed",
    complete: gaps.length === 0,
    observations,
    findings,
    gaps,
    counts: {
      bindings: {
        required: parsedBindings.required.length,
        configured: parsedBindings.bindings.length,
        evaluated: observations.length,
      },
      returned: {
        observations: observations.length,
        findings: findings.length,
        gaps: gaps.length,
      },
      traversal,
    },
    budgets: { maxUnits, maxEdges, maxBytes },
  };
  const auditBytes = canonicalAuditBytes(audit);
  if (auditBytes > maxBytes) return refused(compiled, [auditBudgetDiagnostic("UTF-8 bytes", auditBytes, maxBytes, firstLocation)]);
  return {
    ok: true,
    diagnostics: [],
    fileCount: compiled.fileCount,
    unitCount: compiled.unitCount,
    auditBytes,
    audit,
    partial: false,
  };
}

export { AUDIT_FORMAT, BINDING_FORMAT, DETECTOR };
