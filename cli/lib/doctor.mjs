import { readdir } from "node:fs/promises";
import path from "node:path";

import { getBootstrapSeedEntries } from "../seeds/bootstrap.mjs";
import { pathExists, preflightManagedProjectPaths } from "./fs-helpers.mjs";
import { runSeedSync, SYNC_MODE } from "./sync.mjs";
import { localize, styleHeading, styleLabel, styleStatus } from "./ui.mjs";

function check(id, ok, severity, detail) {
  return { id, ok, severity: ok ? "ok" : severity, detail };
}

async function directoryHasFiles(root) {
  const info = await pathExists(root);
  if (!info?.isDirectory()) return false;
  return (await readdir(root)).length > 0;
}

export async function inspectDoctorState(projectRoot) {
  await preflightManagedProjectPaths(projectRoot, { includeSpec: true });
  const managedProjection = await runSeedSync(projectRoot, SYNC_MODE.CHECK);
  const specPresent = await directoryHasFiles(path.join(projectRoot, ".nimi/spec"));
  const checks = [
    check(
      "managed_surfaces",
      managedProjection.ok,
      "error",
      managedProjection.ok
        ? "exact package projection and managed instruction blocks are aligned"
        : `${managedProjection.checkFailures.length} exact managed or deprecated surface issue(s) require attention`,
    ),
    check(
      "canonical_authority",
      true,
      "info",
      specPresent
        ? "canonical authority is present; run nimicoding authority check .nimi/spec for admission"
        : "canonical authority has not been authored; the project owns all product semantics under .nimi/spec",
    ),
  ];
  const seedEntries = await getBootstrapSeedEntries();
  return {
    ok: checks.every((entry) => entry.severity !== "error"),
    projectRoot,
    bootstrap: { status: "exact_projection_registry" },
    managedProjection,
    spec: { present: specPresent, ok: null, summary: null },
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
    `  - managed_surfaces: ${result.managedProjection.ok ? "aligned" : "invalid"}`,
    `  - canonical_authority: ${result.spec.present ? "present_not_validated" : "not_authored"}`,
    "",
    styleLabel(localize("Checks:", "检查项：")),
  ];
  const visible = options.verbose ? result.checks : result.checks.filter((entry) => entry.severity !== "ok" || !entry.ok);
  if (visible.length === 0) lines.push(`  - ${localize("No blocking integration issues found.", "没有发现阻塞性的集成问题。")}`);
  else for (const entry of visible) lines.push(`  - [${entry.ok ? "info" : entry.severity}] ${entry.detail}`);
  if (!result.spec.present) {
    lines.push("", styleLabel(localize("Next:", "下一步：")), "  - Author canonical authority under .nimi/spec, format changed files, then run nimicoding authority check .nimi/spec.");
  }
  return `${lines.join("\n")}\n`;
}
