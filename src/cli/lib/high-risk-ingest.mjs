import path from "node:path";

import {
  EXTERNAL_EXECUTION_ARTIFACTS_CONFIG_REF,
  HIGH_RISK_EXECUTION_RESULT_CONTRACT_REF,
  HIGH_RISK_INGEST_PAYLOAD_CONTRACT_VERSION,
} from "../constants.mjs";
import {
  loadHighRiskExecutionContract,
  validateHighRiskExecutionSummary,
} from "./contracts.mjs";
import {
  loadExternalExecutionArtifactsConfig,
  validateHighRiskExecutionArtifactRefs,
} from "./external-execution.mjs";
import { pathExists } from "./fs-helpers.mjs";
import { inspectDoctorState } from "./doctor.mjs";
import { loadImportedCloseoutOptions } from "./closeout.mjs";
import {
  validateExecutionPacket,
  validateOrchestrationState,
  validatePrompt,
  validateWorkerOutput,
} from "./validators.mjs";

function projectValidation(ref, report) {
  return {
    ref,
    ok: Boolean(report.ok),
    refusal: report.refusal ?? null,
    errors: report.errors ?? [],
    warnings: report.warnings ?? [],
    ...(report.signal ? { signal: report.signal } : {}),
  };
}

async function validateEvidenceRefs(projectRoot, refs) {
  const results = [];

  for (const ref of refs) {
    const absolutePath = path.resolve(projectRoot, ref);
    const info = await pathExists(absolutePath);
    results.push({
      ref,
      ok: Boolean(info?.isFile()),
      errors: info?.isFile() ? [] : [`missing evidence artifact: ${ref}`],
      warnings: [],
    });
  }

  return results;
}

async function validateReferencedArtifacts(projectRoot, summary) {
  const packetRef = path.resolve(projectRoot, summary.packet_ref);
  const orchestrationStateRef = path.resolve(projectRoot, summary.orchestration_state_ref);
  const promptRef = path.resolve(projectRoot, summary.prompt_ref);
  const workerOutputRef = path.resolve(projectRoot, summary.worker_output_ref);

  const [
    executionPacket,
    orchestrationState,
    prompt,
    workerOutput,
    evidence,
  ] = await Promise.all([
    validateExecutionPacket(packetRef),
    validateOrchestrationState(orchestrationStateRef),
    validatePrompt(promptRef),
    validateWorkerOutput(workerOutputRef),
    validateEvidenceRefs(projectRoot, summary.evidence_refs),
  ]);

  return {
    executionPacket: projectValidation(summary.packet_ref, executionPacket),
    orchestrationState: projectValidation(summary.orchestration_state_ref, orchestrationState),
    prompt: projectValidation(summary.prompt_ref, prompt),
    workerOutput: projectValidation(summary.worker_output_ref, workerOutput),
    evidence,
  };
}

function validateHighRiskIngestInput(importedOptions, summaryValidation, rootsValidation) {
  if (importedOptions.skill !== "high_risk_execution") {
    return {
      ok: false,
      reason: "imported closeout must declare skill high_risk_execution",
    };
  }

  if (importedOptions.outcome !== "completed") {
    return {
      ok: false,
      reason: "high-risk ingest requires a completed high_risk_execution closeout artifact",
    };
  }

  if (!importedOptions.summary) {
    return {
      ok: false,
      reason: "high-risk ingest requires an imported summary",
    };
  }

  if (!summaryValidation.ok) {
    return summaryValidation;
  }

  if (importedOptions.summary.status !== "candidate_ready") {
    return {
      ok: false,
      reason: "high-risk ingest requires summary.status candidate_ready",
    };
  }

  if (!rootsValidation.ok) {
    return rootsValidation;
  }

  return { ok: true };
}

function evaluateHighRiskIngestReadiness(doctorResult, validations) {
  if (!doctorResult.ok || !doctorResult.handoffReadiness.ok) {
    return {
      ok: false,
      reason: "Bootstrap or handoff validation is failing; repair doctor errors before ingesting external execution artifacts",
    };
  }

  if (doctorResult.targetTruth.missing.length > 0 || doctorResult.targetTruth.invalid.length > 0) {
    return {
      ok: false,
      reason: "High-risk ingest requires reconstructed `.nimi/spec/*.yaml` target truth",
    };
  }

  const mechanicalChecksOk = validations.executionPacket.ok
    && validations.orchestrationState.ok
    && validations.prompt.ok
    && validations.workerOutput.ok
    && validations.evidence.every((entry) => entry.ok);

  if (!mechanicalChecksOk) {
    return {
      ok: false,
      reason: "One or more external execution candidate artifacts failed mechanical validation",
    };
  }

  return {
    ok: true,
    reason: "External execution candidate artifacts passed bounded ingest validation",
  };
}

export async function buildHighRiskIngestPayload(projectRoot, fromPath, options = {}) {
  const sourceCloseoutRef = path.resolve(projectRoot, fromPath);
  const imported = await loadImportedCloseoutOptions(projectRoot, fromPath);
  if (!imported.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: imported.error,
    };
  }

  const highRiskContract = await loadHighRiskExecutionContract(projectRoot);
  if (!highRiskContract.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: "nimicoding ingest-high-risk-execution refused: high_risk_execution result contract is missing or malformed.\n",
    };
  }

  const externalExecutionArtifacts = await loadExternalExecutionArtifactsConfig(projectRoot);
  if (!externalExecutionArtifacts.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: "nimicoding ingest-high-risk-execution refused: external execution artifacts config is missing or malformed.\n",
    };
  }

  const summaryValidation = validateHighRiskExecutionSummary(
    imported.options.summary,
    highRiskContract,
    imported.options.verifiedAt,
  );
  const rootsValidation = imported.options.summary
    ? validateHighRiskExecutionArtifactRefs(imported.options.summary, externalExecutionArtifacts)
    : { ok: true };
  const ingestInputValidation = validateHighRiskIngestInput(
    imported.options,
    summaryValidation,
    rootsValidation,
  );

  if (!ingestInputValidation.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `nimicoding ingest-high-risk-execution refused: ${ingestInputValidation.reason}.\n`,
    };
  }

  const validations = await validateReferencedArtifacts(projectRoot, imported.options.summary);
  const doctorResult = await inspectDoctorState(projectRoot);
  const readiness = evaluateHighRiskIngestReadiness(doctorResult, validations);
  const artifactPath = path.join(
    projectRoot,
    ".nimi",
    "local",
    "handoff-results",
    "high_risk_execution.ingest.json",
  );

  return {
    contractVersion: HIGH_RISK_INGEST_PAYLOAD_CONTRACT_VERSION,
    ok: readiness.ok,
    exitCode: readiness.ok ? 0 : 1,
    projectRoot,
    sourceCloseoutRef,
    localOnly: true,
    artifactPath,
    skill: {
      id: "high_risk_execution",
      resultContractRef: HIGH_RISK_EXECUTION_RESULT_CONTRACT_REF,
      artifactContractRef: EXTERNAL_EXECUTION_ARTIFACTS_CONFIG_REF,
    },
    outcome: imported.options.outcome,
    verifiedAt: imported.options.verifiedAt,
    summary: imported.options.summary,
    artifactRoots: externalExecutionArtifacts.artifactRoots,
    validations,
    readiness,
    doctor: {
      ok: doctorResult.ok,
      handoffReadiness: doctorResult.handoffReadiness,
      delegatedContracts: doctorResult.delegatedContracts,
    },
    nextAction: readiness.ok
      ? options.writeLocal
        ? `Write the high-risk ingest artifact to ${artifactPath}.`
        : "Review the ingest payload or write it locally with `--write-local`."
      : readiness.reason,
  };
}

export function formatHighRiskIngestPayload(payload) {
  const lines = [
    `nimicoding ingest-high-risk-execution: ${payload.projectRoot}`,
    "",
    "Source:",
    `  - closeout_ref: ${payload.sourceCloseoutRef}`,
    `  - verified_at: ${payload.verifiedAt}`,
    "",
    "Result:",
    `  - ready: ${payload.readiness.ok ? "true" : "false"}`,
    `  - local_only: ${payload.localOnly ? "true" : "false"}`,
    "",
    "Mechanical Validation:",
    `  - execution_packet: ${payload.validations.executionPacket.ok ? "ok" : "invalid"}`,
    `  - orchestration_state: ${payload.validations.orchestrationState.ok ? "ok" : "invalid"}`,
    `  - prompt: ${payload.validations.prompt.ok ? "ok" : "invalid"}`,
    `  - worker_output: ${payload.validations.workerOutput.ok ? "ok" : "invalid"}`,
    `  - evidence: ${payload.validations.evidence.every((entry) => entry.ok) ? "ok" : "invalid"}`,
    "",
    "Next:",
    `  - ${payload.nextAction}`,
  ];

  return `${lines.join("\n")}\n`;
}
