import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENTS_BEGIN,
  AGENTS_END,
  CLAUDE_BEGIN,
  CLAUDE_END,
} from "../constants.mjs";
import { pathExists, preflightManagedProjectPaths, readUtf8FileFatal } from "./fs-helpers.mjs";

export class ManagedBlockError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagedBlockError";
  }
}

function authorityAuthoringLines() {
  return [
    "- Product authority lives under `.nimi/spec/**`.",
    "- For canonical authority authoring, read only `.nimi/methodology/authority-authoring.yaml`, the affected authority files or bounded task context, and CLI diagnostics.",
    "- Use `nimicoding authority context <path> <id> --max-units <n> --max-bytes <n> --json` only for the complete declared outgoing interpretation closure; it is not complete task context, and failure never permits guessed or partial context.",
    "- Use `nimicoding authority diff` and `authority impact` with explicit `--max-bytes`; impact reports declared review obligations and does not prove implementation, consumers, or tests are synchronized.",
    "- Under `.nimi/spec/**`, author only closed multi-unit `*.authority.yaml` containers or single-unit `*.authority.md`; historical document formats are unsupported and never inferred.",
    "- Run `nimicoding authority fmt` on each changed file, then `nimicoding authority check` on the complete authority input set.",
    "- Never bypass a failure with inferred or fallback semantics; choose repair values only from product/task authority.",
    "- Keep derived and verification evidence under `.nimi/local/**`; it is never product authority.",
  ];
}

function managedAgentsBlock() {
  return [AGENTS_BEGIN, "# Nimi Coding Managed Block", "", ...authorityAuthoringLines(), AGENTS_END].join("\n");
}
function managedClaudeBlock() {
  return [CLAUDE_BEGIN, "# Nimi Coding Managed Block", "", ...authorityAuthoringLines(), CLAUDE_END].join("\n");
}

function occurrenceIndexes(text, marker) {
  const indexes = [];
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(marker, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + marker.length;
  }
  return indexes;
}

export function analyzeManagedBlockText(existing, begin, end, expectedBlock, label = "managed block") {
  const begins = occurrenceIndexes(existing, begin);
  const ends = occurrenceIndexes(existing, end);
  if (begins.length === 0 && ends.length === 0) return { state: "missing", begin: -1, end: -1, exact: false };
  if (begins.length !== 1 || ends.length !== 1) {
    throw new ManagedBlockError(`${label} markers must contain exactly one ordered, non-nested begin/end pair`);
  }
  if (begins[0] >= ends[0]) throw new ManagedBlockError(`${label} markers must contain exactly one ordered, non-nested begin/end pair`);
  const endOffset = ends[0] + end.length;
  const actualBlock = existing.slice(begins[0], endOffset);
  return {
    state: actualBlock === expectedBlock ? "exact" : "drifted",
    begin: begins[0],
    end: endOffset,
    exact: actualBlock === expectedBlock,
  };
}

function upsertManagedBlock(existing, analysis, block) {
  if (analysis.state === "missing") {
    const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${prefix}${block}\n`;
  }
  return `${existing.slice(0, analysis.begin)}${block}${existing.slice(analysis.end)}`;
}

function removeManagedBlock(existing, analysis) {
  if (analysis.state === "missing") return { changed: false, next: existing };
  return {
    changed: true,
    next: `${existing.slice(0, analysis.begin)}${existing.slice(analysis.end)}`,
  };
}

function entrypointDefinitions(projectRoot) {
  return [
    {
      path: path.join(projectRoot, "AGENTS.md"),
      block: managedAgentsBlock(),
      begin: AGENTS_BEGIN,
      end: AGENTS_END,
      header: "# AGENTS.md\n",
      relativePath: "AGENTS.md",
    },
    {
      path: path.join(projectRoot, "CLAUDE.md"),
      block: managedClaudeBlock(),
      begin: CLAUDE_BEGIN,
      end: CLAUDE_END,
      header: "# CLAUDE.md\n",
      relativePath: "CLAUDE.md",
    },
  ];
}

async function inspectDefinition(file) {
  const info = await pathExists(file.path);
  const existing = info?.isFile() ? await readUtf8FileFatal(file.path, file.relativePath) : null;
  const base = existing ?? file.header;
  const analysis = analyzeManagedBlockText(base, file.begin, file.end, file.block, `${file.relativePath} nimicoding managed block`);
  const next = upsertManagedBlock(base, analysis, file.block);
  return { ...file, existing, base, analysis, next, changed: next !== base };
}

export async function inspectEntrypointIntegration(projectRoot) {
  await preflightManagedProjectPaths(projectRoot);
  const states = [];
  for (const file of entrypointDefinitions(projectRoot)) states.push(await inspectDefinition(file));
  return states;
}

export async function previewEntrypointIntegration(projectRoot) {
  return (await inspectEntrypointIntegration(projectRoot)).filter((state) => state.changed).map((state) => state.relativePath);
}

export async function integrateEntrypoints(projectRoot) {
  const states = await inspectEntrypointIntegration(projectRoot);
  const updated = [];
  for (const state of states) {
    if (!state.changed) continue;
    await writeFile(state.path, state.next, "utf8");
    updated.push(state.relativePath);
  }
  return updated;
}

async function inspectEntrypointRemoval(projectRoot) {
  await preflightManagedProjectPaths(projectRoot);
  const states = [];
  for (const file of entrypointDefinitions(projectRoot)) {
    const info = await pathExists(file.path);
    const existing = info?.isFile() ? await readUtf8FileFatal(file.path, file.relativePath) : null;
    if (existing === null) {
      states.push({ ...file, existing, removal: { changed: false, next: "" } });
      continue;
    }
    const analysis = analyzeManagedBlockText(existing, file.begin, file.end, file.block, `${file.relativePath} nimicoding managed block`);
    const removal = removeManagedBlock(existing, analysis);
    states.push({ ...file, existing, removal });
  }
  return states;
}

export async function previewEntrypointRemoval(projectRoot) {
  return (await inspectEntrypointRemoval(projectRoot)).filter((state) => state.removal.changed).map((state) => state.relativePath);
}

export async function removeManagedEntrypoints(projectRoot) {
  const states = await inspectEntrypointRemoval(projectRoot);
  const updatedFiles = [];
  const removedFiles = [];
  for (const state of states) {
    if (!state.removal.changed) continue;
    await writeFile(state.path, state.removal.next, "utf8");
    updatedFiles.push(state.relativePath);
  }
  return { updatedFiles, removedFiles };
}
