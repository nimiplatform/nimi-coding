import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBootstrapSeedEntries, loadSeedPolicy } from "../seeds/bootstrap.mjs";
import { inspectEntrypointIntegration, integrateEntrypoints } from "./entrypoints.mjs";
import { normalizeTextToLf, pathExists, preflightManagedProjectPaths } from "./fs-helpers.mjs";

export const SYNC_MODE = {
  DRY_RUN: "dry_run",
  APPLY: "apply",
  CHECK: "check",
};

const STATUS = {
  IN_SYNC: "in_sync",
  CREATED: "created",
  UPDATED: "updated",
  WOULD_CREATE: "would_create",
  WOULD_UPDATE: "would_update",
  MISSING_PACKAGE_CANONICAL: "missing_package_canonical",
  DRIFTED_PACKAGE_CANONICAL: "drifted_package_canonical",
  MANAGED_BLOCK_DRIFT: "managed_block_drift",
  DEPRECATED_PROJECTION_PATH: "deprecated_projection_path",
};

async function inspectProjection(projectRoot, entry) {
  const absolutePath = path.join(projectRoot, entry.outputRelativePath);
  const projectionContent = normalizeTextToLf(entry.content);
  const info = await pathExists(absolutePath);
  if (!info) return { ...entry, absolutePath, projectionContent, state: "missing" };
  const actual = await readFile(absolutePath);
  return { ...entry, absolutePath, projectionContent, state: actual.equals(Buffer.from(projectionContent, "utf8")) ? "in_sync" : "drifted" };
}

function projectionResult(entry, mode, applied = false) {
  if (entry.state === "in_sync") {
    return { outputRelativePath: entry.outputRelativePath, ownership: entry.ownership, status: STATUS.IN_SYNC, detail: "projection matches LF-normalized package canonical text" };
  }
  if (applied) {
    return {
      outputRelativePath: entry.outputRelativePath,
      ownership: entry.ownership,
      status: entry.state === "missing" ? STATUS.CREATED : STATUS.UPDATED,
      detail: entry.state === "missing" ? "created LF-normalized package-owned projection" : "restored LF-normalized package-owned projection",
    };
  }
  const status = entry.state === "missing"
    ? mode === SYNC_MODE.CHECK ? STATUS.MISSING_PACKAGE_CANONICAL : STATUS.WOULD_CREATE
    : mode === SYNC_MODE.CHECK ? STATUS.DRIFTED_PACKAGE_CANONICAL : STATUS.WOULD_UPDATE;
  return { outputRelativePath: entry.outputRelativePath, ownership: entry.ownership, status, detail: entry.state === "missing" ? "LF-normalized package-owned projection is missing" : "projection diverges from LF-normalized package canonical text" };
}

async function applyProjection(entry) {
  await mkdir(path.dirname(entry.absolutePath), { recursive: true });
  await writeFile(entry.absolutePath, normalizeTextToLf(entry.projectionContent ?? entry.content), "utf8");
}

function managedBlockResult(state, mode, applied = false) {
  if (!state.changed) {
    return { outputRelativePath: `${state.relativePath}#nimicoding-managed-block`, ownership: "package_managed_block", status: STATUS.IN_SYNC, detail: "managed block matches package instructions" };
  }
  return {
    outputRelativePath: `${state.relativePath}#nimicoding-managed-block`,
    ownership: "package_managed_block",
    status: applied ? STATUS.UPDATED : mode === SYNC_MODE.CHECK ? STATUS.MANAGED_BLOCK_DRIFT : STATUS.WOULD_UPDATE,
    detail: "managed block is missing or drifted; host-owned text outside the block is not inspected",
  };
}

async function inspectDeprecatedPaths(projectRoot) {
  const policy = await loadSeedPolicy();
  const results = [];
  for (const ref of policy.deprecatedProjections) {
    if (await pathExists(path.join(projectRoot, ref))) {
      results.push({
        outputRelativePath: ref,
        ownership: "deprecated_package_projection",
        status: STATUS.DEPRECATED_PROJECTION_PATH,
        detail: "deprecated package projection must be removed by the host; sync does not delete host files",
      });
    }
  }
  return results;
}

export async function runSeedSync(projectRoot, mode = SYNC_MODE.DRY_RUN) {
  await preflightManagedProjectPaths(projectRoot);
  const seedEntries = await getBootstrapSeedEntries();
  const projectionStates = [];
  for (const entry of seedEntries) projectionStates.push(await inspectProjection(projectRoot, entry));
  const blockStates = await inspectEntrypointIntegration(projectRoot);
  const deprecatedResults = await inspectDeprecatedPaths(projectRoot);

  const mayApply = mode === SYNC_MODE.APPLY && deprecatedResults.length === 0;
  if (mayApply) {
    for (const state of projectionStates) if (state.state !== "in_sync") await applyProjection(state);
    if (blockStates.some((state) => state.changed)) await integrateEntrypoints(projectRoot);
  }

  const results = [
    ...projectionStates.map((state) => projectionResult(state, mode, mayApply && state.state !== "in_sync")),
    ...blockStates.map((state) => managedBlockResult(state, mode, mayApply && state.changed)),
    ...deprecatedResults,
  ];
  const summary = {
    total: results.length,
    in_sync: 0,
    created: 0,
    updated: 0,
    would_create: 0,
    would_update: 0,
    missing_package_canonical: 0,
    drifted_package_canonical: 0,
    managed_block_drift: 0,
    deprecated_projection_path: 0,
  };
  for (const result of results) summary[result.status] = (summary[result.status] ?? 0) + 1;

  const checkFailureStatuses = new Set([
    STATUS.MISSING_PACKAGE_CANONICAL,
    STATUS.DRIFTED_PACKAGE_CANONICAL,
    STATUS.MANAGED_BLOCK_DRIFT,
    STATUS.DEPRECATED_PROJECTION_PATH,
  ]);
  const checkFailures = results.filter((result) =>
    result.status === STATUS.DEPRECATED_PROJECTION_PATH
    || (mode === SYNC_MODE.CHECK && checkFailureStatuses.has(result.status)),
  );
  return { mode, summary, results, ok: checkFailures.length === 0, checkFailures };
}

export const SYNC_RESULT_STATUS = STATUS;
