import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHARED_INODE_FORBIDDEN_PATHS = new Set([
  ".nimi/methodology/authority-authoring.yaml",
  "AGENTS.md",
  "CLAUDE.md",
  ".gitignore",
  ".gitattributes",
]);
const FATAL_UTF8_HOST_PATHS = new Set(["AGENTS.md", "CLAUDE.md", ".gitignore", ".gitattributes"]);

const BASE_MANAGED_PATHS = [
  [".nimi", "directory"],
  [".nimi/local", "directory"],
  [".nimi/methodology", "directory"],
  [".nimi/methodology/authority-authoring.yaml", "file"],
  [".nimi/config", "directory"],
  [".nimi/config/spec-generation-inputs.yaml", "file"],
  [".nimi/contracts", "directory"],
  [".nimi/contracts/domain-admission.schema.yaml", "file"],
  ["AGENTS.md", "file"],
  ["CLAUDE.md", "file"],
  [".gitignore", "file"],
  [".gitattributes", "file"],
];

export class ManagedPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagedPathError";
  }
}

export class ManagedTextError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagedTextError";
  }
}

export async function pathExists(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function portable(value) {
  return value.split(path.sep).join(path.posix.sep);
}

async function inspectManagedPath(projectRoot, relativePath, expectedType) {
  const components = relativePath.split("/");
  let current = projectRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new ManagedPathError(`cannot inspect managed path ${portable(path.relative(projectRoot, current))}: ${error.message}`);
    }
    const ref = portable(path.relative(projectRoot, current));
    if (info.isSymbolicLink()) throw new ManagedPathError(`managed path boundary refuses symbolic link: ${ref}`);
    const isTarget = index === components.length - 1;
    if (!isTarget && !info.isDirectory()) throw new ManagedPathError(`managed path ancestor must be a directory: ${ref}`);
    if (isTarget && expectedType === "directory" && !info.isDirectory()) throw new ManagedPathError(`managed path must be a directory: ${ref}`);
    if (isTarget && expectedType === "file" && !info.isFile()) throw new ManagedPathError(`managed path must be a regular file: ${ref}`);
    if (isTarget && info.isFile() && SHARED_INODE_FORBIDDEN_PATHS.has(relativePath) && info.nlink > 1) {
      throw new ManagedPathError(`managed regular file must not share an inode: ${ref}`);
    }
    if (isTarget && info.isFile() && FATAL_UTF8_HOST_PATHS.has(relativePath)) await readUtf8FileFatal(current, ref);
  }
}

export async function preflightManagedProjectPaths(projectRoot, options = {}) {
  const absoluteRoot = path.resolve(projectRoot);
  let rootInfo;
  try {
    rootInfo = await lstat(absoluteRoot);
  } catch (error) {
    throw new ManagedPathError(`cannot inspect project root: ${error.message}`);
  }
  if (rootInfo.isSymbolicLink()) throw new ManagedPathError("managed path boundary refuses symbolic-link project root");
  if (!rootInfo.isDirectory()) throw new ManagedPathError("project root must be a directory");
  const specs = options.includeSpec
    ? [...BASE_MANAGED_PATHS, [".nimi/spec", "directory"]]
    : BASE_MANAGED_PATHS;
  for (const [relativePath, expectedType] of specs) {
    await inspectManagedPath(absoluteRoot, relativePath, expectedType);
  }
  return true;
}

export async function readUtf8FileFatal(filePath, label = filePath) {
  const bytes = await readFile(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ManagedTextError(`managed host text is not valid UTF-8: ${label}`);
  }
}

export async function readTextIfFile(filePath) {
  const info = await pathExists(filePath);
  if (!info || !info.isFile() || info.isSymbolicLink()) return null;
  return readFile(filePath, "utf8");
}

export function normalizeTextToLf(text) {
  return String(text).replace(/\r\n?/gu, "\n");
}

function exactTextLines(text) {
  return String(text ?? "")
    .split(/\n/u)
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

export function hasExactTextLine(text, entry) {
  return exactTextLines(text).includes(entry);
}

function effectiveGitignoreRuleLines(text) {
  return String(text ?? "")
    .split(/\n/u)
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function hasExactGitignoreRule(text, entry) {
  return effectiveGitignoreRuleLines(text).at(-1) === entry;
}

export async function appendGitignoreEntries(gitignorePath, entries) {
  const existingInfo = await pathExists(gitignorePath);
  const existing = existingInfo?.isFile() ? await readUtf8FileFatal(gitignorePath, ".gitignore") : "";
  const missing = entries.filter((entry) => !hasExactGitignoreRule(existing, entry));
  if (missing.length === 0) return false;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
  return true;
}

export async function appendGitattributesEntries(gitattributesPath, entries) {
  const existingInfo = await pathExists(gitattributesPath);
  const existing = existingInfo?.isFile() ? await readUtf8FileFatal(gitattributesPath, ".gitattributes") : "";
  const missing = entries.filter((entry) => !hasExactTextLine(existing, entry));
  if (missing.length === 0) return false;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(gitattributesPath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
  return true;
}
