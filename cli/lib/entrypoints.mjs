import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENTS_BEGIN,
  AGENTS_END,
  CLAUDE_BEGIN,
  CLAUDE_END,
} from "../constants.mjs";
import { pathExists } from "./fs-helpers.mjs";

function managedAgentsBlock() {
  return [
    AGENTS_BEGIN,
    "# Nimi Coding Managed Block",
    "",
    "- Product and repository authority lives under `/.nimi/spec/**`.",
    "- Read `/.nimi/spec/INDEX.md` first, then the affected kernel contracts and tables.",
    "- Read `/.nimi/methodology/**` for reasoning principles and `/.nimi/contracts/**` for spec construction and validation contracts.",
    "- Treat `/.nimi/{config,contracts,methodology}/**` as package-managed governance support, never as product authority.",
    "- Keep generation evidence under `/.nimi/local/state/spec-generation/**`; it must not become product truth.",
    "- Do not treat this managed block as a replacement for project-specific rules.",
    AGENTS_END,
  ].join("\n");
}
function managedClaudeBlock() {
  return [
    CLAUDE_BEGIN,
    "# Nimi Coding Managed Block",
    "",
    "Authority order:",
    "1. `/.nimi/spec/**`",
    "2. `/.nimi/methodology/**`",
    "3. `/.nimi/contracts/**`",
    "4. `/.nimi/config/**`",
    "5. repository-local AI entry files",
    "",
    "Nimi Coding owns methodology, canonical spec construction, and deterministic validation only.",
    "Keep local generation evidence outside product authority.",
    CLAUDE_END,
  ].join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

function blockPattern(begin, end, leading = false) {
  return new RegExp(
    `${leading ? "(?:\\n\\n)?" : ""}${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}${leading ? "(?:\\n)?" : ""}`,
  );
}

function upsertManagedBlock(existing, begin, end, block) {
  const pattern = blockPattern(begin, end);
  if (pattern.test(existing)) {
    return existing.replace(pattern, block);
  }
  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${prefix}${block}\n`;
}

function removeManagedBlock(existing, begin, end) {
  const pattern = blockPattern(begin, end, true);
  if (!pattern.test(existing)) {
    return { changed: false, next: existing, deleteFile: false };
  }
  const next = existing
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return {
    changed: true,
    next: next.length === 0 ? "" : `${next}\n`,
    deleteFile: next.length === 0,
  };
}

function computeTextFileUpdate(existing, block, begin, end, header) {
  const base = existing ?? header;
  const next = upsertManagedBlock(base, begin, end, block);
  return { changed: next !== base, next };
}

async function upsertTextFile(filePath, block, begin, end, header) {
  const existing = (await pathExists(filePath)) ? await readFile(filePath, "utf8") : header;
  const computed = computeTextFileUpdate(existing, block, begin, end, header);
  if (!computed.changed) return false;
  await writeFile(filePath, computed.next, "utf8");
  return true;
}

async function removeManagedTextFile(filePath, begin, end, emptyFallbackHeader = null) {
  const existing = (await pathExists(filePath)) ? await readFile(filePath, "utf8") : null;
  if (existing === null) return { changed: false, removedFile: false };
  const computed = removeManagedBlock(existing, begin, end);
  if (!computed.changed) return { changed: false, removedFile: false };
  if (computed.deleteFile || (emptyFallbackHeader && computed.next.trim() === emptyFallbackHeader.trim())) {
    await rm(filePath, { force: true });
    return { changed: true, removedFile: true };
  }
  await writeFile(filePath, computed.next, "utf8");
  return { changed: true, removedFile: false };
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

export async function previewEntrypointIntegration(projectRoot) {
  const updates = [];
  for (const file of entrypointDefinitions(projectRoot)) {
    const existing = (await pathExists(file.path)) ? await readFile(file.path, "utf8") : null;
    if (computeTextFileUpdate(existing, file.block, file.begin, file.end, file.header).changed) {
      updates.push(file.relativePath);
    }
  }
  return updates;
}

export async function integrateEntrypoints(projectRoot) {
  const updated = [];
  for (const file of entrypointDefinitions(projectRoot)) {
    if (await upsertTextFile(file.path, file.block, file.begin, file.end, file.header)) {
      updated.push(file.relativePath);
    }
  }
  return updated;
}

export async function previewEntrypointRemoval(projectRoot) {
  const updates = [];
  for (const file of entrypointDefinitions(projectRoot)) {
    const existing = (await pathExists(file.path)) ? await readFile(file.path, "utf8") : null;
    if (existing !== null && removeManagedBlock(existing, file.begin, file.end).changed) {
      updates.push(file.relativePath);
    }
  }
  return updates;
}

export async function removeManagedEntrypoints(projectRoot) {
  const updatedFiles = [];
  const removedFiles = [];
  for (const file of entrypointDefinitions(projectRoot)) {
    const result = await removeManagedTextFile(file.path, file.begin, file.end, file.header.trim());
    if (result.changed) {
      (result.removedFile ? removedFiles : updatedFiles).push(file.relativePath);
    }
  }
  return { updatedFiles, removedFiles };
}
