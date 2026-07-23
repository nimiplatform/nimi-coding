import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AUTHORITY_GITATTRIBUTES_ENTRIES,
  LOCAL_GITIGNORE_ENTRIES,
  REQUIRED_LOCAL_DIRS,
} from "../constants.mjs";
import { createBootstrapSeedFileMap } from "../seeds/bootstrap.mjs";
import {
  appendGitattributesEntries,
  appendGitignoreEntries,
  hasExactGitignoreRule,
  hasExactTextLine,
  normalizeTextToLf,
  pathExists,
  preflightManagedProjectPaths,
  readUtf8FileFatal,
} from "./fs-helpers.mjs";

export async function previewBootstrapWrites(projectRoot) {
  await preflightManagedProjectPaths(projectRoot);
  const missingFiles = [];
  const driftedFiles = [];
  const missingDirs = [];
  const seedMap = await createBootstrapSeedFileMap();

  for (const relativeDir of REQUIRED_LOCAL_DIRS) {
    const dirPath = path.join(projectRoot, relativeDir);
    const info = await pathExists(dirPath);
    if (!info || !info.isDirectory()) {
      missingDirs.push(relativeDir);
    }
  }

  for (const [relativePath, content] of seedMap.entries()) {
    const absolutePath = path.join(projectRoot, relativePath);
    const info = await pathExists(absolutePath);
    if (!info) missingFiles.push(relativePath);
    else if (info.isFile() && await readFile(absolutePath, "utf8") !== normalizeTextToLf(content)) driftedFiles.push(relativePath);
  }

  const gitignoreInfo = await pathExists(path.join(projectRoot, ".gitignore"));
  const gitignoreText = gitignoreInfo?.isFile()
    ? await readUtf8FileFatal(path.join(projectRoot, ".gitignore"), ".gitignore")
    : null;
  const missingGitignoreEntries = gitignoreText === null
    ? LOCAL_GITIGNORE_ENTRIES.slice()
    : LOCAL_GITIGNORE_ENTRIES.filter((entry) => !hasExactGitignoreRule(gitignoreText, entry));
  const gitattributesInfo = await pathExists(path.join(projectRoot, ".gitattributes"));
  const gitattributesText = gitattributesInfo?.isFile()
    ? await readUtf8FileFatal(path.join(projectRoot, ".gitattributes"), ".gitattributes")
    : null;
  const missingGitattributesEntries = gitattributesText === null
    ? AUTHORITY_GITATTRIBUTES_ENTRIES.slice()
    : AUTHORITY_GITATTRIBUTES_ENTRIES.filter((entry) => !hasExactTextLine(gitattributesText, entry));

  return {
    missingFiles,
    driftedFiles,
    missingDirs,
    missingGitignoreEntries,
    missingGitattributesEntries,
    hasWork: missingFiles.length > 0
      || driftedFiles.length > 0
      || missingDirs.length > 0
      || missingGitignoreEntries.length > 0
      || missingGitattributesEntries.length > 0,
  };
}

export async function writeMissingBootstrapFiles(projectRoot) {
  await preflightManagedProjectPaths(projectRoot);
  const createdFiles = [];
  const updatedFiles = [];
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
    const projectionContent = normalizeTextToLf(content);
    const info = await pathExists(absolutePath);
    if (info?.isFile()) {
      if (await readFile(absolutePath, "utf8") !== projectionContent) {
        await writeFile(absolutePath, projectionContent, "utf8");
        updatedFiles.push(relativePath);
      }
      continue;
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, projectionContent, "utf8");
    createdFiles.push(relativePath);
  }

  const gitignoreUpdated = await appendGitignoreEntries(
    path.join(projectRoot, ".gitignore"),
    LOCAL_GITIGNORE_ENTRIES,
  );
  const gitattributesUpdated = await appendGitattributesEntries(
    path.join(projectRoot, ".gitattributes"),
    AUTHORITY_GITATTRIBUTES_ENTRIES,
  );

  return {
    createdFiles,
    updatedFiles,
    createdDirs,
    gitignoreUpdated,
    gitattributesUpdated,
  };
}

const UNINSTALLABLE_BOOTSTRAP_PREFIXES = [".nimi/methodology/"];

function isUninstallableBootstrapPath(relativePath) {
  return UNINSTALLABLE_BOOTSTRAP_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function collectBootstrapRemovalState(projectRoot) {
  await preflightManagedProjectPaths(projectRoot);
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
    if (actual === normalizeTextToLf(content)) {
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
  const removableDirs = [".nimi/methodology"];
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
  await preflightManagedProjectPaths(projectRoot);
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
