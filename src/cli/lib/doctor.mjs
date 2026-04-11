import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ACCEPTANCE_SCHEMA_REF,
  AGENTS_BEGIN,
  BOOTSTRAP_CONTRACT_VERSION,
  CLAUDE_BEGIN,
  DOC_SPEC_AUDIT_RESULT_CONTRACT_REF,
  EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
  EXTERNAL_EXECUTION_ARTIFACTS_CONFIG_REF,
  EXECUTION_PACKET_SCHEMA_REF,
  HIGH_RISK_ADMISSION_CONTRACT_REF,
  HIGH_RISK_EXECUTION_RESULT_CONTRACT_REF,
  HOST_ADAPTER_CONFIG_REF,
  LOCAL_GITIGNORE_ENTRIES,
  ORCHESTRATION_STATE_SCHEMA_REF,
  PACKAGE_NAME,
  PROMPT_SCHEMA_REF,
  REQUIRED_BOOTSTRAP_FILES,
  REQUIRED_LOCAL_DIRS,
  SPEC_RECONSTRUCTION_RESULT_CONTRACT_REF,
  STANDALONE_COMPLETED_SURFACES,
  STANDALONE_COMPLETION_PROFILE,
  STANDALONE_COMPLETION_STATUS,
  STANDALONE_DEFERRED_EXECUTION_SURFACES,
  STANDALONE_PROMOTED_PARITY_GAP_SUMMARY,
  TARGET_SPEC_FILES,
  TARGET_SPEC_REQUIRED_KEYS,
  WORKER_OUTPUT_SCHEMA_REF,
} from "../constants.mjs";
import {
  loadAdmittedAdapterProfiles,
  selectAdapterProfile,
} from "./adapter-profiles.mjs";
import { inspectBootstrapCompatibility } from "./bootstrap.mjs";
import {
  loadDocSpecAuditContract,
  loadExternalHostCompatibilityContract,
  loadHighRiskAdmissionContract,
  loadHighRiskExecutionContract,
  loadHighRiskSchemaContracts,
  loadSpecReconstructionContract,
  validateHighRiskAdmissionsSpec,
  validateDocSpecAuditSummary,
} from "./contracts.mjs";
import { loadExternalExecutionArtifactsConfig } from "./external-execution.mjs";
import { pathExists, readTextIfFile } from "./fs-helpers.mjs";
import { arraysEqual } from "./value-helpers.mjs";
import {
  parseSkillSection,
  parseYamlText,
  readTopLevelKeys,
  readYamlList,
  readYamlScalar,
} from "./yaml-helpers.mjs";

function buildCheck(id, ok, detail, severity = ok ? "ok" : "error") {
  return { id, ok, detail, severity };
}

function emptyDelegatedContracts() {
  return {
    runtimeOwner: null,
    executionMode: null,
    installerMode: null,
    selfHostedRuntime: false,
    triggerMode: null,
    expectedSkillIds: [],
    selectedAdapterId: null,
    admittedAdapterIds: [],
    adapterHandoffMode: null,
    semanticReviewOwner: null,
  };
}

function emptyHandoffReadiness() {
  return {
    ok: false,
    requiredContextOrder: [],
    missingContextEntries: [],
    missingPaths: [],
  };
}

function emptyAdapterProfiles() {
  return {
    admitted: [],
    invalid: [],
    selected: null,
  };
}

function emptyAuditArtifact() {
  return {
    present: false,
    ok: true,
    artifactPath: ".nimi/local/handoff-results/doc_spec_audit.json",
    outcome: null,
    summaryStatus: null,
    verifiedAt: null,
    reason: "No local doc_spec_audit closeout artifact detected",
  };
}

function emptyCompletionPosture() {
  return {
    completionProfile: null,
    completionStatus: STANDALONE_COMPLETION_STATUS.INCOMPLETE,
    completedSurfaces: [],
    deferredExecutionSurfaces: [],
    promotedParityGapSummary: [],
  };
}

const PACKAGE_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function inspectStandaloneCompletionTruth(productScopeText) {
  const parsed = parseYamlText(productScopeText);
  const completion = parsed?.standalone_completion;

  const completionProfile = typeof completion?.profile === "string" ? completion.profile : null;
  const completedSurfaces = Array.isArray(completion?.completed_surfaces)
    ? completion.completed_surfaces.map((entry) => String(entry))
    : [];
  const deferredExecutionSurfaces = Array.isArray(completion?.deferred_execution_surfaces)
    ? completion.deferred_execution_surfaces.map((entry) => String(entry))
    : [];
  const promotedParityGapSummary = Array.isArray(completion?.promoted_parity_gap_summary)
    ? completion.promoted_parity_gap_summary.map((entry) => String(entry))
    : [];

  const ok = completionProfile === STANDALONE_COMPLETION_PROFILE
    && arraysEqual(completedSurfaces, STANDALONE_COMPLETED_SURFACES)
    && arraysEqual(deferredExecutionSurfaces, STANDALONE_DEFERRED_EXECUTION_SURFACES)
    && arraysEqual(promotedParityGapSummary, STANDALONE_PROMOTED_PARITY_GAP_SUMMARY);

  return {
    ok,
    completionProfile,
    completedSurfaces,
    deferredExecutionSurfaces,
    promotedParityGapSummary,
  };
}

function inspectPackageBoundaryTruth(boundariesText, changePolicyText) {
  const boundaries = parseYamlText(boundariesText);
  const changePolicy = parseYamlText(changePolicyText);

  const boundaryOk = Array.isArray(boundaries?.boundaries)
    && boundaries.boundaries.some((entry) => entry?.boundary === "standalone_boundary_completion_vs_promoted_runtime_parity")
    && Array.isArray(boundaries?.invariants)
    && boundaries.invariants.includes("standalone completion posture remains boundary_complete rather than promoted_runtime_parity")
    && Array.isArray(boundaries?.fail_closed_rules)
    && boundaries.fail_closed_rules.includes("fail if package-owned standalone completion truth drifts into claiming run kernel, provider runtime, scheduler, notification, or automation ownership");

  const runtimeBoundaryWorkType = Array.isArray(changePolicy?.work_types)
    ? changePolicy.work_types.find((entry) => entry?.id === "runtime_boundary_expansion")
    : null;
  const runtimeBoundaryGate = Array.isArray(changePolicy?.authority_gates)
    ? changePolicy.authority_gates.find((entry) => entry?.gate === "runtime_boundary_preservation")
    : null;
  const changePolicyOk = Boolean(runtimeBoundaryWorkType)
    && typeof runtimeBoundaryWorkType.notes === "string"
    && runtimeBoundaryWorkType.notes.includes("topic lifecycle runtime")
    && runtimeBoundaryWorkType.notes.includes("packet-bound run kernel")
    && runtimeBoundaryWorkType.notes.includes("provider execution")
    && Boolean(runtimeBoundaryGate)
    && typeof runtimeBoundaryGate.enforcement === "string"
    && runtimeBoundaryGate.enforcement.includes("boundary-complete standalone");

  return {
    ok: boundaryOk && changePolicyOk,
    boundaryOk,
    changePolicyOk,
  };
}

function buildHostCompatibilityReport(externalHostCompatibilityContract, adapterProfiles, selectedAdapterId) {
  const admittedOverlayIds = adapterProfiles.admitted.map((profile) => profile.id).filter(Boolean);
  const selectedOverlayId = selectedAdapterId && selectedAdapterId !== "none" ? selectedAdapterId : null;
  const selectedOverlayProfile = adapterProfiles.selected ?? null;
  const futureOnlyHostSurfaces = adapterProfiles.admitted.flatMap((profile) => {
    const commands = profile.promptHandoff?.futureSurface ?? [];
    const status = profile.promptHandoff?.futureSurfaceStatus ?? null;
    return commands.map((command) => ({
      adapterId: profile.id,
      status,
      command,
    }));
  });

  let overlayMode = "generic_only";
  if (admittedOverlayIds.length > 0) {
    overlayMode = selectedOverlayId ? "named_admitted_overlay_selected" : "named_admitted_overlay_available";
  }

  return {
    contractRef: EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
    supportedHostPosture: externalHostCompatibilityContract.supportedHostPosture,
    supportedHostExamples: externalHostCompatibilityContract.supportedHostExamples,
    requiredBehavior: externalHostCompatibilityContract.requiredBehavior,
    forbiddenBehavior: externalHostCompatibilityContract.forbiddenBehavior,
    genericExternalHostCompatible: externalHostCompatibilityContract.ok
      && externalHostCompatibilityContract.supportedHostPosture.includes("host_agnostic_external_host"),
    namedOverlaySupport: {
      mode: overlayMode,
      admittedOverlayIds,
      selectedOverlayId,
      selectedOverlayProfileRef: selectedOverlayProfile?.profileRef ?? null,
      selectedOverlayHostClass: selectedOverlayProfile?.hostClass ?? null,
    },
    futureOnlyHostSurfaces,
  };
}

function emptyExecutionContracts() {
  return {
    total: 0,
    valid: 0,
    invalid: [],
    contracts: [],
  };
}

async function inspectLocalDocSpecAuditArtifact(projectRoot, auditContract) {
  const artifact = emptyAuditArtifact();
  const absolutePath = path.join(projectRoot, artifact.artifactPath);
  const text = await readTextIfFile(absolutePath);
  if (text === null) {
    return artifact;
  }

  artifact.present = true;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    artifact.ok = false;
    artifact.reason = "Local doc_spec_audit closeout artifact is not valid JSON";
    return artifact;
  }

  const skillId = typeof parsed.skill === "string"
    ? parsed.skill
    : parsed.skill && typeof parsed.skill === "object"
      ? parsed.skill.id
      : null;

  if (skillId !== "doc_spec_audit") {
    artifact.ok = false;
    artifact.reason = "Local doc_spec_audit closeout artifact declares the wrong skill id";
    return artifact;
  }

  artifact.outcome = parsed.outcome ?? null;
  artifact.verifiedAt = parsed.verifiedAt ?? null;

  if (!parsed.summary) {
    artifact.reason = `Local doc_spec_audit closeout artifact detected with outcome ${parsed.outcome ?? "unknown"}`;
    return artifact;
  }

  const validation = validateDocSpecAuditSummary(parsed.summary, auditContract, parsed.verifiedAt);
  if (!validation.ok) {
    artifact.ok = false;
    artifact.reason = validation.reason;
    return artifact;
  }

  artifact.summaryStatus = parsed.summary.status;
  artifact.reason = `Local doc_spec_audit closeout artifact detected: outcome ${parsed.outcome}, summary status ${parsed.summary.status}`;
  return artifact;
}

function inspectBootstrapStateContract(bootstrapStateText) {
  const parsed = parseYamlText(bootstrapStateText);
  const mode = parsed?.state?.mode ?? null;
  const reconstructionRequired = parsed?.state?.reconstruction_required;
  const readyForAiReconstruction = parsed?.status?.ready_for_ai_reconstruction;

  const supportedMode = mode === "bootstrap_only" || mode === "reconstruction_seeded";
  const modeSpecificContractOk = (
    mode === "bootstrap_only"
      && reconstructionRequired === true
      && readyForAiReconstruction === true
  ) || (
    mode === "reconstruction_seeded"
      && reconstructionRequired === false
      && readyForAiReconstruction === false
  );

  return {
    mode,
    supportedMode,
    reconstructionRequired,
    readyForAiReconstruction,
    ok: Boolean(bootstrapStateText) && supportedMode && modeSpecificContractOk,
  };
}

export async function inspectDoctorState(projectRoot) {
  const nimiRoot = path.join(projectRoot, ".nimi");
  const checks = [];

  const nimiInfo = await pathExists(nimiRoot);
  if (!nimiInfo) {
    checks.push(buildCheck("nimi_root", false, ".nimi directory is missing"));
    return {
      projectRoot,
      ok: false,
      bootstrapPresent: false,
      reconstructionRequired: false,
      runtimeInstalled: false,
      bootstrapContract: {
        status: "missing",
        id: null,
        version: null,
      },
      delegatedContracts: emptyDelegatedContracts(),
      adapterProfiles: emptyAdapterProfiles(),
      ...emptyCompletionPosture(),
      handoffReadiness: emptyHandoffReadiness(),
      checks,
      targetTruth: {
        present: [],
        missing: TARGET_SPEC_FILES.slice(),
        invalid: [],
      },
      auditArtifact: emptyAuditArtifact(),
      executionContracts: emptyExecutionContracts(),
      nextSteps: [
        "Run `nimicoding init` to seed the project-local .nimi bootstrap truth.",
      ],
    };
  }

  if (!nimiInfo.isDirectory()) {
    checks.push(buildCheck("nimi_root", false, ".nimi exists but is not a directory"));
    return {
      projectRoot,
      ok: false,
      bootstrapPresent: false,
      reconstructionRequired: false,
      runtimeInstalled: false,
      bootstrapContract: {
        status: "missing",
        id: null,
        version: null,
      },
      delegatedContracts: emptyDelegatedContracts(),
      adapterProfiles: emptyAdapterProfiles(),
      ...emptyCompletionPosture(),
      handoffReadiness: emptyHandoffReadiness(),
      checks,
      targetTruth: {
        present: [],
        missing: TARGET_SPEC_FILES.slice(),
        invalid: [],
      },
      auditArtifact: emptyAuditArtifact(),
      executionContracts: emptyExecutionContracts(),
      nextSteps: [
        "Replace the non-directory `.nimi` path, then rerun `nimicoding init` or `nimicoding repair`.",
      ],
    };
  }

  checks.push(buildCheck("nimi_root", true, ".nimi directory exists"));

  const missingBootstrapFiles = [];
  for (const relativePath of REQUIRED_BOOTSTRAP_FILES) {
    const info = await pathExists(path.join(projectRoot, relativePath));
    if (!info || !info.isFile()) {
      missingBootstrapFiles.push(relativePath);
    }
  }
  checks.push(
    buildCheck(
      "bootstrap_seed_files",
      missingBootstrapFiles.length === 0,
      missingBootstrapFiles.length === 0
        ? `All required bootstrap seed files are present (${REQUIRED_BOOTSTRAP_FILES.length}/${REQUIRED_BOOTSTRAP_FILES.length})`
        : `Missing required bootstrap seed files: ${missingBootstrapFiles.join(", ")}`,
    ),
  );

  const missingLocalDirs = [];
  for (const relativePath of REQUIRED_LOCAL_DIRS) {
    const info = await pathExists(path.join(projectRoot, relativePath));
    if (!info || !info.isDirectory()) {
      missingLocalDirs.push(relativePath);
    }
  }
  checks.push({
    id: "local_state_dirs",
    ok: true,
    severity: missingLocalDirs.length === 0 ? "ok" : "warn",
    detail: missingLocalDirs.length === 0
      ? "Local state directories are present"
      : `Local state directories are absent and can be recreated on demand: ${missingLocalDirs.join(", ")}`,
  });

  const gitignoreText = await readTextIfFile(path.join(projectRoot, ".gitignore"));
  const missingGitignoreEntries = gitignoreText === null
    ? LOCAL_GITIGNORE_ENTRIES.slice()
    : LOCAL_GITIGNORE_ENTRIES.filter((entry) => !gitignoreText.includes(entry));
  checks.push(
    buildCheck(
      "gitignore_local_state",
      missingGitignoreEntries.length === 0,
      missingGitignoreEntries.length === 0
        ? "Local runtime state is ignored by .gitignore"
        : `.gitignore is missing local-state entries: ${missingGitignoreEntries.join(", ")}`,
    ),
  );

  const bootstrapConfigText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "bootstrap.yaml"));
  const bootstrapIdentityOk = Boolean(bootstrapConfigText)
    && readYamlScalar(bootstrapConfigText, "initialized_by") === PACKAGE_NAME
    && Boolean(readYamlScalar(bootstrapConfigText, "cli_version"));
  checks.push(
    buildCheck(
      "bootstrap_config_contract",
      bootstrapIdentityOk,
      bootstrapIdentityOk
        ? "bootstrap.yaml declares the package bootstrap identity"
        : "bootstrap.yaml is missing or does not match the package bootstrap identity",
    ),
  );

  const bootstrapCompatibility = await inspectBootstrapCompatibility(projectRoot);
  checks.push({
    id: "bootstrap_contract_version",
    ok: bootstrapCompatibility.status !== "unsupported",
    severity: bootstrapCompatibility.status === "supported"
      ? "ok"
      : bootstrapCompatibility.status === "legacy"
        ? "warn"
        : bootstrapCompatibility.status === "missing"
          ? "warn"
          : "error",
    detail: bootstrapCompatibility.status === "supported"
      ? `bootstrap contract ${bootstrapCompatibility.contractId} version ${bootstrapCompatibility.contractVersion} is supported`
      : bootstrapCompatibility.status === "legacy"
        ? "bootstrap.yaml was created by nimicoding but is missing bootstrap contract metadata"
        : bootstrapCompatibility.status === "missing"
          ? "bootstrap.yaml is missing and bootstrap contract compatibility could not be checked"
          : "bootstrap.yaml declares an unsupported bootstrap contract id or version",
  });

  const bootstrapStateText = await readTextIfFile(path.join(projectRoot, ".nimi", "spec", "bootstrap-state.yaml"));
  const bootstrapStateContract = inspectBootstrapStateContract(bootstrapStateText);
  checks.push(
    buildCheck(
      "bootstrap_state_contract",
      bootstrapStateContract.ok,
      bootstrapStateContract.ok
        ? `bootstrap-state.yaml matches the ${bootstrapStateContract.mode} lifecycle contract`
        : "bootstrap-state.yaml is missing required lifecycle fields or declares an unsupported lifecycle mode",
    ),
  );

  const productScopeText = await readTextIfFile(path.join(projectRoot, ".nimi", "spec", "product-scope.yaml"));
  const completionTruth = inspectStandaloneCompletionTruth(productScopeText);
  checks.push(
    buildCheck(
      "standalone_completion_truth",
      completionTruth.ok,
      completionTruth.ok
        ? `Product scope declares standalone completion profile ${completionTruth.completionProfile}`
        : "product-scope.yaml is missing or drifted from the package-owned standalone completion truth",
    ),
  );

  const skillsConfigText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skills.yaml"));
  const skillsConfigOk = Boolean(skillsConfigText)
    && skillsConfigText.includes("runtime_installed: false")
    && skillsConfigText.includes("runtime_owner: external_ai_host")
    && skillsConfigText.includes("handoff_contract: .nimi/methodology/skill-handoff.yaml")
    && skillsConfigText.includes(`canonical_host_adapter: ${HOST_ADAPTER_CONFIG_REF}`);
  checks.push(
    buildCheck(
      "skills_contract",
      skillsConfigOk,
      skillsConfigOk
        ? "skills.yaml keeps runtime delegated and handoff-driven"
        : "skills.yaml is missing delegated runtime contract fields",
    ),
  );

  const handoffText = await readTextIfFile(path.join(projectRoot, ".nimi", "methodology", "skill-handoff.yaml"));
  const manifestText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skill-manifest.yaml"));
  const hostProfileText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "host-profile.yaml"));
  const hostAdapterText = await readTextIfFile(path.join(projectRoot, HOST_ADAPTER_CONFIG_REF));
  const runtimeContractText = await readTextIfFile(path.join(projectRoot, ".nimi", "methodology", "skill-runtime.yaml"));
  const installerText = await readTextIfFile(path.join(projectRoot, ".nimi", "config", "skill-installer.yaml"));
  const installerResultText = await readTextIfFile(path.join(projectRoot, ".nimi", "methodology", "skill-installer-result.yaml"));

  const contractRuntimeOwnerValues = [
    readYamlScalar(skillsConfigText, "runtime_owner"),
    readYamlScalar(manifestText, "runtime_owner"),
    readYamlScalar(handoffText, "runtime_owner"),
    readYamlScalar(runtimeContractText, "runtime_owner"),
    readYamlScalar(hostProfileText, "id"),
    readYamlScalar(installerText, "installer_owner"),
  ];
  const contractRuntimeOwnersAligned = contractRuntimeOwnerValues.every((value) => value === "external_ai_host");

  const delegatedModeAligned = [
    readYamlScalar(manifestText, "execution_mode"),
    readYamlScalar(hostProfileText, "execution_mode"),
    readYamlScalar(runtimeContractText, "runtime_mode"),
    readYamlScalar(installerText, "installer_mode"),
  ].every((value) => value === "delegated");

  const selfHostedAligned = [
    readYamlScalar(handoffText, "self_hosted_runtime"),
    readYamlScalar(hostProfileText, "self_hosted"),
    readYamlScalar(runtimeContractText, "self_hosted"),
    readYamlScalar(installerText, "self_hosted"),
  ].every((value) => value === "false");

  checks.push(
    buildCheck(
      "delegated_contract_posture",
      contractRuntimeOwnersAligned && delegatedModeAligned && selfHostedAligned,
      contractRuntimeOwnersAligned && delegatedModeAligned && selfHostedAligned
        ? "Delegated runtime ownership and non-self-hosted posture are consistent across contracts"
        : "Delegated runtime ownership, execution mode, or self-hosted posture drifted across contracts",
    ),
  );

  const referenceChecks = [
    readYamlScalar(manifestText, "runtime_contract_ref") === ".nimi/methodology/skill-runtime.yaml",
    readYamlScalar(manifestText, "host_profile_ref") === ".nimi/config/host-profile.yaml",
    readYamlScalar(manifestText, "installer_ref") === ".nimi/config/skill-installer.yaml",
    readYamlScalar(manifestText, "installer_result_contract_ref") === ".nimi/methodology/skill-installer-result.yaml",
    readYamlScalar(hostProfileText, "runtime_contract_ref") === ".nimi/methodology/skill-runtime.yaml",
    readYamlScalar(hostProfileText, "compatibility_contract_ref") === EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
    readYamlScalar(hostProfileText, "installer_ref") === ".nimi/config/skill-installer.yaml",
    readYamlScalar(hostProfileText, "installer_result_contract_ref") === ".nimi/methodology/skill-installer-result.yaml",
    readYamlScalar(hostAdapterText, "runtime_owner") === "external_ai_host",
    readYamlScalar(hostAdapterText, "host_profile_ref") === ".nimi/config/host-profile.yaml",
    readYamlScalar(hostAdapterText, "manifest_ref") === ".nimi/config/skill-manifest.yaml",
    readYamlScalar(hostAdapterText, "artifact_contract_ref") === EXTERNAL_EXECUTION_ARTIFACTS_CONFIG_REF,
    readYamlScalar(hostAdapterText, "handoff_ref") === ".nimi/methodology/skill-handoff.yaml",
    readYamlScalar(runtimeContractText, "manifest_ref") === ".nimi/config/skill-manifest.yaml",
    readYamlScalar(runtimeContractText, "host_profile_ref") === ".nimi/config/host-profile.yaml",
    readYamlScalar(runtimeContractText, "installer_ref") === ".nimi/config/skill-installer.yaml",
    readYamlScalar(runtimeContractText, "installer_result_contract_ref") === ".nimi/methodology/skill-installer-result.yaml",
    readYamlScalar(runtimeContractText, "handoff_ref") === ".nimi/methodology/skill-handoff.yaml",
    readYamlScalar(installerText, "manifest_ref") === ".nimi/config/skill-manifest.yaml",
    readYamlScalar(installerText, "runtime_contract_ref") === ".nimi/methodology/skill-runtime.yaml",
    readYamlScalar(installerText, "host_profile_ref") === ".nimi/config/host-profile.yaml",
    readYamlScalar(installerText, "result_contract_ref") === ".nimi/methodology/skill-installer-result.yaml",
    readYamlScalar(installerResultText, "installer_ref") === ".nimi/config/skill-installer.yaml",
    readYamlScalar(handoffText, "runtime_contract_ref") === ".nimi/methodology/skill-runtime.yaml",
    readYamlScalar(handoffText, "host_profile_ref") === ".nimi/config/host-profile.yaml",
    readYamlScalar(handoffText, "host_compatibility_contract_ref") === EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF,
    readYamlScalar(handoffText, "installer_ref") === ".nimi/config/skill-installer.yaml",
    readYamlScalar(handoffText, "installer_result_contract_ref") === ".nimi/methodology/skill-installer-result.yaml",
    readYamlScalar(handoffText, "exchange_projection_contract_ref") === ".nimi/methodology/skill-exchange-projection.yaml",
  ];
  checks.push(
    buildCheck(
      "contract_reference_alignment",
      referenceChecks.every(Boolean),
      referenceChecks.every(Boolean)
        ? "Manifest, runtime, installer, host-profile, host-adapter, and handoff references are aligned"
        : "Cross-contract reference drift detected between manifest/runtime/installer/host-profile/host-adapter/handoff truth",
    ),
  );

  const manifestSkills = parseSkillSection(manifestText, "skills");
  const expectedSkills = parseSkillSection(skillsConfigText, "expected_skill_surfaces");

  const reconstructionSkill = manifestSkills.find((skill) => skill.id === "spec_reconstruction") ?? null;
  const docAuditSkill = manifestSkills.find((skill) => skill.id === "doc_spec_audit") ?? null;
  const highRiskSkill = manifestSkills.find((skill) => skill.id === "high_risk_execution") ?? null;
  const resultContractAlignment = reconstructionSkill?.result_contract_ref === SPEC_RECONSTRUCTION_RESULT_CONTRACT_REF
    && docAuditSkill?.result_contract_ref === DOC_SPEC_AUDIT_RESULT_CONTRACT_REF
    && highRiskSkill?.result_contract_ref === HIGH_RISK_EXECUTION_RESULT_CONTRACT_REF;
  checks.push(
    buildCheck(
      "skill_result_contract_alignment",
      resultContractAlignment,
      resultContractAlignment
        ? "Skill manifest result contract refs align with the declared machine contracts"
        : "Skill manifest result contract refs drifted away from the declared machine contracts",
    ),
  );

  const hostRequiredContext = readYamlList(hostProfileText, "required_context");
  const handoffRequiredContext = readYamlList(handoffText, "required_context_order");
  const missingHandoffContextEntries = hostRequiredContext.filter((entry) => !handoffRequiredContext.includes(entry));
  const missingHandoffPaths = [];
  for (const relativePath of handoffRequiredContext) {
    const info = await pathExists(path.join(projectRoot, relativePath));
    if (!info) {
      missingHandoffPaths.push(relativePath);
    }
  }
  const handoffContextOk = missingHandoffContextEntries.length === 0 && missingHandoffPaths.length === 0;
  checks.push(
    buildCheck(
      "handoff_context_contract",
      handoffContextOk,
      handoffContextOk
        ? "Handoff context order contains the declared host context and all listed paths exist"
        : [
          missingHandoffContextEntries.length > 0
            ? `handoff context is missing host-required entries: ${missingHandoffContextEntries.join(", ")}`
            : null,
          missingHandoffPaths.length > 0
            ? `handoff context paths are missing on disk: ${missingHandoffPaths.join(", ")}`
            : null,
        ].filter(Boolean).join("; "),
    ),
  );

  const manifestSkillIds = manifestSkills.map((skill) => skill.id);
  const expectedSkillIds = expectedSkills.map((skill) => skill.id);
  const skillSurfaceAligned = arraysEqual(manifestSkillIds, expectedSkillIds);
  checks.push(
    buildCheck(
      "skill_surface_alignment",
      skillSurfaceAligned,
      skillSurfaceAligned
        ? "Manifest skills align with the expected skill surfaces declared in skills.yaml"
        : "Manifest skills and expected skill surfaces drifted out of alignment",
    ),
  );

  const specContract = await loadSpecReconstructionContract(projectRoot);
  const auditContract = await loadDocSpecAuditContract(projectRoot);
  const externalHostCompatibilityContract = await loadExternalHostCompatibilityContract(projectRoot);
  const highRiskExecutionContract = await loadHighRiskExecutionContract(projectRoot);
  const highRiskAdmissionContract = await loadHighRiskAdmissionContract(projectRoot);
  const externalExecutionArtifacts = await loadExternalExecutionArtifactsConfig(projectRoot);
  const highRiskSchemaContracts = await loadHighRiskSchemaContracts(projectRoot);
  checks.push(
    buildCheck(
      "spec_reconstruction_result_contract",
      specContract.ok,
      specContract.ok
        ? "spec-reconstruction result contract is present and structurally valid"
        : "spec-reconstruction result contract is missing or malformed",
    ),
  );
  checks.push(
    buildCheck(
      "doc_spec_audit_result_contract",
      auditContract.ok,
      auditContract.ok
        ? "doc-spec-audit result contract is present and structurally valid"
        : "doc-spec-audit result contract is missing or malformed",
    ),
  );
  checks.push(
    buildCheck(
      "external_host_compatibility_contract",
      externalHostCompatibilityContract.ok,
      externalHostCompatibilityContract.ok
        ? "Packaged external host compatibility contract is present and aligned"
        : `${EXTERNAL_HOST_COMPATIBILITY_CONTRACT_REF} is missing or malformed`,
    ),
  );
  checks.push(
    buildCheck(
      "high_risk_execution_result_contract",
      highRiskExecutionContract.ok,
      highRiskExecutionContract.ok
        ? "high-risk-execution result contract is present and structurally valid"
        : "high-risk-execution result contract is missing or malformed",
    ),
  );
  checks.push(
    buildCheck(
      "high_risk_admission_contract",
      highRiskAdmissionContract.ok,
      highRiskAdmissionContract.ok
        ? "Packaged high-risk admission schema contract is present and aligned"
        : `${HIGH_RISK_ADMISSION_CONTRACT_REF} is missing or malformed`,
    ),
  );
  checks.push(
    buildCheck(
      "external_execution_artifacts_contract",
      externalExecutionArtifacts.ok,
      externalExecutionArtifacts.ok
        ? "external execution artifact landing-path contract is present and structurally valid"
        : "external execution artifact landing-path contract is missing or malformed",
    ),
  );
  checks.push(
    buildCheck(
      "high_risk_schema_contracts",
      highRiskSchemaContracts.every((entry) => entry.ok),
      highRiskSchemaContracts.every((entry) => entry.ok)
        ? "High-risk execution schema seeds are present and structurally valid"
        : `High-risk execution schema seeds are missing or malformed: ${highRiskSchemaContracts.filter((entry) => !entry.ok).map((entry) => entry.path).join(", ")}`,
    ),
  );

  const targetTruthPresent = [];
  const targetTruthMissing = [];
  const targetTruthInvalid = [];
  for (const relativePath of TARGET_SPEC_FILES) {
    const info = await pathExists(path.join(projectRoot, relativePath));
    if (info && info.isFile()) {
      targetTruthPresent.push(relativePath);
      const text = await readTextIfFile(path.join(projectRoot, relativePath));
      const topLevelKeys = readTopLevelKeys(text);
      const requiredKeys = specContract.targetTruthFiles.find((entry) => entry.path === relativePath)?.required_top_level_keys
        ?? TARGET_SPEC_REQUIRED_KEYS[relativePath]
        ?? [];
      const missingKeys = requiredKeys.filter((key) => !topLevelKeys.includes(key));
      if (missingKeys.length > 0) {
        targetTruthInvalid.push({
          path: relativePath,
          missingKeys,
        });
      }
    } else {
      targetTruthMissing.push(relativePath);
    }
  }

  if (targetTruthPresent.length === 0) {
    checks.push({
      id: "target_truth_progress",
      ok: true,
      severity: "info",
      detail: "Reconstruction target files are still absent, which is expected during bootstrap-only mode",
    });
  } else if (targetTruthInvalid.length > 0) {
    checks.push(
      buildCheck(
        "target_truth_structure",
        false,
        `Reconstructed target truth is missing required top-level keys: ${targetTruthInvalid.map((entry) => `${entry.path} -> ${entry.missingKeys.join("/")}`).join(", ")}`,
      ),
    );

  } else if (targetTruthMissing.length === 0) {
    checks.push({
      id: "target_truth_progress",
      ok: true,
      severity: "ok",
      detail: "All target truth files are present and satisfy the declared top-level section contract",
    });
  } else {
    checks.push({
      id: "target_truth_progress",
      ok: true,
      severity: "warn",
      detail: `Target truth is partially reconstructed but structurally valid so far: present ${targetTruthPresent.length}/${TARGET_SPEC_FILES.length}`,
    });
  }

  let highRiskAdmissionsTruthValid = true;
  const admissionsTruthRef = ".nimi/spec/high-risk-admissions.yaml";
  if (targetTruthPresent.includes(admissionsTruthRef)) {
    const admissionsTruthText = await readTextIfFile(path.join(projectRoot, admissionsTruthRef));
    const admissionsTruthParsed = parseYamlText(admissionsTruthText);
    const admissionsTruthValidation = highRiskAdmissionContract.ok
      ? validateHighRiskAdmissionsSpec(admissionsTruthParsed, highRiskAdmissionContract)
      : {
        ok: false,
        reason: `${HIGH_RISK_ADMISSION_CONTRACT_REF} is missing or malformed`,
      };
    highRiskAdmissionsTruthValid = admissionsTruthValidation.ok;
    checks.push(
      buildCheck(
        "high_risk_admissions_truth",
        admissionsTruthValidation.ok,
        admissionsTruthValidation.ok
          ? "Canonical high-risk admissions truth satisfies the packaged admission schema contract"
          : `Canonical high-risk admissions truth drifted: ${admissionsTruthValidation.reason}`,
      ),
    );
  }

  const admittedAdapterIds = readYamlList(hostAdapterText, "admitted_adapter_ids");
  const selectedAdapterId = readYamlScalar(hostAdapterText, "selected_adapter_id");
  const adapterSelected = selectedAdapterId !== null && selectedAdapterId !== "none";
  const adapterSelectionValid = selectedAdapterId !== null
    && (!adapterSelected || admittedAdapterIds.includes(selectedAdapterId));
  checks.push(
    buildCheck(
      "host_adapter_contract",
      adapterSelectionValid,
      adapterSelectionValid
        ? adapterSelected
          ? `Host adapter ${selectedAdapterId} is selected and admitted`
          : "No host adapter selected; vendor-neutral delegated host posture remains active"
        : "host-adapter selected_adapter_id must be none or one of admitted_adapter_ids",
    ),
  );

  const adapterProfiles = await loadAdmittedAdapterProfiles(admittedAdapterIds);
  adapterProfiles.selected = selectAdapterProfile(adapterProfiles, selectedAdapterId);
  const adapterProfilesValid = adapterProfiles.invalid.length === 0;
  checks.push(
    buildCheck(
      "adapter_profile_overlays",
      adapterProfilesValid,
      adapterProfilesValid
        ? adapterProfiles.admitted.length === 0
          ? "No package-owned adapter profile overlays are currently admitted"
          : `Package-owned adapter profile overlays are present and valid: ${adapterProfiles.admitted.map((profile) => profile.id).join(", ")}`
        : `Package-owned adapter profile overlays are missing or malformed: ${adapterProfiles.invalid.map((profile) => `${profile.id} -> ${profile.reason}`).join(", ")}`,
    ),
  );

  const adapterBoundaryAligned = readYamlScalar(hostAdapterText, "semantic_review_owner") === "nimicoding_manager"
    && readYamlScalar(hostAdapterText, "handoff_mode") === "prompt_output_evidence_handoff"
    && readYamlScalar(hostAdapterText, "evidence_mode") === "candidate_only";
  checks.push(
    buildCheck(
      "host_adapter_boundary",
      adapterBoundaryAligned,
      adapterBoundaryAligned
        ? "Host adapter boundary keeps semantic review in nimicoding and limits handoff to prompt/output/evidence"
        : "host-adapter boundary drifted away from prompt/output/evidence-only handoff with nimicoding semantic review ownership",
    ),
  );

  const lifecycleAligned = (
    bootstrapStateContract.mode === "bootstrap_only"
    && targetTruthPresent.length < TARGET_SPEC_FILES.length
  ) || (
    bootstrapStateContract.mode === "reconstruction_seeded"
    && targetTruthMissing.length === 0
    && targetTruthInvalid.length === 0
  );
  checks.push(
    buildCheck(
      "bootstrap_lifecycle_alignment",
      lifecycleAligned,
      lifecycleAligned
        ? `bootstrap-state lifecycle ${bootstrapStateContract.mode ?? "unknown"} is aligned with current target truth`
        : bootstrapStateContract.mode === "bootstrap_only"
          ? "bootstrap-state still declares bootstrap_only even though all target truth files exist; transition to reconstruction_seeded"
          : "bootstrap-state declares reconstruction_seeded but target truth is missing or invalid",
    ),
  );

  const auditArtifact = await inspectLocalDocSpecAuditArtifact(projectRoot, auditContract);
  checks.push({
    id: "doc_spec_audit_artifact",
    ok: !auditArtifact.present || auditArtifact.ok,
    severity: !auditArtifact.present ? "info" : auditArtifact.ok ? "ok" : "warn",
    detail: auditArtifact.reason,
  });

  const auditArtifactConsistent = !auditArtifact.present
    || auditArtifact.outcome !== "completed"
    || (targetTruthMissing.length === 0 && targetTruthInvalid.length === 0);
  checks.push(
    buildCheck(
      "doc_spec_audit_state_alignment",
      auditArtifactConsistent,
      auditArtifactConsistent
        ? "Local doc_spec_audit artifact is consistent with the current reconstruction state"
        : "Completed local doc_spec_audit artifact requires fully reconstructed target truth",
    ),
  );

  const entrypointStatuses = [];
  for (const [relativePath, beginToken] of [
    ["AGENTS.md", AGENTS_BEGIN],
    ["CLAUDE.md", CLAUDE_BEGIN],
  ]) {
    const entryText = await readTextIfFile(path.join(projectRoot, relativePath));
    if (entryText && entryText.includes(beginToken)) {
      entrypointStatuses.push(relativePath);
    }
  }
  checks.push({
    id: "entrypoint_integration",
    ok: true,
    severity: "info",
    detail: entrypointStatuses.length === 0
      ? "No managed AI entrypoint blocks detected; this is optional"
      : `Managed AI entrypoint blocks detected in: ${entrypointStatuses.join(", ")}`,
  });

  let packageBoundaryTruthOk = true;
  let packageSelfAuditActive = false;
  try {
    packageSelfAuditActive = (await realpath(projectRoot)) === (await realpath(PACKAGE_REPO_ROOT));
  } catch {
    packageSelfAuditActive = false;
  }

  if (packageSelfAuditActive) {
    const boundariesText = await readTextIfFile(path.join(projectRoot, ".nimi", "spec", "boundaries.yaml"));
    const changePolicyText = await readTextIfFile(path.join(projectRoot, ".nimi", "spec", "change-policy.yaml"));
    const packageBoundaryTruth = inspectPackageBoundaryTruth(boundariesText, changePolicyText);
    packageBoundaryTruthOk = packageBoundaryTruth.ok;
    checks.push(
      buildCheck(
        "package_boundary_truth",
        packageBoundaryTruth.ok,
        packageBoundaryTruth.ok
          ? "Repo-local boundaries and change-policy keep runtime surfaces explicitly deferred under the boundary-complete standalone posture"
          : "Repo-local boundaries or change-policy drifted away from the declared boundary-complete standalone posture",
      ),
    );
  }

  const hasErrors = checks.some((check) => check.severity === "error");
  const reconstructionRequired = bootstrapStateContract.reconstructionRequired === true;
  const runtimeInstalled = Boolean(skillsConfigText)
    && skillsConfigText.includes("runtime_installed: true");

  const delegatedContracts = {
    runtimeOwner: readYamlScalar(handoffText, "runtime_owner"),
    executionMode: readYamlScalar(runtimeContractText, "runtime_mode"),
    installerMode: readYamlScalar(installerText, "installer_mode"),
    selfHostedRuntime: readYamlScalar(handoffText, "self_hosted_runtime") === "true",
    triggerMode: readYamlScalar(handoffText, "trigger_mode"),
    expectedSkillIds: manifestSkillIds,
    selectedAdapterId,
    admittedAdapterIds,
    adapterHandoffMode: readYamlScalar(hostAdapterText, "handoff_mode"),
    semanticReviewOwner: readYamlScalar(hostAdapterText, "semantic_review_owner"),
  };

  const handoffReadiness = {
    ok: handoffContextOk
      && referenceChecks.every(Boolean)
      && contractRuntimeOwnersAligned
      && delegatedModeAligned
      && selfHostedAligned
      && completionTruth.ok
      && resultContractAlignment
      && adapterSelectionValid
      && adapterProfilesValid
      && adapterBoundaryAligned
      && specContract.ok
      && auditContract.ok
      && externalHostCompatibilityContract.ok
      && highRiskExecutionContract.ok
      && highRiskAdmissionContract.ok
      && highRiskAdmissionsTruthValid
      && externalExecutionArtifacts.ok
      && packageBoundaryTruthOk
      && lifecycleAligned,
    requiredContextOrder: handoffRequiredContext,
    missingContextEntries: missingHandoffContextEntries,
    missingPaths: missingHandoffPaths,
  };

  const nextSteps = [];
  if (hasErrors) {
    nextSteps.push("Repair the failing bootstrap checks, then rerun `nimicoding doctor`.");
  } else if (targetTruthMissing.length > 0) {
    nextSteps.push("Use an external AI host to reconstruct the declared `.nimi/spec/*.yaml` target truth.");
  }
  if (!auditArtifact.present && targetTruthMissing.length === 0 && targetTruthInvalid.length === 0) {
    nextSteps.push("Run `nimicoding handoff --skill doc_spec_audit` and close out the result locally when the audit is complete.");
  }
  if (!runtimeInstalled) {
    nextSteps.push("Keep runtime ownership delegated; do not assume local skill installation or self-hosting.");
  }
  if (!adapterSelected && !hasErrors) {
    nextSteps.push("If you want a constrained external execution host, select one in `.nimi/config/host-adapter.yaml`.");
  }

  const executionContracts = {
    total: highRiskSchemaContracts.length,
    valid: highRiskSchemaContracts.filter((entry) => entry.ok).length,
    invalid: highRiskSchemaContracts
      .filter((entry) => !entry.ok)
      .map((entry) => entry.path),
    contracts: highRiskSchemaContracts.map((entry) => ({
      path: entry.path,
      ok: entry.ok,
    })),
  };

  const completionStatus = !completionTruth.ok || !packageBoundaryTruthOk
    ? STANDALONE_COMPLETION_STATUS.DRIFTED
    : !hasErrors
      ? STANDALONE_COMPLETION_STATUS.COMPLETE
      : STANDALONE_COMPLETION_STATUS.INCOMPLETE;

  const hostCompatibility = buildHostCompatibilityReport(
    externalHostCompatibilityContract,
    adapterProfiles,
    selectedAdapterId,
  );

  return {
    projectRoot,
    ok: !hasErrors,
    bootstrapPresent: true,
    reconstructionRequired,
    runtimeInstalled,
    bootstrapContract: {
      status: bootstrapCompatibility.status,
      id: bootstrapCompatibility.contractId,
      version: bootstrapCompatibility.contractVersion,
    },
    completionProfile: completionTruth.completionProfile,
    completionStatus,
    completedSurfaces: completionTruth.completedSurfaces,
    deferredExecutionSurfaces: completionTruth.deferredExecutionSurfaces,
    promotedParityGapSummary: completionTruth.promotedParityGapSummary,
    hostCompatibility,
    delegatedContracts,
    adapterProfiles,
    handoffReadiness,
    checks,
    targetTruth: {
      present: targetTruthPresent,
      missing: targetTruthMissing,
      invalid: targetTruthInvalid,
    },
    auditArtifact,
    executionContracts,
    nextSteps,
  };
}

export function formatDoctorResult(result) {
  const hostCompatibility = result.hostCompatibility ?? {
    contractRef: "unknown",
    supportedHostPosture: [],
    supportedHostExamples: [],
    requiredBehavior: [],
    forbiddenBehavior: [],
    genericExternalHostCompatible: false,
    namedOverlaySupport: {
      mode: "generic_only",
      admittedOverlayIds: [],
      selectedOverlayId: null,
      selectedOverlayProfileRef: null,
      selectedOverlayHostClass: null,
    },
    futureOnlyHostSurfaces: [],
  };
  const lines = [
    `nimicoding doctor: ${result.projectRoot}`,
    "",
    "Overall:",
    `  - status: ${result.ok ? "ok" : "needs_attention"}`,
    `  - bootstrap_present: ${result.bootstrapPresent ? "true" : "false"}`,
    `  - reconstruction_required: ${result.reconstructionRequired ? "true" : "false"}`,
    `  - runtime_installed: ${result.runtimeInstalled ? "true" : "false"}`,
    `  - handoff_ready: ${result.handoffReadiness.ok ? "true" : "false"}`,
    "",
    "Bootstrap:",
    `  - contract_status: ${result.bootstrapContract.status}`,
    `  - contract_id: ${result.bootstrapContract.id ?? "unknown"}`,
    `  - contract_version: ${result.bootstrapContract.version ?? "unknown"}`,
    "",
    "Completion Posture:",
    `  - profile: ${result.completionProfile ?? "unknown"}`,
    `  - status: ${result.completionStatus ?? "unknown"}`,
    `  - completed_surfaces: ${result.completedSurfaces.length}`,
    `  - deferred_execution_surfaces: ${result.deferredExecutionSurfaces.length}`,
    `  - promoted_parity_gaps: ${result.promotedParityGapSummary.length}`,
    "",
    "Supported Host Posture:",
    `  - contract_ref: ${hostCompatibility.contractRef ?? "unknown"}`,
    `  - supported_host_posture: ${hostCompatibility.supportedHostPosture.join(", ") || "none"}`,
    `  - supported_host_examples: ${hostCompatibility.supportedHostExamples.join(", ") || "none"}`,
    `  - required_behavior: ${hostCompatibility.requiredBehavior.length}`,
    `  - forbidden_behavior: ${hostCompatibility.forbiddenBehavior.length}`,
    `  - generic_external_host_compatible: ${hostCompatibility.genericExternalHostCompatible ? "true" : "false"}`,
    `  - named_overlay_mode: ${hostCompatibility.namedOverlaySupport.mode}`,
    `  - admitted_named_overlays: ${hostCompatibility.namedOverlaySupport.admittedOverlayIds.join(", ") || "none"}`,
    `  - selected_named_overlay: ${hostCompatibility.namedOverlaySupport.selectedOverlayId ?? "none"}`,
    "",
    "Delegated Contracts:",
    `  - runtime_owner: ${result.delegatedContracts.runtimeOwner ?? "unknown"}`,
    `  - runtime_mode: ${result.delegatedContracts.executionMode ?? "unknown"}`,
    `  - installer_mode: ${result.delegatedContracts.installerMode ?? "unknown"}`,
    `  - self_hosted_runtime: ${result.delegatedContracts.selfHostedRuntime ? "true" : "false"}`,
    `  - trigger_mode: ${result.delegatedContracts.triggerMode ?? "unknown"}`,
    `  - selected_adapter_id: ${result.delegatedContracts.selectedAdapterId ?? "unknown"}`,
    `  - admitted_adapter_ids: ${result.delegatedContracts.admittedAdapterIds.length}`,
    `  - adapter_handoff_mode: ${result.delegatedContracts.adapterHandoffMode ?? "unknown"}`,
    `  - semantic_review_owner: ${result.delegatedContracts.semanticReviewOwner ?? "unknown"}`,
    "",
    "Adapter Profiles:",
    `  - admitted: ${result.adapterProfiles.admitted.length}`,
    `  - invalid: ${result.adapterProfiles.invalid.length}`,
    `  - selected_profile_ref: ${result.adapterProfiles.selected?.profileRef ?? "none"}`,
    `  - selected_host_class: ${result.adapterProfiles.selected?.hostClass ?? "none"}`,
    "",
    "Checks:",
  ];

  for (const check of result.checks) {
    const marker = check.severity === "error"
      ? "fail"
      : check.severity === "warn"
        ? "warn"
        : check.severity === "info"
          ? "info"
          : "ok";
    lines.push(`  - [${marker}] ${check.detail}`);
  }

  lines.push("", "Target Truth:");
  lines.push(`  - present: ${result.targetTruth.present.length}`);
  lines.push(`  - missing: ${result.targetTruth.missing.length}`);
  lines.push(`  - invalid: ${result.targetTruth.invalid.length}`);

  lines.push("", "Audit:");
  lines.push(`  - artifact_present: ${result.auditArtifact.present ? "true" : "false"}`);
  lines.push(`  - artifact_ok: ${result.auditArtifact.ok ? "true" : "false"}`);
  lines.push(`  - latest_outcome: ${result.auditArtifact.outcome ?? "none"}`);
  lines.push(`  - latest_status: ${result.auditArtifact.summaryStatus ?? "none"}`);

  lines.push("", "Execution Contracts:");
  lines.push(`  - total: ${result.executionContracts.total}`);
  lines.push(`  - valid: ${result.executionContracts.valid}`);
  lines.push(`  - invalid: ${result.executionContracts.invalid.length}`);

  lines.push("", "Handoff:");
  lines.push(`  - required_context_order: ${result.handoffReadiness.requiredContextOrder.length}`);
  lines.push(`  - missing_context_entries: ${result.handoffReadiness.missingContextEntries.length}`);
  lines.push(`  - missing_paths: ${result.handoffReadiness.missingPaths.length}`);

  if (result.deferredExecutionSurfaces.length > 0) {
    lines.push("", "Deferred Runtime Surfaces:");
    for (const surface of result.deferredExecutionSurfaces) {
      lines.push(`  - ${surface}`);
    }
  }

  if (result.promotedParityGapSummary.length > 0) {
    lines.push("", "Promoted Parity Gaps:");
    for (const gap of result.promotedParityGapSummary) {
      lines.push(`  - ${gap}`);
    }
  }

  if (hostCompatibility.futureOnlyHostSurfaces.length > 0) {
    lines.push("", "Future-Only Host Surfaces:");
    for (const surface of hostCompatibility.futureOnlyHostSurfaces) {
      lines.push(`  - ${surface.adapterId}: ${surface.command} (${surface.status ?? "unknown"})`);
    }
  }

  if (result.nextSteps.length > 0) {
    lines.push("", "Next:");
    for (const step of result.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
