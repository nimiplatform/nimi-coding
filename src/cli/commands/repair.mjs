import path from "node:path";

import {
  integrateEntrypoints,
  inspectBootstrapCompatibility,
  pathExists,
  writeMissingBootstrapFiles,
} from "../lib/shared.mjs";

function parseRepairOptions(args) {
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
      error: `nimicoding repair refused: unknown option ${arg}.\n`,
    };
  }

  return {
    ok: true,
    options,
  };
}

export async function runRepair(args) {
  const parsed = parseRepairOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }

  const projectRoot = process.cwd();
  const nimiRoot = path.join(projectRoot, ".nimi");
  const nimiInfo = await pathExists(nimiRoot);

  if (nimiInfo && !nimiInfo.isDirectory()) {
    process.stderr.write(`nimicoding repair refused: ${nimiRoot} exists and is not a directory.\n`);
    return 2;
  }

  const compatibility = await inspectBootstrapCompatibility(projectRoot);
  if (compatibility.status === "unsupported") {
    process.stderr.write(
      "nimicoding repair refused: bootstrap.yaml declares an unsupported bootstrap contract id or version.\n",
    );
    return 1;
  }

  const writeResult = await writeMissingBootstrapFiles(projectRoot);
  const updatedEntrypoints = parsed.options.withEntrypoints
    ? await integrateEntrypoints(projectRoot)
    : [];

  const warnings = [];
  if (compatibility.status === "legacy") {
    warnings.push("Existing bootstrap.yaml is legacy and was preserved without overwriting it.");
  }

  process.stdout.write(`Repaired nimicoding bootstrap in ${projectRoot}

Created:
${[
  ...writeResult.createdFiles.map((filePath) => `  - ${filePath}`),
  ...writeResult.createdDirs.map((dirPath) => `  - ${dirPath}/`),
].join("\n") || "  - no missing bootstrap files or directories"}

Updated:
${[
  ...(writeResult.gitignoreUpdated ? ["  - .gitignore"] : []),
  ...updatedEntrypoints.map((filePath) => `  - ${filePath}`),
].join("\n") || "  - no additional files"}

Warnings:
${warnings.length > 0 ? warnings.map((warning) => `  - ${warning}`).join("\n") : "  - none"}
`);

  return 0;
}

export { parseRepairOptions };
