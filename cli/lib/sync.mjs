import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBootstrapSeedEntries } from "../seeds/bootstrap.mjs";
import { pathExists, readTextIfFile } from "./fs-helpers.mjs";

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
  DRIFTED_PRESERVED: "drifted_preserved",
  MISSING_PACKAGE_CANONICAL: "missing_package_canonical",
  MISSING_HOST_STATE_SEED: "missing_host_state_seed",
  DRIFTED_PACKAGE_CANONICAL: "drifted_package_canonical",
  UNEXPECTED_UNADMITTED_PATH: "unexpected_unadmitted_path",
};

const EXACT_HOST_CONFIG_PATHS = new Set([
  ".nimi/config/host-overlay.yaml",
  ".nimi/config/spec-layout.yaml",
  ".nimi/config/governance.yaml",
]);
const MANAGED_SURFACE_ROOTS = [".nimi/config", ".nimi/contracts", ".nimi/methodology"];

const HOST_OWNED_SEED_OWNERSHIPS = new Set(["host_state_seed", "host_profile_override"]);

async function collectSurfaceFiles(projectRoot, relativeRoot) {
  const root = path.join(projectRoot, relativeRoot);
  const info = await pathExists(root);
  if (!info?.isDirectory()) return [];
  async function walk(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const ref = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) files.push(...await walk(absolute, ref));
      else files.push(ref);
    }
    return files;
  }
  return walk(root, relativeRoot);
}

async function unexpectedSurfaceResults(projectRoot, seedEntries) {
  const admitted = new Set([...seedEntries.map((entry) => entry.outputRelativePath), ...EXACT_HOST_CONFIG_PATHS]);
  const files = (await Promise.all(MANAGED_SURFACE_ROOTS.map((root) => collectSurfaceFiles(projectRoot, root)))).flat().sort();
  return files.filter((ref) => !admitted.has(ref)).map((ref) => ({
    outputRelativePath: ref,
    ownership: "unadmitted",
    status: STATUS.UNEXPECTED_UNADMITTED_PATH,
    detail: ref === ".nimi/config/bootstrap.yaml"
      ? "rejected legacy bootstrap path is outside the exact projection registry"
      : "unexpected/unadmitted path is outside the exact projection registry and host config allowlist",
  }));
}

async function evaluateSeedEntry(projectRoot, entry, mode) {
  const absolutePath = path.join(projectRoot, entry.outputRelativePath);
  const info = await pathExists(absolutePath);
  const fileExists = Boolean(info && info.isFile());

  if (!fileExists) {
    if (mode === SYNC_MODE.APPLY) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, entry.content, "utf8");
      return {
        outputRelativePath: entry.outputRelativePath,
        ownership: entry.ownership,
        status: STATUS.CREATED,
        detail: "missing host file was seeded from package source",
      };
    }
    return {
      outputRelativePath: entry.outputRelativePath,
      ownership: entry.ownership,
      status: HOST_OWNED_SEED_OWNERSHIPS.has(entry.ownership)
        ? STATUS.MISSING_HOST_STATE_SEED
        : STATUS.MISSING_PACKAGE_CANONICAL,
      detail: mode === SYNC_MODE.CHECK
        ? "host file is missing"
        : "host file is missing and would be seeded on --apply",
    };
  }

  const actual = await readTextIfFile(absolutePath);
  if (actual === entry.content) {
    return {
      outputRelativePath: entry.outputRelativePath,
      ownership: entry.ownership,
      status: STATUS.IN_SYNC,
      detail: "host file matches package source byte-for-byte",
    };
  }

  if (HOST_OWNED_SEED_OWNERSHIPS.has(entry.ownership)) {
    return {
      outputRelativePath: entry.outputRelativePath,
      ownership: entry.ownership,
      status: STATUS.DRIFTED_PRESERVED,
      detail: `${entry.ownership}: host owns canonical content; sync preserves host copy`,
    };
  }

  if (mode === SYNC_MODE.APPLY) {
    await writeFile(absolutePath, entry.content, "utf8");
    return {
      outputRelativePath: entry.outputRelativePath,
      ownership: entry.ownership,
      status: STATUS.UPDATED,
      detail: "drifted package_canonical file rewritten to package source",
    };
  }

  return {
    outputRelativePath: entry.outputRelativePath,
    ownership: entry.ownership,
    status: mode === SYNC_MODE.CHECK
      ? STATUS.DRIFTED_PACKAGE_CANONICAL
      : STATUS.WOULD_UPDATE,
    detail: "host file diverges from package_canonical source",
  };
}

export async function runSeedSync(projectRoot, mode = SYNC_MODE.DRY_RUN) {
  const entries = await getBootstrapSeedEntries();
  const results = [];
  for (const entry of entries) {
    results.push(await evaluateSeedEntry(projectRoot, entry, mode));
  }
  results.push(...await unexpectedSurfaceResults(projectRoot, entries));

  const summary = {
    total: results.length,
    in_sync: 0,
    created: 0,
    updated: 0,
    would_create: 0,
    would_update: 0,
    drifted_preserved: 0,
    missing_host_state_seed: 0,
    missing_package_canonical: 0,
    drifted_package_canonical: 0,
    unexpected_unadmitted_path: 0,
  };

  for (const result of results) {
    summary[result.status] = (summary[result.status] ?? 0) + 1;
  }

  // Re-derive dry-run status counters when no apply happened.
  if (mode === SYNC_MODE.DRY_RUN) {
    summary.would_create = results.filter((r) =>
      r.status === STATUS.MISSING_HOST_STATE_SEED || r.status === STATUS.MISSING_PACKAGE_CANONICAL,
    ).length;
    summary.would_update = results.filter((r) => r.status === STATUS.WOULD_UPDATE).length;
  }

  const checkFailures = mode === SYNC_MODE.CHECK
    ? results.filter((r) =>
      r.status === STATUS.MISSING_PACKAGE_CANONICAL
      || r.status === STATUS.MISSING_HOST_STATE_SEED
      || r.status === STATUS.DRIFTED_PACKAGE_CANONICAL
      || r.status === STATUS.UNEXPECTED_UNADMITTED_PATH,
    )
    : [];

  return {
    mode,
    summary,
    results,
    ok: mode === SYNC_MODE.CHECK ? checkFailures.length === 0 : true,
    checkFailures,
  };
}

export const SYNC_RESULT_STATUS = STATUS;
