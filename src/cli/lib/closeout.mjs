import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  CLOSEOUT_PAYLOAD_CONTRACT_VERSION,
  SKILL_RESULT_CONTRACT_REFS,
} from "../constants.mjs";
import {
  loadDocSpecAuditContract,
  loadHighRiskExecutionContract,
  loadSpecReconstructionContract,
  validateDocSpecAuditSummary,
  validateHighRiskExecutionSummary,
  validateSpecReconstructionSummary,
} from "./contracts.mjs";
import { inspectDoctorState } from "./doctor.mjs";
import {
  loadExternalExecutionArtifactsConfig,
  validateHighRiskExecutionArtifactRefs,
} from "./external-execution.mjs";
import { readTextIfFile } from "./fs-helpers.mjs";
import { isIsoUtcTimestamp, isPlainObject } from "./value-helpers.mjs";
import { parseSkillSection } from "./yaml-helpers.mjs";

async function validateCloseoutSummaryForSkill(projectRoot, skillId, summary, verifiedAt) {
  if (summary === undefined) {
    return { ok: true };
  }

  if (skillId === "spec_reconstruction") {
    const contract = await loadSpecReconstructionContract(projectRoot);
    if (!contract.ok) {
      return {
        ok: false,
        reason: "spec_reconstruction result contract is missing or malformed",
      };
    }

    return validateSpecReconstructionSummary(summary, contract, verifiedAt);
  }

  if (skillId === "doc_spec_audit") {
    const contract = await loadDocSpecAuditContract(projectRoot);
    if (!contract.ok) {
      return {
        ok: false,
        reason: "doc_spec_audit result contract is missing or malformed",
      };
    }

    return validateDocSpecAuditSummary(summary, contract, verifiedAt);
  }

  if (skillId === "high_risk_execution") {
    const contract = await loadHighRiskExecutionContract(projectRoot);
    if (!contract.ok) {
      return {
        ok: false,
        reason: "high_risk_execution result contract is missing or malformed",
      };
    }

    const summaryValidation = validateHighRiskExecutionSummary(summary, contract, verifiedAt);
    if (!summaryValidation.ok) {
      return summaryValidation;
    }

    const externalExecutionArtifacts = await loadExternalExecutionArtifactsConfig(projectRoot);
    return validateHighRiskExecutionArtifactRefs(summary, externalExecutionArtifacts);
  }

  return {
    ok: false,
    reason: `summary import is not supported for skill ${skillId}`,
  };
}

function validateOutcomeStatusConsistency(skillId, outcome, summary) {
  if (skillId !== "high_risk_execution" || summary === undefined) {
    return { ok: true };
  }

  const expectedStatusByOutcome = {
    completed: "candidate_ready",
    blocked: "blocked",
    failed: "failed",
  };
  const expectedStatus = expectedStatusByOutcome[outcome];

  if (summary.status !== expectedStatus) {
    return {
      ok: false,
      reason: `high_risk_execution summary.status must be ${expectedStatus} when outcome is ${outcome}`,
    };
  }

  return { ok: true };
}

function evaluateCloseoutReadiness(skillId, outcome, doctorResult) {
  if (!doctorResult.ok || !doctorResult.handoffReadiness.ok) {
    return {
      ok: false,
      reason: "Bootstrap or handoff validation is failing; repair doctor errors before projecting closeout results",
    };
  }

  if (outcome !== "completed") {
    return {
      ok: true,
      reason: "Non-completed outcomes may be projected as local-only closeout artifacts",
    };
  }

  if (skillId === "spec_reconstruction") {
    if (doctorResult.targetTruth.missing.length > 0 || doctorResult.targetTruth.invalid.length > 0) {
      return {
        ok: false,
        reason: "Completed spec reconstruction requires all declared `.nimi/spec/*.yaml` target truth files to exist and satisfy the section contract",
      };
    }

    return {
      ok: true,
      reason: "Completed spec reconstruction is consistent with reconstructed target truth",
    };
  }

  if (skillId === "doc_spec_audit" || skillId === "high_risk_execution") {
    if (doctorResult.targetTruth.missing.length > 0 || doctorResult.targetTruth.invalid.length > 0) {
      return {
        ok: false,
        reason: "Completed closeout for this skill requires reconstructed `.nimi/spec/*.yaml` target truth",
      };
    }
  }

  return {
    ok: true,
    reason: "Completed closeout is consistent with the current project-local truth",
  };
}

export async function validateImportedCloseoutShape(raw, projectRoot) {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: "nimicoding closeout refused: imported closeout JSON must be an object.\n",
    };
  }

  if (raw.projectRoot) {
    let importedProjectRoot;
    let currentProjectRoot;
    try {
      importedProjectRoot = await realpath(raw.projectRoot);
      currentProjectRoot = await realpath(projectRoot);
    } catch {
      return {
        ok: false,
        error: "nimicoding closeout refused: imported closeout projectRoot could not be resolved.\n",
      };
    }

    if (importedProjectRoot !== currentProjectRoot) {
      return {
        ok: false,
        error: "nimicoding closeout refused: imported closeout projectRoot does not match the current project.\n",
      };
    }
  }

  const skillId = typeof raw.skill === "string"
    ? raw.skill
    : raw.skill && typeof raw.skill === "object" && typeof raw.skill.id === "string"
      ? raw.skill.id
      : null;

  if (!skillId) {
    return {
      ok: false,
      error: "nimicoding closeout refused: imported closeout JSON must declare `skill.id`.\n",
    };
  }

  if (typeof raw.outcome !== "string" || !["completed", "blocked", "failed"].includes(raw.outcome)) {
    return {
      ok: false,
      error: "nimicoding closeout refused: imported closeout JSON must declare a supported `outcome`.\n",
    };
  }

  if (!isIsoUtcTimestamp(raw.verifiedAt)) {
    return {
      ok: false,
      error: "nimicoding closeout refused: imported `verifiedAt` must be an ISO-8601 UTC timestamp.\n",
    };
  }

  if ("localOnly" in raw && raw.localOnly !== true) {
    return {
      ok: false,
      error: "nimicoding closeout refused: imported closeout JSON cannot claim non-local semantic promotion.\n",
    };
  }

  if ("summary" in raw && !isPlainObject(raw.summary)) {
    return {
      ok: false,
      error: "nimicoding closeout refused: imported closeout JSON `summary` must be an object when present.\n",
    };
  }

  return {
    ok: true,
    options: {
      skill: skillId,
      outcome: raw.outcome,
      verifiedAt: raw.verifiedAt,
      summary: raw.summary,
    },
  };
}

export async function loadImportedCloseoutOptions(projectRoot, fromPath) {
  const absolutePath = path.resolve(projectRoot, fromPath);
  const rawText = await readTextIfFile(absolutePath);

  if (rawText === null) {
    return {
      ok: false,
      error: `nimicoding closeout refused: cannot read imported closeout JSON at ${absolutePath}.\n`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      error: `nimicoding closeout refused: imported closeout JSON at ${absolutePath} is invalid JSON.\n`,
    };
  }

  return validateImportedCloseoutShape(parsed, projectRoot);
}

export async function buildCloseoutPayload(projectRoot, options) {
  const doctorResult = await inspectDoctorState(projectRoot);
  const manifestText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skill-manifest.yaml"));
  const skillsConfigText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skills.yaml"));
  const manifestSkills = parseSkillSection(manifestText, "skills");
  const expectedSkills = parseSkillSection(skillsConfigText, "expected_skill_surfaces");
  const manifestSkill = manifestSkills.find((skill) => skill.id === options.skill) ?? null;
  const expectedSkill = expectedSkills.find((skill) => skill.id === options.skill) ?? null;

  if (!manifestSkill || !expectedSkill) {
    return {
      ok: false,
      exitCode: 1,
      error: `Unknown or undeclared skill id: ${options.skill}`,
      availableSkills: manifestSkills.map((skill) => skill.id),
      doctor: doctorResult,
    };
  }

  const resultContractRef = manifestSkill.result_contract_ref ?? SKILL_RESULT_CONTRACT_REFS[options.skill] ?? null;
  const summaryValidation = await validateCloseoutSummaryForSkill(
    projectRoot,
    options.skill,
    options.summary,
    options.verifiedAt,
  );

  if (!summaryValidation.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `nimicoding closeout refused: ${summaryValidation.reason}.\n`,
    };
  }

  const statusConsistency = validateOutcomeStatusConsistency(
    options.skill,
    options.outcome,
    options.summary,
  );
  if (!statusConsistency.ok) {
    return {
      ok: false,
      exitCode: 2,
      inputError: true,
      error: `nimicoding closeout refused: ${statusConsistency.reason}.\n`,
    };
  }

  const readiness = evaluateCloseoutReadiness(options.skill, options.outcome, doctorResult);
  const localArtifactPath = path.join(projectRoot, ".nimi", "local", "handoff-results", `${options.skill}.json`);
  const payload = {
    contractVersion: CLOSEOUT_PAYLOAD_CONTRACT_VERSION,
    ok: readiness.ok,
    exitCode: readiness.ok ? 0 : 1,
    projectRoot,
    skill: {
      id: options.skill,
      required: expectedSkill.required === "true",
      purpose: expectedSkill.purpose ?? null,
      source: manifestSkill.source ?? "external",
      resultContractRef,
    },
    outcome: options.outcome,
    verifiedAt: options.verifiedAt,
    localOnly: true,
    artifactPath: localArtifactPath,
    summary: options.summary,
    contracts: {
      exchangeProjectionContractRef: ".nimi/methodology/skill-exchange-projection.yaml",
      handoffRef: ".nimi/methodology/skill-handoff.yaml",
      resultContractRef,
    },
    readiness,
    targetTruth: doctorResult.targetTruth,
    doctor: {
      ok: doctorResult.ok,
      handoffReadiness: doctorResult.handoffReadiness,
      delegatedContracts: doctorResult.delegatedContracts,
      auditArtifact: doctorResult.auditArtifact,
    },
    nextAction: readiness.ok
      ? options.writeLocal
        ? `Write the closeout artifact to ${localArtifactPath}.`
        : "Review the projected closeout payload or write it locally with `--write-local`."
      : readiness.reason,
  };

  return payload;
}

export function formatCloseoutPayload(payload) {
  const lines = [
    `nimicoding closeout: ${payload.projectRoot}`,
    "",
    "Skill:",
    `  - id: ${payload.skill.id}`,
    `  - required: ${payload.skill.required ? "true" : "false"}`,
    `  - source: ${payload.skill.source}`,
    `  - purpose: ${payload.skill.purpose ?? "unknown"}`,
    `  - result_contract_ref: ${payload.skill.resultContractRef ?? "none"}`,
    "",
    "Result:",
    `  - outcome: ${payload.outcome}`,
    `  - verified_at: ${payload.verifiedAt}`,
    `  - ready: ${payload.readiness.ok ? "true" : "false"}`,
    `  - local_only: ${payload.localOnly ? "true" : "false"}`,
    "",
    "Target Truth:",
    `  - present: ${payload.targetTruth.present.length}`,
    `  - missing: ${payload.targetTruth.missing.length}`,
    "",
    "Next:",
    `  - ${payload.nextAction}`,
  ];

  if (payload.summary?.status) {
    lines.splice(lines.length - 3, 0, "", "Summary:", `  - status: ${payload.summary.status}`);
  }

  return `${lines.join("\n")}\n`;
}
