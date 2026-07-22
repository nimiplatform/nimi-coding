import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_GITIGNORE_ENTRIES,
  REQUIRED_LOCAL_DIRS,
} from "../constants.mjs";
import { createBootstrapSeedFileMap } from "../seeds/bootstrap.mjs";
import { appendGitignoreEntries, pathExists, readTextIfFile } from "./fs-helpers.mjs";

export async function previewBootstrapWrites(projectRoot) {
  const missingFiles = [];
  const missingDirs = [];
  const seedMap = await createBootstrapSeedFileMap();

  for (const relativeDir of REQUIRED_LOCAL_DIRS) {
    const dirPath = path.join(projectRoot, relativeDir);
    const info = await pathExists(dirPath);
    if (!info || !info.isDirectory()) {
      missingDirs.push(relativeDir);
    }
  }

  for (const relativePath of seedMap.keys()) {
    const absolutePath = path.join(projectRoot, relativePath);
    const info = await pathExists(absolutePath);
    if (!info) {
      missingFiles.push(relativePath);
    }
  }

  const gitignoreText = await readTextIfFile(path.join(projectRoot, ".gitignore"));
  const missingGitignoreEntries = gitignoreText === null
    ? LOCAL_GITIGNORE_ENTRIES.slice()
    : LOCAL_GITIGNORE_ENTRIES.filter((entry) => !gitignoreText.includes(entry));

  return {
    missingFiles,
    missingDirs,
    missingGitignoreEntries,
    hasWork: missingFiles.length > 0 || missingDirs.length > 0 || missingGitignoreEntries.length > 0,
  };
}

export async function writeMissingBootstrapFiles(projectRoot) {
  const createdFiles = [];
  const createdDirs = [];
  const seedMap = await createBootstrapSeedFileMap();

  for (const relativeDir of REQUIRED_LOCAL_DIRS) {
    const dirPath = path.join(projectRoot, relativeDir);
    const info = await pathExists(dirPath);
    if (!info) {
      await mkdir(dirPath, { recursive: true });
      createdDirs.push(relativeDir);
    }
  }

  for (const [relativePath, content] of seedMap.entries()) {
    const absolutePath = path.join(projectRoot, relativePath);
    const info = await pathExists(absolutePath);
    if (info) {
      continue;
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    createdFiles.push(relativePath);
  }

  const gitignoreUpdated = await appendGitignoreEntries(
    path.join(projectRoot, ".gitignore"),
    LOCAL_GITIGNORE_ENTRIES,
  );

  return {
    createdFiles,
    createdDirs,
    gitignoreUpdated,
  };
}

const UNINSTALLABLE_BOOTSTRAP_PREFIXES = [
  ".nimi/config/",
  ".nimi/contracts/",
  ".nimi/methodology/",
];

function isUninstallableBootstrapPath(relativePath) {
  return UNINSTALLABLE_BOOTSTRAP_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function collectBootstrapRemovalState(projectRoot) {
  const removableFiles = [];
  const preservedModifiedFiles = [];
  const seedMap = await createBootstrapSeedFileMap();

  for (const [relativePath, content] of seedMap.entries()) {
    if (!isUninstallableBootstrapPath(relativePath)) {
      continue;
    }

    const absolutePath = path.join(projectRoot, relativePath);
    const info = await pathExists(absolutePath);
    if (!info || !info.isFile()) {
      continue;
    }

    const actual = await readFile(absolutePath, "utf8");
    if (actual === content) {
      removableFiles.push(relativePath);
    } else {
      preservedModifiedFiles.push(relativePath);
    }
  }

  return {
    removableFiles,
    preservedModifiedFiles,
    hasWork: removableFiles.length > 0 || preservedModifiedFiles.length > 0,
  };
}

async function removeEmptyBootstrapDirs(projectRoot) {
  const removableDirs = [
    ".nimi/config",
    ".nimi/contracts",
    ".nimi/methodology",
  ];
  const removedDirs = [];

  for (const relativeDir of removableDirs) {
    const absoluteDir = path.join(projectRoot, relativeDir);
    const info = await pathExists(absoluteDir);
    if (!info || !info.isDirectory()) {
      continue;
    }

    const entries = await readdir(absoluteDir);
    if (entries.length > 0) {
      continue;
    }

    await rmdir(absoluteDir);
    removedDirs.push(relativeDir);
  }

  return removedDirs;
}

export async function previewBootstrapRemoval(projectRoot) {
  return collectBootstrapRemovalState(projectRoot);
}

export async function removeManagedBootstrapFiles(projectRoot) {
  const state = await collectBootstrapRemovalState(projectRoot);

  for (const relativePath of state.removableFiles) {
    await rm(path.join(projectRoot, relativePath), { force: true });
  }

  const removedDirs = await removeEmptyBootstrapDirs(projectRoot);

  return {
    removedFiles: state.removableFiles,
    removedDirs,
    preservedModifiedFiles: state.preservedModifiedFiles,
  };
}
