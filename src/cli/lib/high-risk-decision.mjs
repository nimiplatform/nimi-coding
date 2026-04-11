import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  HIGH_RISK_DECISION_PAYLOAD_CONTRACT_VERSION,
  HIGH_RISK_EXECUTION_RESULT_CONTRACT_REF,
} from "../constants.mjs";
import { inspectDoctorState } from "./doctor.mjs";
import { readTextIfFile } from "./fs-helpers.mjs";
import { validateAcceptance } from "./validators.mjs";
import { isIsoUtcTimestamp, isPlainObject } from "./value-helpers.mjs";

async function loadImportedReviewPayload(projectRoot, fromPath) {
  const absolutePath = path.resolve(projectRoot, fromPath);
  const rawText = await readTextIfFile(absolutePath);

  if (rawText === null) {
    return {
      ok: false,
      error: `nimicoding decide-high-risk-execution refused: cannot read imported review JSON at ${absolutePath}.\n`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      error: `nimicoding decide-high-risk-execution refused: imported review JSON at ${absolutePath} is invalid JSON.\n`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "nimicoding decide-high-risk-execution refused: imported review JSON must be an object.\n",
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
        error: "nimicoding decide-high-risk-execution refused: imported review projectRoot could not be resolved.\n",
      };
    }

    if (importedProjectRoot !== currentProjectRoot) {
      return {
        ok: false,
        error: "nimicoding decide-high-risk-execution refused: imported review projectRoot does not match the current project.\n",
      };
    }
  }

  return {
    ok: true,
    path: absolutePath,
    payload: parsed,
  };
}

function validateImportedReviewPayload(payload) {
  if (payload.contractVersion !== "nimicoding.high-risk-review.v1") {
    return {
      ok: false,
      reason: "imported review payload must declare contractVersion nimicoding.high-risk-review.v1",
    };
  }

  if (payload.skill?.id !== "high_risk_execution") {
    return {
      ok: false,
      reason: "imported review payload must declare skill.id high_risk_execution",
    };
  }

  if (payload.localOnly !== true) {
    return {
      ok: false,
      reason: "imported review payload must remain localOnly true",
    };
  }

  if (payload.ok !== true) {
    return {
      ok: false,
      reason: "decide-high-risk-execution requires a review payload with ok true",
    };
  }

  if (payload.reviewStatus !== "ready_for_manager_review") {
    return {
      ok: false,
      reason: "decide-high-risk-execution requires reviewStatus ready_for_manager_review",
    };
  }

  if (!isPlainObject(payload.attachmentRefs)) {
    return {
      ok: false,
      reason: "imported review payload must include attachmentRefs",
    };
  }

  return { ok: true };
}

function extractAcceptanceDisposition(text) {
  const match = text.match(/Disposition:\s*(\w+)/i);
  return match ? match[1].toLowerCase() : null;
}

function evaluateDecisionReadiness(doctorResult, acceptanceReport) {
  if (!doctorResult.ok || !doctorResult.handoffReadiness.ok) {
    return {
      ok: false,
      reason: "Bootstrap or handoff validation is failing; repair doctor errors before recording a manager decision",
    };
  }

  if (doctorResult.targetTruth.missing.length > 0 || doctorResult.targetTruth.invalid.length > 0) {
    return {
      ok: false,
      reason: "High-risk decision projection requires reconstructed `.nimi/spec/*.yaml` target truth",
    };
  }

  if (!acceptanceReport.ok) {
    return {
      ok: false,
      reason: "Acceptance artifact failed mechanical validation",
    };
  }

  return {
    ok: true,
    reason: "Manager-owned local decision record is ready",
  };
}

export async function buildHighRiskDecisionPayload(projectRoot, options) {
  const imported = await loadImportedReviewPayload(projectRoot, options.fromPath);
  if (!imported.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: imported.error,
    };
  }

  const inputValidation = validateImportedReviewPayload(imported.payload);
  if (!inputValidation.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `nimicoding decide-high-risk-execution refused: ${inputValidation.reason}.\n`,
    };
  }

  if (!isIsoUtcTimestamp(options.verifiedAt)) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: "nimicoding decide-high-risk-execution refused: --verified-at must be an ISO-8601 UTC timestamp.\n",
    };
  }

  const acceptanceRef = path.resolve(projectRoot, options.acceptancePath);
  const acceptanceText = await readTextIfFile(acceptanceRef);
  if (acceptanceText === null) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `nimicoding decide-high-risk-execution refused: cannot read acceptance artifact at ${acceptanceRef}.\n`,
    };
  }

  const acceptanceReport = await validateAcceptance(acceptanceRef);
  const disposition = extractAcceptanceDisposition(acceptanceText);
  if (!disposition) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: "nimicoding decide-high-risk-execution refused: acceptance artifact must declare a Disposition line.\n",
    };
  }

  const doctorResult = await inspectDoctorState(projectRoot);
  const readiness = evaluateDecisionReadiness(doctorResult, acceptanceReport);
  const artifactPath = path.join(
    projectRoot,
    ".nimi",
    "local",
    "handoff-results",
    "high_risk_execution.decision.json",
  );

  return {
    contractVersion: HIGH_RISK_DECISION_PAYLOAD_CONTRACT_VERSION,
    ok: readiness.ok,
    exitCode: readiness.ok ? 0 : 1,
    projectRoot,
    sourceReviewRef: imported.path,
    localOnly: true,
    artifactPath,
    skill: {
      id: "high_risk_execution",
      resultContractRef: HIGH_RISK_EXECUTION_RESULT_CONTRACT_REF,
    },
    verifiedAt: options.verifiedAt,
    managerReviewOwner: imported.payload.managerReviewOwner ?? doctorResult.delegatedContracts.semanticReviewOwner,
    decisionStatus: readiness.ok ? "manager_decision_recorded" : "blocked",
    acceptanceRef,
    acceptanceDisposition: disposition,
    acceptanceValidation: {
      ok: acceptanceReport.ok,
      refusal: acceptanceReport.refusal ?? null,
      errors: acceptanceReport.errors ?? [],
      warnings: acceptanceReport.warnings ?? [],
    },
    reviewStatus: imported.payload.reviewStatus,
    summary: imported.payload.summary,
    attachmentRefs: imported.payload.attachmentRefs,
    readiness,
    doctor: {
      ok: doctorResult.ok,
      handoffReadiness: doctorResult.handoffReadiness,
      delegatedContracts: doctorResult.delegatedContracts,
    },
    nextAction: readiness.ok
      ? options.writeLocal
        ? `Write the high-risk decision artifact to ${artifactPath}.`
        : "Review the local decision payload or write it locally with `--write-local`."
      : readiness.reason,
  };
}

export function formatHighRiskDecisionPayload(payload) {
  const lines = [
    `nimicoding decide-high-risk-execution: ${payload.projectRoot}`,
    "",
    "Decision:",
    `  - decision_status: ${payload.decisionStatus}`,
    `  - disposition: ${payload.acceptanceDisposition}`,
    `  - manager_review_owner: ${payload.managerReviewOwner ?? "unknown"}`,
    `  - ready: ${payload.readiness.ok ? "true" : "false"}`,
    `  - local_only: ${payload.localOnly ? "true" : "false"}`,
    "",
    "Next:",
    `  - ${payload.nextAction}`,
  ];

  return `${lines.join("\n")}\n`;
}
