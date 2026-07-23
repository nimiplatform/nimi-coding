import path from "node:path";

import {
  integrateEntrypoints,
  pathExists,
  preflightManagedProjectPaths,
  previewBootstrapWrites,
  previewEntrypointIntegration,
  writeMissingBootstrapFiles,
} from "../lib/shared.mjs";
import { localize } from "../lib/ui.mjs";

function parseStartOptions(args) {
  if (args.length === 0) {
    return { ok: true, options: { yes: false } };
  }
  if (args.length === 1 && args[0] === "--yes") {
    return { ok: true, options: { yes: true } };
  }
  return {
    ok: false,
    error: localize(
      `nimicoding start refused: unknown options ${args.join(" ")}.\n`,
      `nimicoding start 已拒绝：未知选项 ${args.join(" ")}。\n`,
    ),
  };
}

export async function runStart(args) {
  const parsed = parseStartOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }

  const projectRoot = process.cwd();
  let bootstrap;
  let entrypoints;
  try {
    await preflightManagedProjectPaths(projectRoot);
    const nimiRoot = path.join(projectRoot, ".nimi");
    const nimiInfo = await pathExists(nimiRoot);
    if (nimiInfo && !nimiInfo.isDirectory()) throw new Error(`${nimiRoot} exists and is not a directory`);

    const bootstrapPreview = await previewBootstrapWrites(projectRoot);
    const entrypointPreview = await previewEntrypointIntegration(projectRoot);
    bootstrap = bootstrapPreview.hasWork
      ? await writeMissingBootstrapFiles(projectRoot)
      : { createdFiles: [], updatedFiles: [], createdDirs: [], gitignoreUpdated: false, gitattributesUpdated: false };
    entrypoints = entrypointPreview.length > 0
      ? await integrateEntrypoints(projectRoot)
      : [];
  } catch (error) {
    process.stderr.write(localize(
      `nimicoding start refused: ${error.message}.\n`,
      `nimicoding start 已拒绝：${error.message}。\n`,
    ));
    return 2;
  }

  const output = {
    ok: true,
    projectRoot,
    bootstrap,
    entrypoints,
    next: [
      "Author project-owned canonical authority under .nimi/spec using only *.authority.yaml or *.authority.md.",
      "Run nimicoding authority fmt on each changed authority file.",
      "Run nimicoding authority check .nimi/spec on the complete canonical root.",
    ],
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

export { parseStartOptions };
