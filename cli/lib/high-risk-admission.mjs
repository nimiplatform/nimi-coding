import { mkdir, realpath, writeFile } from "node:fs/promises";
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
import {
  localize,
  styleCommand,
  styleHeading,
  styleLabel,
  styleStatus,
} from "./ui.mjs";
import { validateExecutionPacket } from "./validators.mjs";
import { isIsoUtcTimestamp, isPlainObject } from "./value-helpers.mjs";
import { parseYamlText } from "./yaml-helpers.mjs";

const ADMISSIONS_EVIDENCE_REF = ".nimi/local/high-risk-admissions.yaml";

function emptyAdmissionsEvidence() {
  return {
    admissions: [],
    admission_rules: [
      "explicit_manager_owned_decision_required_before_high_risk_local_evidence",
      "mechanically_valid_admission_identity_required_before_high_risk_local_evidence",
      "product_authority_change_requires_explicit_domain_spec_update",
    ],
    semantic_constraints: [
      "local_admission_records_must_not_promote_operational_runtime_state",
      "local_admission_records_must_not_be_used_as_product_authority",
      "local_admission_records_must_use_iso_8601_utc_admitted_at",
    ],
  };
}

async function resolveProjectContainedPath(projectRoot, inputPath, artifactLabel) {
  const absolutePath = path.resolve(projectRoot, inputPath);
  let resolvedProjectRoot;
  let resolvedPath;
  try {
    resolvedProjectRoot = await realpath(projectRoot);
    resolvedPath = await realpath(absolutePath);
  } catch {
    return {
      ok: false,
      path: absolutePath,
      reason: `cannot read ${artifactLabel} at ${absolutePath}`,
    };
  }
  const relative = path.relative(resolvedProjectRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      path: absolutePath,
      reason: `${artifactLabel} must resolve inside the current project root`,
    };
  }
  return {
    ok: true,
    path: resolvedPath,
  };
}

function translateAdmissionReason(reason) {
  const translations = new Map([
    ["imported decision payload must declare contractVersion nimicoding.high-risk-decision.v1", "导入的 decision payload 必须声明 contractVersion nimicoding.high-risk-decision.v1"],
    ["imported decision payload must declare skill.id high_risk_execution", "导入的 decision payload 必须声明 skill.id 为 high_risk_execution"],
    ["imported decision payload must remain localOnly true", "导入的 decision payload 必须保持 localOnly 为 true"],
    ["admit-high-risk-decision requires a decision payload with ok true", "admit-high-risk-decision 需要一个 ok 为 true 的 decision payload"],
    ["admit-high-risk-decision requires decisionStatus manager_decision_recorded", "admit-high-risk-decision 需要 decisionStatus 为 manager_decision_recorded"],
    ["admit-high-risk-decision requires mechanically valid acceptance state", "admit-high-risk-decision 需要机械校验通过的 acceptance 状态"],
    ["imported decision payload must include attachmentRefs.packet_ref", "导入的 decision payload 必须包含 attachmentRefs.packet_ref"],
    ["attached packet_ref failed mechanical validation", "附加的 packet_ref 未通过机械校验"],
    ["attached packet_ref is missing packet_id or topic_id", "附加的 packet_ref 缺少 packet_id 或 topic_id"],
    ["Bootstrap or handoff validation is failing; repair doctor errors before semantic admission", "bootstrap 或 handoff 校验失败；请先修复 doctor 报错，再进行语义准入"],
    ["Local admission evidence requires the canonical tree under `.nimi/spec`", "local admission evidence 需要 `.nimi/spec` 下的 canonical tree"],
    ["Manager-owned local decision is ready for explicit local admission evidence", "manager 拥有的本地 decision 已准备好写入显式 local admission evidence"],
  ]);
  return translations.get(reason) ?? reason;
}

async function loadImportedDecisionPayload(projectRoot, fromPath) {
  const containedPath = await resolveProjectContainedPath(projectRoot, fromPath, "imported decision JSON");
  if (!containedPath.ok) {
    return {
      ok: false,
      error: `${localize(
        `nimicoding admit-high-risk-decision refused: ${containedPath.reason}.`,
        `nimicoding admit-high-risk-decision 已拒绝：${containedPath.reason}。`,
      )}\n`,
    };
  }

  const rawText = await readTextIfFile(containedPath.path);

  if (rawText === null) {
    return {
      ok: false,
      error: `${localize(
        `nimicoding admit-high-risk-decision refused: cannot read imported decision JSON at ${containedPath.path}.`,
        `nimicoding admit-high-risk-decision 已拒绝：无法读取 ${containedPath.path} 处的导入 decision JSON。`,
      )}\n`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      error: `${localize(
        `nimicoding admit-high-risk-decision refused: imported decision JSON at ${containedPath.path} is invalid JSON.`,
        `nimicoding admit-high-risk-decision 已拒绝：${containedPath.path} 处的导入 decision JSON 不是合法 JSON。`,
      )}\n`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: `${localize(
        "nimicoding admit-high-risk-decision refused: imported decision JSON must be an object.",
        "nimicoding admit-high-risk-decision 已拒绝：导入的 decision JSON 必须是对象。",
      )}\n`,
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
        error: `${localize(
          "nimicoding admit-high-risk-decision refused: imported decision projectRoot could not be resolved.",
          "nimicoding admit-high-risk-decision 已拒绝：无法解析导入 decision 的 projectRoot。",
        )}\n`,
      };
    }

    if (importedProjectRoot !== currentProjectRoot) {
      return {
        ok: false,
        error: `${localize(
          "nimicoding admit-high-risk-decision refused: imported decision projectRoot does not match the current project.",
          "nimicoding admit-high-risk-decision 已拒绝：导入 decision 的 projectRoot 与当前项目不匹配。",
        )}\n`,
      };
    }
  }

  return {
    ok: true,
    path: containedPath.path,
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

async function loadAdmissionsEvidence(projectRoot, contract) {
  const absolutePath = path.join(projectRoot, ADMISSIONS_EVIDENCE_REF);
  const text = await readTextIfFile(absolutePath);

  if (text === null) {
    const parsed = emptyAdmissionsEvidence();
    const validation = validateHighRiskAdmissionsSpec(parsed, contract);
    return {
      ok: validation.ok,
      path: absolutePath,
      parsed,
      reason: validation.ok ? null : validation.reason,
      initialized: true,
    };
  }

  const parsed = parseYamlText(text);
  const validation = validateHighRiskAdmissionsSpec(parsed, contract);

  return {
    ok: validation.ok,
    path: absolutePath,
    parsed,
    reason: validation.ok ? null : validation.reason,
    initialized: false,
  };
}

async function loadPacketIdentity(projectRoot, packetRef) {
  const containedPath = await resolveProjectContainedPath(projectRoot, packetRef, "attached packet_ref");
  if (!containedPath.ok) {
    return {
      ok: false,
      reason: containedPath.reason,
    };
  }

  const packetValidation = await validateExecutionPacket(containedPath.path);
  if (!packetValidation.ok) {
    return {
      ok: false,
      reason: "attached packet_ref failed mechanical validation",
      validation: packetValidation,
    };
  }

  const text = await readTextIfFile(containedPath.path);
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

function evaluateAdmissionReadiness(doctorResult, admissionsEvidence, packetIdentity) {
  if (!doctorResult.ok || !doctorResult.handoffReadiness.ok) {
    return {
      ok: false,
      reason: "Bootstrap or handoff validation is failing; repair doctor errors before semantic admission",
    };
  }

  const v2Ready = doctorResult.specGenerationInputs?.mode === "class_filtered"
    && doctorResult.canonicalTree?.requiredFilesValid === true;
  const legacyReady = doctorResult.lifecycleState?.treeState === "canonical_tree_ready"
    && doctorResult.canonicalTree?.requiredFilesValid === true;
  if (!v2Ready && !legacyReady) {
    return {
      ok: false,
      reason: "Local admission evidence requires canonical_tree_ready with declared canonical files present",
    };
  }

  if (!admissionsEvidence.ok) {
    return {
      ok: false,
      reason: admissionsEvidence.reason,
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
    reason: "Manager-owned local decision is ready for explicit local admission evidence",
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
      error: `${localize(
        `nimicoding admit-high-risk-decision refused: ${decisionValidation.reason}.`,
        `nimicoding admit-high-risk-decision 已拒绝：${translateAdmissionReason(decisionValidation.reason)}。`,
      )}\n`,
    };
  }

  if (!isIsoUtcTimestamp(options.admittedAt)) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `${localize(
        "nimicoding admit-high-risk-decision refused: --admitted-at must be an ISO-8601 UTC timestamp.",
        "nimicoding admit-high-risk-decision 已拒绝：`--admitted-at` 必须是 ISO-8601 UTC 时间戳。",
      )}\n`,
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
      semanticTargetRef: ADMISSIONS_EVIDENCE_REF,
      artifactPath: path.join(projectRoot, ADMISSIONS_EVIDENCE_REF),
      skill: {
        id: "high_risk_execution",
      },
      localOnly: true,
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
      nextEvidenceYaml: null,
      nextAction: `${HIGH_RISK_ADMISSION_CONTRACT_REF} must satisfy the package-owned local admission evidence contract.`,
    };
  }

  const doctorResult = await inspectDoctorState(projectRoot);
  const admissionsEvidence = await loadAdmissionsEvidence(projectRoot, admissionsContract);
  const packetIdentity = await loadPacketIdentity(projectRoot, imported.payload.attachmentRefs.packet_ref);
  const readiness = evaluateAdmissionReadiness(doctorResult, admissionsEvidence, packetIdentity);

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
    ? upsertAdmissionRecord(admissionsEvidence.parsed.admissions, admissionRecord)
    : { admissions: admissionsEvidence.parsed?.admissions ?? [], action: "blocked" };

  const nextEvidenceObject = admissionsEvidence.ok ? {
    admissions: nextAdmissions.admissions,
    admission_rules: admissionsEvidence.parsed.admission_rules,
    semantic_constraints: admissionsEvidence.parsed.semantic_constraints,
  } : null;
  const nextEvidenceValidation = nextEvidenceObject ? validateHighRiskAdmissionsSpec(nextEvidenceObject, admissionsContract) : { ok: false };

  return {
    contractVersion: HIGH_RISK_ADMISSION_PAYLOAD_CONTRACT_VERSION,
    ok: readiness.ok && nextEvidenceValidation.ok,
    exitCode: readiness.ok && nextEvidenceValidation.ok ? 0 : 1,
    projectRoot,
    sourceDecisionRef: imported.path,
    semanticTargetRef: ADMISSIONS_EVIDENCE_REF,
    artifactPath: path.join(projectRoot, ADMISSIONS_EVIDENCE_REF),
    skill: {
      id: "high_risk_execution",
    },
    localOnly: true,
    admittedAt: options.admittedAt,
    admissionAction: nextAdmissions.action,
    admissionRecord,
    readiness: readiness.ok && !nextEvidenceValidation.ok
      ? {
        ok: false,
        reason: nextEvidenceValidation.reason,
      }
      : readiness,
    doctor: {
      ok: doctorResult.ok,
      handoffReadiness: doctorResult.handoffReadiness,
      delegatedContracts: doctorResult.delegatedContracts,
    },
    nextEvidenceYaml: nextEvidenceObject ? YAML.stringify(nextEvidenceObject) : null,
    nextAction: readiness.ok && nextEvidenceValidation.ok
      ? options.writeLocal
        ? `Write local admission evidence to ${ADMISSIONS_EVIDENCE_REF}.`
        : `Review the local admission evidence preview or write it with --write-local.`
      : readiness.ok && !nextEvidenceValidation.ok
        ? nextEvidenceValidation.reason
        : readiness.reason,
  };
}

export async function writeHighRiskAdmission(projectRoot, payload) {
  if (!payload.ok || typeof payload.nextEvidenceYaml !== "string") {
    return;
  }

  await mkdir(path.dirname(path.join(projectRoot, ADMISSIONS_EVIDENCE_REF)), { recursive: true });
  await writeFile(path.join(projectRoot, ADMISSIONS_EVIDENCE_REF), payload.nextEvidenceYaml, "utf8");
}

export function formatHighRiskAdmissionPayload(payload) {
  const nextAction = payload.ok
    ? payload.nextAction.startsWith("Write local admission evidence to ")
      ? localize(payload.nextAction, `将 local admission evidence 写入 ${payload.semanticTargetRef}。`)
      : localize(
        payload.nextAction,
        `检查 local admission evidence 预览，或使用 ${styleCommand("--write-local")} 将其写入。`,
      )
    : localize(payload.nextAction, translateAdmissionReason(payload.nextAction)
      .replace(`${HIGH_RISK_ADMISSION_CONTRACT_REF} is missing or malformed`, `${HIGH_RISK_ADMISSION_CONTRACT_REF} 缺失或格式错误`)
      .replace(`${HIGH_RISK_ADMISSION_CONTRACT_REF} must satisfy the package-owned local admission evidence contract.`, `${HIGH_RISK_ADMISSION_CONTRACT_REF} 必须满足包内 local admission evidence 契约。`));
  const lines = [
    styleHeading(`nimicoding admit-high-risk-decision: ${payload.projectRoot}`),
    "",
    styleLabel(localize("Admission:", "准入：")),
    `  - target_ref: ${payload.semanticTargetRef}`,
    `  - action: ${payload.admissionAction}`,
    `  - ready: ${styleStatus(payload.readiness.ok ? "ready" : "needs_attention")}`,
    `  - local_only: ${payload.localOnly ? "true" : "false"}`,
  ];

  if (payload.admissionRecord) {
    lines.push(`  - topic_id: ${payload.admissionRecord.topic_id}`);
    lines.push(`  - packet_id: ${payload.admissionRecord.packet_id}`);
    lines.push(`  - disposition: ${payload.admissionRecord.disposition}`);
  }

  lines.push("", styleLabel(localize("Next:", "下一步：")), `  - ${nextAction}`);
  return `${lines.join("\n")}\n`;
}
