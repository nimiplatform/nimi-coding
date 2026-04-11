import path from "node:path";

import { integrateEntrypoints, pathExists, writeMissingBootstrapFiles } from "../lib/shared.mjs";

function parseInitOptions(args) {
  const options = {
    withEntrypoints: false,
  };

  for (const arg of args) {
    if (arg === "--with-entrypoints") {
      options.withEntrypoints = true;
      continue;
    }

    return {
      ok: false,
      error: `nimicoding init refused: unknown option ${arg}.\n`,
    };
  }

  return {
    ok: true,
    options,
  };
}

export async function runInit(args) {
  const parsed = parseInitOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }

  const projectRoot = process.cwd();
  const nimiRoot = path.join(projectRoot, ".nimi");
  const nimiInfo = await pathExists(nimiRoot);
  const nimiExists = Boolean(nimiInfo);

  if (nimiInfo && !nimiInfo.isDirectory()) {
    process.stderr.write(`nimicoding init refused: ${nimiRoot} exists and is not a directory.\n`);
    return 2;
  }

  if (nimiExists && !parsed.options.withEntrypoints) {
    process.stderr.write(`nimicoding init refused: ${nimiRoot} already exists.\n`);
    return 2;
  }

  let createdFiles = [];
  let createdDirs = [];
  let gitignoreUpdated = false;
  if (!nimiExists) {
    const writeResult = await writeMissingBootstrapFiles(projectRoot);
    createdFiles = writeResult.createdFiles;
    createdDirs = writeResult.createdDirs;
    gitignoreUpdated = writeResult.gitignoreUpdated;
  }

  const updatedEntrypoints = parsed.options.withEntrypoints
    ? await integrateEntrypoints(projectRoot)
    : [];

  const createdLines = nimiExists
    ? []
    : [
      ...createdFiles.map((filePath) => `  - ${filePath}`),
      ...createdDirs.map((dirPath) => `  - ${dirPath}/`),
    ];
  const updatedLines = [
    ...(gitignoreUpdated ? ["  - .gitignore"] : []),
    ...updatedEntrypoints.map((filePath) => `  - ${filePath}`),
  ];

  process.stdout.write(`Initialized nimicoding bootstrap in ${projectRoot}

Created:
${createdLines.length > 0 ? createdLines.join("\n") : "  - no new .nimi seed files (existing project)"}

Updated:
${updatedLines.length > 0 ? updatedLines.join("\n") : "  - no additional files"}

Deferred:
  - topic lifecycle runtime
  - packet-bound run kernel
  - provider execution
  - scheduler, notification, and automation
  - self-hosting execution
`);

  return 0;
}

export { parseInitOptions };
