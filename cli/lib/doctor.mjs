import { readdir } from "node:fs/promises";
import path from "node:path";

import { SPEC_GENERATION_AUDIT_REF } from "../constants.mjs";
import { getBootstrapSeedEntries } from "../seeds/bootstrap.mjs";
import { loadSpecGenerationInputsConfig } from "./contracts.mjs";
import { pathExists, readTextIfFile } from "./fs-helpers.mjs";
import { runSeedSync, SYNC_MODE } from "./sync.mjs";
import { localize, styleHeading, styleLabel, styleStatus } from "./ui.mjs";

function check(id, ok, severity, detail) {
  return { id, ok, severity: ok ? "ok" : severity, detail };
}

async function directoryHasFiles(root) {
  const info = await pathExists(root);
  if (!info || !info.isDirectory()) return false;
  const entries = await readdir(root, { withFileTypes: true });
  return entries.length > 0;
}

async function managedEntrypoints(projectRoot) {
  const refs = [];
  for (const ref of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readTextIfFile(path.join(projectRoot, ref));
    if (text?.includes("nimicoding:managed:")) refs.push(ref);
  }
  return refs;
}

export async function inspectDoctorState(projectRoot) {
  const checks = [];
  const bootstrap = { status: "exact_allowlist" };
  const seedSync = await runSeedSync(projectRoot, SYNC_MODE.CHECK);
  checks.push(check(
    "managed_projection",
    seedSync.ok,
    "error",
    seedSync.ok
      ? `all ${seedSync.summary.total} explicitly managed files are aligned`
      : `${seedSync.checkFailures.length} explicitly managed files are missing or drifted`,
  ));

  const generationInputs = await loadSpecGenerationInputsConfig(projectRoot);
  checks.push(check(
    "spec_generation_inputs",
    generationInputs.ok && generationInputs.mode === "class_filtered",
    "error",
    generationInputs.ok && generationInputs.mode === "class_filtered"
      ? "spec generation inputs use class-filtered authority"
      : "spec generation inputs are missing or invalid",
  ));

  const specRoot = path.join(projectRoot, ".nimi", "spec");
  const specPresent = await directoryHasFiles(specRoot);
  checks.push(check(
    "spec_tree",
    true,
    "info",
    specPresent
      ? "canonical spec tree is present; conformance is checked by validate-spec-tree or project-specific validators"
      : "canonical spec tree has not been constructed yet",
  ));

  const auditPath = path.join(projectRoot, SPEC_GENERATION_AUDIT_REF);
  const auditPresent = Boolean(await pathExists(auditPath));
  checks.push(check(
    "spec_generation_audit",
    true,
    "info",
    auditPresent
      ? "spec generation audit is present; conformance is checked by validate-spec-audit"
      : "spec generation audit is not present",
  ));

  const entrypoints = await managedEntrypoints(projectRoot);
  checks.push(check(
    "entrypoint_integration",
    true,
    "info",
    entrypoints.length > 0
      ? `managed methodology guidance is present in ${entrypoints.join(", ")}`
      : "managed methodology guidance is not installed",
  ));

  const seedEntries = await getBootstrapSeedEntries();
  const ok = checks.every((entry) => entry.severity !== "error");

  return {
    ok,
    projectRoot,
    bootstrap,
    managedProjection: seedSync,
    generationInputs: {
      ok: generationInputs.ok,
      mode: generationInputs.mode ?? null,
      canonicalTargetRoot: generationInputs.canonicalTargetRoot ?? null,
    },
    spec: {
      present: specPresent,
      ok: null,
      summary: null,
    },
    generationAudit: {
      present: auditPresent,
      ok: null,
      summary: null,
    },
    entrypoints,
    managedFileCount: seedEntries.length,
    checks,
  };
}

export function formatDoctorResult(result, options = {}) {
  const lines = [
    styleHeading(`nimicoding doctor: ${result.projectRoot}`),
    "",
    styleLabel(localize("Summary:", "摘要：")),
    `  - ${localize("status", "状态")}: ${styleStatus(result.ok ? "ok" : "needs_attention")}`,
    `  - projection_policy: ${result.bootstrap.status}`,
    `  - managed_projection: ${result.managedProjection?.ok === true ? "aligned" : "invalid"}`,
    `  - spec: ${!result.spec.present ? "not_constructed" : "present_not_validated"}`,
    `  - generation_audit: ${!result.generationAudit.present ? "not_present" : "present_not_validated"}`,
    "",
    styleLabel(localize("Checks:", "检查项：")),
  ];

  const visibleChecks = options.verbose
    ? result.checks
    : result.checks.filter((entry) => entry.severity !== "ok" || !entry.ok);
  if (visibleChecks.length === 0) {
    lines.push(`  - ${localize("No blocking issues found.", "没有发现阻塞问题。")}`);
  } else {
    for (const entry of visibleChecks) {
      const marker = entry.ok ? "info" : entry.severity;
      lines.push(`  - [${marker}] ${entry.detail}`);
    }
  }

  if (!result.spec.present) {
    lines.push(
      "",
      styleLabel(localize("Next:", "下一步：")),
      "  - Build canonical product authority under .nimi/spec, then run nimicoding validate-spec-tree.",
    );
  }

  return `${lines.join("\n")}\n`;
}
