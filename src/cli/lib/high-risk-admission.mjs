import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import {
  HIGH_RISK_ADMISSION_CONTRACT_REF,
  HIGH_RISK_ADMISSION_PAYLOAD_CONTRACT_VERSION,
} from "../constants.mjs";
import {
  loadHighRiskAdmissionContract,
  validateHighRiskAdmissionsSpec,
} from "./contracts.mjs";
import { inspectDoctorState } from "./doctor.mjs";
import { readTextIfFile } from "./fs-helpers.mjs";
import { validateExecutionPacket } from "./validators.mjs";
import { isIsoUtcTimestamp, isPlainObject } from "./value-helpers.mjs";
import { parseYamlText } from "./yaml-helpers.mjs";

const ADMISSIONS_SPEC_REF = ".nimi/spec/high-risk-admissions.yaml";

async function loadImportedDecisionPayload(projectRoot, fromPath) {
  const absolutePath = path.resolve(projectRoot, fromPath);
  const rawText = await readTextIfFile(absolutePath);

  if (rawText === null) {
    return {
      ok: false,
      error: `nimicoding admit-high-risk-decision refused: cannot read imported decision JSON at ${absolutePath}.\n`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      error: `nimicoding admit-high-risk-decision refused: imported decision JSON at ${absolutePath} is invalid JSON.\n`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "nimicoding admit-high-risk-decision refused: imported decision JSON must be an object.\n",
    };
  }

  if (parsed.projectRoot) {
    let importedProjectRoot;
    let currentProjectRoot;
    try {
      importedProjectRoot = await realpath(parsed.projectRoot);
      currentProjectRoot = await realpath(projectRoot);
    } catch {
      return {
        ok: false,
        error: "nimicoding admit-high-risk-decision refused: imported decision projectRoot could not be resolved.\n",
      };
    }

    if (importedProjectRoot !== currentProjectRoot) {
      return {
        ok: false,
        error: "nimicoding admit-high-risk-decision refused: imported decision projectRoot does not match the current project.\n",
      };
    }
  }

  return {
    ok: true,
    path: absolutePath,
    payload: parsed,
  };
}

function validateImportedDecisionPayload(payload) {
  if (payload.contractVersion !== "nimicoding.high-risk-decision.v1") {
    return {
      ok: false,
      reason: "imported decision payload must declare contractVersion nimicoding.high-risk-decision.v1",
    };
  }

  if (payload.skill?.id !== "high_risk_execution") {
    return {
      ok: false,
      reason: "imported decision payload must declare skill.id high_risk_execution",
    };
  }

  if (payload.localOnly !== true) {
    return {
      ok: false,
      reason: "imported decision payload must remain localOnly true",
    };
  }

  if (payload.ok !== true) {
    return {
      ok: false,
      reason: "admit-high-risk-decision requires a decision payload with ok true",
    };
  }

  if (payload.decisionStatus !== "manager_decision_recorded") {
    return {
      ok: false,
      reason: "admit-high-risk-decision requires decisionStatus manager_decision_recorded",
    };
  }

  if (payload.acceptanceValidation?.ok !== true) {
    return {
      ok: false,
      reason: "admit-high-risk-decision requires mechanically valid acceptance state",
    };
  }

  if (!isPlainObject(payload.attachmentRefs) || typeof payload.attachmentRefs.packet_ref !== "string") {
    return {
      ok: false,
      reason: "imported decision payload must include attachmentRefs.packet_ref",
    };
  }

  return { ok: true };
}

async function loadAdmissionsSpec(projectRoot, contract) {
  const absolutePath = path.join(projectRoot, ADMISSIONS_SPEC_REF);
  const text = await readTextIfFile(absolutePath);

  if (text === null) {
    return {
      ok: false,
      path: absolutePath,
      reason: `cannot read ${ADMISSIONS_SPEC_REF}`,
    };
  }

  const parsed = parseYamlText(text);
  const validation = validateHighRiskAdmissionsSpec(parsed, contract);

  return {
    ok: validation.ok,
    path: absolutePath,
    parsed,
    reason: validation.ok ? null : validation.reason,
  };
}

async function loadPacketIdentity(projectRoot, packetRef) {
  const absolutePath = path.resolve(projectRoot, packetRef);
  const packetValidation = await validateExecutionPacket(absolutePath);
  if (!packetValidation.ok) {
    return {
      ok: false,
      reason: "attached packet_ref failed mechanical validation",
      validation: packetValidation,
    };
  }

  const text = await readTextIfFile(absolutePath);
  const parsed = parseYamlText(text);
  const packetId = String(parsed?.packet_id ?? "");
  const topicId = String(parsed?.topic_id ?? "");

  if (!packetId || !topicId) {
    return {
      ok: false,
      reason: "attached packet_ref is missing packet_id or topic_id",
      validation: packetValidation,
    };
  }

  return {
    ok: true,
    packetId,
    topicId,
    validation: packetValidation,
  };
}

function upsertAdmissionRecord(existingAdmissions, record) {
  const nextAdmissions = existingAdmissions.filter((entry) => String(entry?.topic_id ?? "") !== record.topic_id);
  const replaced = nextAdmissions.length !== existingAdmissions.length;
  nextAdmissions.push(record);
  nextAdmissions.sort((left, right) => String(left.topic_id).localeCompare(String(right.topic_id)));
  return {
    admissions: nextAdmissions,
    action: replaced ? "updated" : "created",
  };
}

function evaluateAdmissionReadiness(doctorResult, admissionsSpec, packetIdentity) {
  if (!doctorResult.ok || !doctorResult.handoffReadiness.ok) {
    return {
      ok: false,
      reason: "Bootstrap or handoff validation is failing; repair doctor errors before semantic admission",
    };
  }

  if (doctorResult.targetTruth.missing.length > 0 || doctorResult.targetTruth.invalid.length > 0) {
    return {
      ok: false,
      reason: "Canonical admission requires reconstructed `.nimi/spec/*.yaml` target truth",
    };
  }

  if (!admissionsSpec.ok) {
    return {
      ok: false,
      reason: admissionsSpec.reason,
    };
  }

  if (!packetIdentity.ok) {
    return {
      ok: false,
      reason: packetIdentity.reason,
    };
  }

  return {
    ok: true,
    reason: "Manager-owned local decision is ready for explicit canonical admission",
  };
}

export async function buildHighRiskAdmissionPayload(projectRoot, options) {
  const imported = await loadImportedDecisionPayload(projectRoot, options.fromPath);
  if (!imported.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: imported.error,
    };
  }

  const decisionValidation = validateImportedDecisionPayload(imported.payload);
  if (!decisionValidation.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `nimicoding admit-high-risk-decision refused: ${decisionValidation.reason}.\n`,
    };
  }

  if (!isIsoUtcTimestamp(options.admittedAt)) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: "nimicoding admit-high-risk-decision refused: --admitted-at must be an ISO-8601 UTC timestamp.\n",
    };
  }

  const admissionsContract = await loadHighRiskAdmissionContract(projectRoot);
  if (!admissionsContract.ok) {
    return {
      contractVersion: HIGH_RISK_ADMISSION_PAYLOAD_CONTRACT_VERSION,
      ok: false,
      exitCode: 1,
      projectRoot,
      sourceDecisionRef: imported.path,
      semanticTargetRef: ADMISSIONS_SPEC_REF,
      artifactPath: path.join(projectRoot, ADMISSIONS_SPEC_REF),
      skill: {
        id: "high_risk_execution",
      },
      localOnly: false,
      admittedAt: options.admittedAt,
      admissionAction: "blocked",
      admissionRecord: null,
      readiness: {
        ok: false,
        reason: `${HIGH_RISK_ADMISSION_CONTRACT_REF} is missing or malformed`,
      },
      doctor: {
        ok: false,
        handoffReadiness: { ok: false },
        delegatedContracts: {},
      },
      nextSpecYaml: null,
      nextAction: `${HIGH_RISK_ADMISSION_CONTRACT_REF} must satisfy the package-owned canonical admission contract.`,
    };
  }

  const doctorResult = await inspectDoctorState(projectRoot);
  const admissionsSpec = await loadAdmissionsSpec(projectRoot, admissionsContract);
  const packetIdentity = await loadPacketIdentity(projectRoot, imported.payload.attachmentRefs.packet_ref);
  const readiness = evaluateAdmissionReadiness(doctorResult, admissionsSpec, packetIdentity);

  const admissionRecord = packetIdentity.ok ? {
    topic_id: packetIdentity.topicId,
    packet_id: packetIdentity.packetId,
    disposition: imported.payload.acceptanceDisposition,
    admitted_at: options.admittedAt,
    manager_review_owner: imported.payload.managerReviewOwner ?? doctorResult.delegatedContracts.semanticReviewOwner,
    summary: typeof imported.payload.summary?.summary === "string" && imported.payload.summary.summary.trim().length > 0
      ? imported.payload.summary.summary
      : `Admitted manager-owned disposition for ${packetIdentity.topicId}.`,
    source_decision_contract: imported.payload.contractVersion,
  } : null;

  const nextAdmissions = readiness.ok
    ? upsertAdmissionRecord(admissionsSpec.parsed.admissions, admissionRecord)
    : { admissions: admissionsSpec.parsed?.admissions ?? [], action: "blocked" };

  const nextSpecObject = admissionsSpec.ok ? {
    admissions: nextAdmissions.admissions,
    admission_rules: admissionsSpec.parsed.admission_rules,
    semantic_constraints: admissionsSpec.parsed.semantic_constraints,
  } : null;
  const nextSpecValidation = nextSpecObject ? validateHighRiskAdmissionsSpec(nextSpecObject, admissionsContract) : { ok: false };

  return {
    contractVersion: HIGH_RISK_ADMISSION_PAYLOAD_CONTRACT_VERSION,
    ok: readiness.ok && nextSpecValidation.ok,
    exitCode: readiness.ok && nextSpecValidation.ok ? 0 : 1,
    projectRoot,
    sourceDecisionRef: imported.path,
    semanticTargetRef: ADMISSIONS_SPEC_REF,
    artifactPath: path.join(projectRoot, ADMISSIONS_SPEC_REF),
    skill: {
      id: "high_risk_execution",
    },
    localOnly: false,
    admittedAt: options.admittedAt,
    admissionAction: nextAdmissions.action,
    admissionRecord,
    readiness: readiness.ok && !nextSpecValidation.ok
      ? {
        ok: false,
        reason: nextSpecValidation.reason,
      }
      : readiness,
    doctor: {
      ok: doctorResult.ok,
      handoffReadiness: doctorResult.handoffReadiness,
      delegatedContracts: doctorResult.delegatedContracts,
    },
    nextSpecYaml: nextSpecObject ? YAML.stringify(nextSpecObject) : null,
    nextAction: readiness.ok && nextSpecValidation.ok
      ? options.writeSpec
        ? `Write canonical admission to ${ADMISSIONS_SPEC_REF}.`
        : `Review the canonical admission preview or write it with --write-spec.`
      : readiness.ok && !nextSpecValidation.ok
        ? nextSpecValidation.reason
        : readiness.reason,
  };
}

export async function writeHighRiskAdmission(projectRoot, payload) {
  if (!payload.ok || typeof payload.nextSpecYaml !== "string") {
    return;
  }

  await writeFile(path.join(projectRoot, ADMISSIONS_SPEC_REF), payload.nextSpecYaml, "utf8");
}

export function formatHighRiskAdmissionPayload(payload) {
  const lines = [
    `nimicoding admit-high-risk-decision: ${payload.projectRoot}`,
    "",
    "Admission:",
    `  - target_ref: ${payload.semanticTargetRef}`,
    `  - action: ${payload.admissionAction}`,
    `  - ready: ${payload.readiness.ok ? "true" : "false"}`,
    `  - local_only: ${payload.localOnly ? "true" : "false"}`,
  ];

  if (payload.admissionRecord) {
    lines.push(`  - topic_id: ${payload.admissionRecord.topic_id}`);
    lines.push(`  - packet_id: ${payload.admissionRecord.packet_id}`);
    lines.push(`  - disposition: ${payload.admissionRecord.disposition}`);
  }

  lines.push("", "Next:", `  - ${payload.nextAction}`);
  return `${lines.join("\n")}\n`;
}
