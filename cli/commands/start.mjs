import path from "node:path";

import {
  inspectBootstrapCompatibility,
  integrateEntrypoints,
  pathExists,
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
  const nimiRoot = path.join(projectRoot, ".nimi");
  const nimiInfo = await pathExists(nimiRoot);
  if (nimiInfo && !nimiInfo.isDirectory()) {
    process.stderr.write(localize(
      `nimicoding start refused: ${nimiRoot} exists and is not a directory.\n`,
      `nimicoding start 已拒绝：${nimiRoot} 已存在且不是目录。\n`,
    ));
    return 2;
  }

  const compatibility = await inspectBootstrapCompatibility(projectRoot);
  if (compatibility.status === "unsupported") {
    process.stderr.write(localize(
      "nimicoding start refused: bootstrap.yaml uses an unsupported contract. Run the hard-cut migration before retrying.\n",
      "nimicoding start 已拒绝：bootstrap.yaml 使用了不受支持的 contract。请先完成硬切迁移。\n",
    ));
    return 1;
  }

  const bootstrapPreview = await previewBootstrapWrites(projectRoot);
  const entrypointPreview = await previewEntrypointIntegration(projectRoot);
  const bootstrap = bootstrapPreview.hasWork
    ? await writeMissingBootstrapFiles(projectRoot)
    : { createdFiles: [], createdDirs: [], gitignoreUpdated: false };
  const entrypoints = entrypointPreview.length > 0
    ? await integrateEntrypoints(projectRoot)
    : [];

  const output = {
    ok: true,
    projectRoot,
    bootstrap,
    entrypoints,
    next: [
      "Build or update canonical product authority under .nimi/spec.",
      "Run nimicoding validate-spec-tree.",
      "Run nimicoding validate-spec-audit when generation audit evidence exists.",
    ],
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

export { parseStartOptions };
