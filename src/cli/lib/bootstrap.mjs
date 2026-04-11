import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BOOTSTRAP_CONTRACT_ID,
  BOOTSTRAP_CONTRACT_VERSION,
  LOCAL_GITIGNORE_ENTRIES,
  PACKAGE_NAME,
  REQUIRED_LOCAL_DIRS,
} from "../constants.mjs";
import { createBootstrapSeedFileMap } from "../seeds/bootstrap.mjs";
import { appendGitignoreEntries, pathExists, readTextIfFile } from "./fs-helpers.mjs";
import { readYamlScalar } from "./yaml-helpers.mjs";

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

export async function inspectBootstrapCompatibility(projectRoot) {
  const bootstrapConfigPath = path.join(projectRoot, ".nimi", "config", "bootstrap.yaml");
  const bootstrapConfigText = await readTextIfFile(bootstrapConfigPath);

  if (!bootstrapConfigText) {
    return {
      status: "missing",
      initializedBy: null,
      contractId: null,
      contractVersion: null,
    };
  }

  const initializedBy = readYamlScalar(bootstrapConfigText, "initialized_by");
  const contractId = readYamlScalar(bootstrapConfigText, "bootstrap_contract");
  const contractVersion = readYamlScalar(bootstrapConfigText, "bootstrap_contract_version");

  if (!contractId && !contractVersion) {
    return {
      status: initializedBy === PACKAGE_NAME ? "legacy" : "unsupported",
      initializedBy,
      contractId,
      contractVersion,
    };
  }

  if (initializedBy !== PACKAGE_NAME) {
    return {
      status: "unsupported",
      initializedBy,
      contractId,
      contractVersion,
    };
  }

  if (
    contractId !== BOOTSTRAP_CONTRACT_ID
    || contractVersion !== String(BOOTSTRAP_CONTRACT_VERSION)
  ) {
    return {
      status: "unsupported",
      initializedBy,
      contractId,
      contractVersion,
    };
  }

  return {
    status: "supported",
    initializedBy,
    contractId,
    contractVersion,
  };
}
