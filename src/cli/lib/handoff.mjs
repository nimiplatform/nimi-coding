import path from "node:path";

import {
  DOC_SPEC_AUDIT_RESULT_CONTRACT_REF,
  EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
  EXTERNAL_EXECUTION_ARTIFACTS_CONFIG_REF,
  HANDOFF_PAYLOAD_CONTRACT_VERSION,
  HOST_ADAPTER_CONFIG_REF,
  SKILL_RESULT_CONTRACT_REFS,
  SPEC_RECONSTRUCTION_RESULT_CONTRACT_REF,
} from "../constants.mjs";
import {
  loadDocSpecAuditContract,
  loadExternalHostCompatibilityContract,
  loadHighRiskSchemaContracts,
  loadSpecReconstructionContract,
} from "./contracts.mjs";
import { inspectDoctorState } from "./doctor.mjs";
import { loadExternalExecutionArtifactsConfig } from "./external-execution.mjs";
import { readTextIfFile } from "./fs-helpers.mjs";
import { mergeOrderedPaths, parseSkillSection, readYamlList } from "./yaml-helpers.mjs";

function evaluateSkillReadiness(skillId, doctorResult) {
  if (!doctorResult.ok || !doctorResult.handoffReadiness.ok) {
    return {
      ok: false,
      reason: "Bootstrap or handoff validation is failing; repair doctor errors before exporting handoff payloads",
    };
  }

  if (skillId === "spec_reconstruction") {
    return {
      ok: true,
      reason: "Projects may delegate spec reconstruction to an external AI host when lifecycle repair or reconstruction work is needed",
    };
  }

  if (doctorResult.targetTruth.missing.length > 0 || doctorResult.targetTruth.invalid.length > 0) {
    return {
      ok: false,
      reason: "This skill requires reconstructed `.nimi/spec/*.yaml` target truth before handoff",
    };
  }

  return {
    ok: true,
    reason: "Skill prerequisites are satisfied by the current project-local truth",
  };
}

function getSkillSpecificExpectations(
  skillId,
  resultContractRef,
  specContract,
  auditContract,
  highRiskSchemaContracts,
  externalExecutionArtifacts,
) {
  if (skillId === "spec_reconstruction") {
    return {
      compareTargets: [],
      closeoutSummaryFields: specContract.summaryRequiredFields,
      closeoutSummaryStatus: specContract.summaryStatusEnum,
      executionSchemaRefs: [],
      artifactRoots: {},
      expectedArtifactKinds: [],
      skillExpectedResults: [
        "produce_all_declared_target_truth_files",
        `satisfy_top_level_section_contract_declared_in_${resultContractRef}`,
      ],
    };
  }

  if (skillId === "doc_spec_audit") {
    return {
      compareTargets: auditContract.defaultComparedPaths,
      closeoutSummaryFields: auditContract.summaryRequiredFields,
      closeoutSummaryStatus: auditContract.summaryStatusEnum,
      executionSchemaRefs: [],
      artifactRoots: {},
      expectedArtifactKinds: [],
      skillExpectedResults: [
        `compare_${auditContract.defaultComparedPaths.join("_and_")}_against_.nimi/spec_truth`,
        `return_local_only_summary_that_satisfies_${resultContractRef}`,
      ],
    };
  }

  if (skillId === "high_risk_execution") {
    const executionSchemaRefs = highRiskSchemaContracts.map((entry) => entry.path);
    return {
      compareTargets: [".nimi/spec", ".nimi/contracts"],
      closeoutSummaryFields: [
        "packet_ref",
        "orchestration_state_ref",
        "prompt_ref",
        "worker_output_ref",
        "evidence_refs",
        "status",
        "summary",
        "verified_at",
      ],
      closeoutSummaryStatus: [
        "candidate_ready",
        "blocked",
        "failed",
      ],
      executionSchemaRefs,
      artifactRoots: externalExecutionArtifacts.artifactRoots ?? {},
      expectedArtifactKinds: [
        "execution-packet",
        "orchestration-state",
        "prompt",
        "worker-output",
        "acceptance",
      ],
      skillExpectedResults: [
        "use_seed_only_execution_contracts_without_claiming_runtime_ownership",
        "produce_packetized_high_risk_execution_artifacts_only_if_the_change_requires_methodology",
        `return_local_only_external_execution_summary_that_satisfies_${resultContractRef}`,
      ],
    };
  }

  return {
    compareTargets: [],
    closeoutSummaryFields: [],
    closeoutSummaryStatus: [],
    executionSchemaRefs: [],
    artifactRoots: {},
    expectedArtifactKinds: [],
    skillExpectedResults: [],
  };
}

export async function buildHandoffPayload(projectRoot, skillId) {
  const doctorResult = await inspectDoctorState(projectRoot);
  const manifestText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skill-manifest.yaml"));
  const skillsConfigText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skills.yaml"));
  const handoffText = await readTextIfFile(path.join(projectRoot, ".nimi", "methodology", "skill-handoff.yaml"));
  const specReconstructionText = await readTextIfFile(path.join(projectRoot, ".nimi", "methodology", "spec-reconstruction.yaml"));
  const specContract = await loadSpecReconstructionContract(projectRoot);
  const auditContract = await loadDocSpecAuditContract(projectRoot);
  const hostCompatibilityContract = await loadExternalHostCompatibilityContract(projectRoot);
  const externalExecutionArtifacts = await loadExternalExecutionArtifactsConfig(projectRoot);
  const highRiskSchemaContracts = await loadHighRiskSchemaContracts(projectRoot);

  const manifestSkills = parseSkillSection(manifestText, "skills");
  const expectedSkills = parseSkillSection(skillsConfigText, "expected_skill_surfaces");
  const manifestSkill = manifestSkills.find((skill) => skill.id === skillId) ?? null;
  const expectedSkill = expectedSkills.find((skill) => skill.id === skillId) ?? null;

  if (!manifestSkill || !expectedSkill) {
    return {
      ok: false,
      exitCode: 1,
      error: `Unknown or undeclared skill id: ${skillId}`,
      availableSkills: manifestSkills.map((skill) => skill.id),
      doctor: doctorResult,
    };
  }

  const readiness = evaluateSkillReadiness(skillId, doctorResult);
  const resultContractRef = manifestSkill.result_contract_ref ?? SKILL_RESULT_CONTRACT_REFS[skillId] ?? null;
  const handoffContextOrder = readYamlList(handoffText, "required_context_order");
  const skillInputs = manifestSkill.inputs ?? [];
  const orderedContext = mergeOrderedPaths(handoffContextOrder, skillInputs, [resultContractRef]);
  const hardConstraints = mergeOrderedPaths(
    readYamlList(handoffText, "hard_constraints"),
    skillId === "spec_reconstruction" ? readYamlList(specReconstructionText, "hard_constraints") : [],
  );
  const baseExpectedResults = readYamlList(handoffText, "expected_results");
  const skillSpecific = getSkillSpecificExpectations(
    skillId,
    resultContractRef,
    specContract,
    auditContract,
    highRiskSchemaContracts,
    externalExecutionArtifacts,
  );
  const expectedResults = mergeOrderedPaths(baseExpectedResults, skillSpecific.skillExpectedResults);

  return {
    contractVersion: HANDOFF_PAYLOAD_CONTRACT_VERSION,
    ok: readiness.ok,
    exitCode: readiness.ok ? 0 : 1,
    projectRoot,
    handoffSurface: {
      authoritativeMode: "json",
      promptMode: "human_projection_only",
      hostStrategy: "host_agnostic_external_host",
      hostCompatibilityRef: EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
      supportedHostPosture: hostCompatibilityContract.supportedHostPosture ?? [],
      supportedHostExamples: hostCompatibilityContract.supportedHostExamples ?? [],
      requiredHostBehavior: hostCompatibilityContract.requiredBehavior ?? [],
      forbiddenHostBehavior: hostCompatibilityContract.forbiddenBehavior ?? [],
      hostCompatibilitySummary: doctorResult.hostCompatibility ?? {
        contractRef: EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
        supportedHostPosture: hostCompatibilityContract.supportedHostPosture ?? [],
        supportedHostExamples: hostCompatibilityContract.supportedHostExamples ?? [],
        requiredBehavior: hostCompatibilityContract.requiredBehavior ?? [],
        forbiddenBehavior: hostCompatibilityContract.forbiddenBehavior ?? [],
        genericExternalHostCompatible: false,
        namedOverlaySupport: {
          mode: "generic_only",
          admittedOverlayIds: [],
          selectedOverlayId: null,
          selectedOverlayProfileRef: null,
          selectedOverlayHostClass: null,
        },
        futureOnlyHostSurfaces: [],
      },
    },
    runtimeOwner: doctorResult.delegatedContracts.runtimeOwner,
    triggerMode: doctorResult.delegatedContracts.triggerMode,
    handoffReady: doctorResult.handoffReadiness.ok,
    skill: {
      id: skillId,
      required: expectedSkill.required === "true",
      source: manifestSkill.source ?? "external",
      purpose: expectedSkill.purpose ?? null,
      inputs: skillInputs,
      resultContractRef,
      compareTargets: skillSpecific.compareTargets,
      expectedCloseoutSummaryFields: skillSpecific.closeoutSummaryFields,
      expectedCloseoutSummaryStatus: skillSpecific.closeoutSummaryStatus,
      executionSchemaRefs: skillSpecific.executionSchemaRefs,
      expectedArtifactRoots: skillSpecific.artifactRoots,
      expectedArtifactKinds: skillSpecific.expectedArtifactKinds,
      readiness,
    },
    contracts: {
      handoffRef: ".nimi/methodology/skill-handoff.yaml",
      runtimeContractRef: ".nimi/methodology/skill-runtime.yaml",
      manifestRef: ".nimi/config/skill-manifest.yaml",
      hostProfileRef: ".nimi/config/host-profile.yaml",
      hostAdapterRef: HOST_ADAPTER_CONFIG_REF,
      externalExecutionArtifactsRef: EXTERNAL_EXECUTION_ARTIFACTS_CONFIG_REF,
      installerRef: ".nimi/config/skill-installer.yaml",
      installerResultContractRef: ".nimi/methodology/skill-installer-result.yaml",
      installerSummaryProjectionContractRef: ".nimi/methodology/skill-installer-summary-projection.yaml",
      exchangeProjectionContractRef: ".nimi/methodology/skill-exchange-projection.yaml",
      reconstructionGuidanceRef: ".nimi/methodology/spec-reconstruction.yaml",
      reconstructionTargetTruthProfileRef: ".nimi/methodology/spec-target-truth-profile.yaml",
      resultContractRef,
    },
    context: {
      orderedPaths: orderedContext,
      handoffRequiredContextOrder: handoffContextOrder,
      skillInputs,
    },
    adapter: {
      selectedId: doctorResult.delegatedContracts.selectedAdapterId,
      admittedIds: doctorResult.delegatedContracts.admittedAdapterIds,
      handoffMode: doctorResult.delegatedContracts.adapterHandoffMode,
      semanticReviewOwner: doctorResult.delegatedContracts.semanticReviewOwner,
      profileRef: doctorResult.adapterProfiles.selected?.profileRef ?? null,
      hostClass: doctorResult.adapterProfiles.selected?.hostClass ?? null,
      upstreamSeedProfile: doctorResult.adapterProfiles.selected?.upstreamSeedProfile ?? null,
      purpose: doctorResult.adapterProfiles.selected?.purpose ?? null,
      operationalOwner: doctorResult.adapterProfiles.selected?.operationalOwner ?? [],
      currentGaps: doctorResult.adapterProfiles.selected?.currentGaps ?? [],
      futureSurface: doctorResult.adapterProfiles.selected?.promptHandoff?.futureSurface ?? [],
      futureSurfaceStatus: doctorResult.adapterProfiles.selected?.promptHandoff?.futureSurfaceStatus ?? null,
      admittedProfiles: doctorResult.adapterProfiles.admitted,
    },
    constraints: hardConstraints,
    expectedResults,
    targetTruth: doctorResult.targetTruth,
    doctor: {
      ok: doctorResult.ok,
      handoffReadiness: doctorResult.handoffReadiness,
      delegatedContracts: doctorResult.delegatedContracts,
      auditArtifact: doctorResult.auditArtifact,
      highRiskSchemaContracts: highRiskSchemaContracts.map((entry) => ({
        path: entry.path,
        ok: entry.ok,
      })),
    },
    nextAction: readiness.ok
      ? `Delegate explicit skill execution for \`${skillId}\` to ${doctorResult.delegatedContracts.runtimeOwner}.`
      : readiness.reason,
  };
}

export function formatHandoffPayload(payload) {
  const lines = [
    `nimicoding handoff: ${payload.projectRoot}`,
    "",
    "Skill:",
    `  - id: ${payload.skill.id}`,
    `  - required: ${payload.skill.required ? "true" : "false"}`,
    `  - source: ${payload.skill.source}`,
    `  - purpose: ${payload.skill.purpose ?? "unknown"}`,
    `  - result_contract_ref: ${payload.skill.resultContractRef ?? "none"}`,
    `  - ready: ${payload.skill.readiness.ok ? "true" : "false"}`,
    "",
    "Runtime:",
    `  - owner: ${payload.runtimeOwner ?? "unknown"}`,
    `  - trigger_mode: ${payload.triggerMode ?? "unknown"}`,
    `  - handoff_ready: ${payload.handoffReady ? "true" : "false"}`,
    `  - authoritative_mode: ${payload.handoffSurface.authoritativeMode}`,
    `  - prompt_mode: ${payload.handoffSurface.promptMode}`,
    `  - host_compatibility_ref: ${payload.handoffSurface.hostCompatibilityRef}`,
    `  - supported_host_posture: ${payload.handoffSurface.supportedHostPosture.join(", ") || "none"}`,
    `  - generic_external_host_compatible: ${payload.handoffSurface.hostCompatibilitySummary.genericExternalHostCompatible ? "true" : "false"}`,
    `  - named_overlay_mode: ${payload.handoffSurface.hostCompatibilitySummary.namedOverlaySupport.mode}`,
    "",
    "Adapter:",
    `  - selected_id: ${payload.adapter.selectedId ?? "unknown"}`,
    `  - admitted_ids: ${payload.adapter.admittedIds.length}`,
    `  - handoff_mode: ${payload.adapter.handoffMode ?? "unknown"}`,
    `  - semantic_review_owner: ${payload.adapter.semanticReviewOwner ?? "unknown"}`,
    `  - selected_profile_ref: ${payload.adapter.profileRef ?? "none"}`,
    "",
    "Context:",
    `  - ordered_paths: ${payload.context.orderedPaths.length}`,
    `  - skill_inputs: ${payload.context.skillInputs.length}`,
    "",
    "Target Truth:",
    `  - present: ${payload.targetTruth.present.length}`,
    `  - missing: ${payload.targetTruth.missing.length}`,
    "",
    "Next:",
    `  - ${payload.nextAction}`,
  ];

  return `${lines.join("\n")}\n`;
}

export function formatHandoffPrompt(payload) {
  const lines = [
    `You are the external AI host responsible for the declared \`${payload.skill.id}\` skill in project \`${payload.projectRoot}\`.`,
    "",
    "Use the JSON handoff payload as the authoritative machine contract.",
    "Treat this prompt as a human-readable projection of that same contract, not as a replacement runtime owner.",
    "",
    "This handoff surface is host-agnostic. Any external host may consume it if it respects the declared compatibility contract.",
    "",
    "Read this project-local truth first, in order:",
    ...payload.context.orderedPaths.map((entry, index) => `${index + 1}. ${entry}`),
    "",
    "Operate under these constraints:",
    ...payload.constraints.map((entry) => `- ${entry}`),
    "",
    "Expected results:",
    ...payload.expectedResults.map((entry) => `- ${entry}`),
    "",
    "Skill contract:",
    `- Skill id: ${payload.skill.id}`,
    `- Purpose: ${payload.skill.purpose ?? "unknown"}`,
    `- Runtime owner: ${payload.runtimeOwner ?? "unknown"}`,
    `- Trigger mode: ${payload.triggerMode ?? "unknown"}`,
    `- Result contract: ${payload.skill.resultContractRef ?? "none"}`,
    `- Host compatibility contract: ${payload.handoffSurface.hostCompatibilityRef}`,
    `- Host adapter: ${payload.adapter.selectedId ?? "none"}`,
    `- Semantic review owner: ${payload.adapter.semanticReviewOwner ?? "unknown"}`,
  ];

  if (payload.handoffSurface.supportedHostPosture.length > 0) {
    lines.push(`- Supported host posture: ${payload.handoffSurface.supportedHostPosture.join(", ")}`);
  }
  if (payload.handoffSurface.supportedHostExamples.length > 0) {
    lines.push(`- Supported external host examples: ${payload.handoffSurface.supportedHostExamples.join(", ")}`);
  }
  if (payload.handoffSurface.requiredHostBehavior.length > 0) {
    lines.push(`- Required host behavior: ${payload.handoffSurface.requiredHostBehavior.join(", ")}`);
  }
  if (payload.handoffSurface.forbiddenHostBehavior.length > 0) {
    lines.push(`- Forbidden host behavior: ${payload.handoffSurface.forbiddenHostBehavior.join(", ")}`);
  }
  lines.push(`- Generic external host compatible: ${payload.handoffSurface.hostCompatibilitySummary.genericExternalHostCompatible ? "true" : "false"}`);
  lines.push(`- Named overlay mode: ${payload.handoffSurface.hostCompatibilitySummary.namedOverlaySupport.mode}`);
  if (payload.handoffSurface.hostCompatibilitySummary.namedOverlaySupport.admittedOverlayIds.length > 0) {
    lines.push(`- Admitted named overlays: ${payload.handoffSurface.hostCompatibilitySummary.namedOverlaySupport.admittedOverlayIds.join(", ")}`);
  }
  if (payload.handoffSurface.hostCompatibilitySummary.futureOnlyHostSurfaces.length > 0) {
    lines.push(`- Future-only host surfaces: ${payload.handoffSurface.hostCompatibilitySummary.futureOnlyHostSurfaces.map((surface) => `${surface.adapterId}:${surface.command}:${surface.status ?? "unknown"}`).join(", ")}`);
  }

  if (payload.adapter.selectedId && payload.adapter.selectedId !== "none") {
    lines.push(`- Adapter handoff mode: ${payload.adapter.handoffMode ?? "unknown"}`);
    lines.push(`- Adapter profile ref: ${payload.adapter.profileRef ?? "unknown"}`);
    lines.push(`- Adapter host class: ${payload.adapter.hostClass ?? "unknown"}`);
    lines.push(`- Adapter upstream seed profile: ${payload.adapter.upstreamSeedProfile ?? "unknown"}`);
    if (payload.adapter.purpose) {
      lines.push(`- Adapter purpose: ${payload.adapter.purpose}`);
    }
    if (payload.adapter.operationalOwner.length > 0) {
      lines.push(`- Adapter operational owner roots: ${payload.adapter.operationalOwner.join(", ")}`);
    }
    if (payload.adapter.currentGaps.length > 0) {
      lines.push(`- Adapter current gaps: ${payload.adapter.currentGaps.join(", ")}`);
    }
    if (payload.adapter.futureSurface.length > 0) {
      lines.push(`- Adapter future-only surfaces: ${payload.adapter.futureSurface.join(", ")}`);
      lines.push(`- Adapter future-only surface status: ${payload.adapter.futureSurfaceStatus ?? "unknown"}`);
    }
    lines.push("- The adapter may route execution, but it must not decide semantic acceptance or final disposition.");
  }

  if (payload.skill.compareTargets.length > 0) {
    lines.push(`- Compare targets: ${payload.skill.compareTargets.join(", ")}`);
  }

  if (payload.skill.expectedCloseoutSummaryFields.length > 0) {
    lines.push(`- Expected closeout summary fields: ${payload.skill.expectedCloseoutSummaryFields.join(", ")}`);
  }

  if (payload.skill.expectedCloseoutSummaryStatus.length > 0) {
    lines.push(`- Expected closeout summary status: ${payload.skill.expectedCloseoutSummaryStatus.join(", ")}`);
  }

  if (payload.skill.executionSchemaRefs.length > 0) {
    lines.push(`- Execution schema refs: ${payload.skill.executionSchemaRefs.join(", ")}`);
  }

  if (Object.keys(payload.skill.expectedArtifactRoots).length > 0) {
    lines.push(`- Expected local artifact roots: ${Object.entries(payload.skill.expectedArtifactRoots).map(([field, value]) => `${field}=${value}`).join("; ")}`);
  }

  if (payload.skill.expectedArtifactKinds.length > 0) {
    lines.push(`- Expected artifact kinds: ${payload.skill.expectedArtifactKinds.join(", ")}`);
  }

  lines.push(
    "",
    "Rules:",
    "- Do not assume local skill installation or self-hosting.",
    "- Fail closed on unresolved authority, missing context, or contract drift.",
    "- Treat `.nimi/**` as the primary truth surface.",
  );

  if (payload.targetTruth.missing.length > 0) {
    lines.push(`- Remaining target truth gaps: ${payload.targetTruth.missing.join(", ")}`);
  }

  lines.push("", payload.nextAction);
  return `${lines.join("\n")}\n`;
}
