import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compareText, makeDiagnostic } from "./diagnostics.mjs";

const SNAPSHOT_IDENTITY_FORMAT = "nimicoding.authority-snapshot-content/v1";
const SPEC_ROOT = ".nimi/spec";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class AuthorityReviewRefusal extends Error {
  constructor(code, reason, file = ".") {
    super(reason);
    this.name = "AuthorityReviewRefusal";
    this.code = code;
    this.file = file;
  }
}

export function authorityReviewRefusalDiagnostic(error) {
  return makeDiagnostic({
    code: error.code,
    file: error.file,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason: error.message,
    repair: "provide one complete stable Git repository snapshot; no partial authority review is admitted",
  });
}

function refusal(code, reason, file = ".") {
  return new AuthorityReviewRefusal(code, reason, file);
}

function decodeUtf8(bytes, description, code) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw refusal(code, `${description} is not valid UTF-8`);
  }
}

function childEnvironment() {
  const env = { ...process.env };
  const exact = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]);
  for (const key of Object.keys(env)) {
    if (exact.has(key) || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_") || key.startsWith("GIT_TRACE")) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

async function runGit(repository, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-replace-objects", ...args], {
      cwd: repository,
      env: childEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
  });
}

async function checkedGit(repository, args, code, reason) {
  const result = await runGit(repository, args);
  if (result.signal !== null) throw new Error(`Git process terminated by signal ${result.signal}`);
  if (result.status !== 0) throw refusal(code, reason);
  return result.stdout;
}

function oneLine(bytes, description, code) {
  const text = decodeUtf8(bytes, description, code);
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) throw refusal(code, `${description} is not one exact line`);
  return value;
}

async function resolveRepository(repositoryPath) {
  const requested = path.resolve(process.cwd(), repositoryPath);
  let info;
  try {
    info = await lstat(requested);
  } catch {
    throw refusal("AUTH_REVIEW_GIT_REPOSITORY_INVALID", "repository path is not a readable Git worktree root");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refusal("AUTH_REVIEW_GIT_REPOSITORY_INVALID", "repository path must be one regular non-symlink directory");
  }
  const repository = await realpath(requested);
  const inside = await checkedGit(
    repository,
    ["rev-parse", "--is-inside-work-tree"],
    "AUTH_REVIEW_GIT_REPOSITORY_INVALID",
    "repository path is not a Git worktree",
  );
  if (oneLine(inside, "Git worktree response", "AUTH_REVIEW_GIT_REPOSITORY_INVALID") !== "true") {
    throw refusal("AUTH_REVIEW_GIT_REPOSITORY_INVALID", "repository path is not a non-bare Git worktree");
  }
  const top = oneLine(await checkedGit(
    repository,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    "AUTH_REVIEW_GIT_REPOSITORY_INVALID",
    "repository worktree root cannot be resolved",
  ), "Git worktree root", "AUTH_REVIEW_GIT_REPOSITORY_INVALID");
  let resolvedTop;
  try {
    resolvedTop = await realpath(top);
  } catch {
    throw refusal("AUTH_REVIEW_GIT_REPOSITORY_INVALID", "resolved Git worktree root is not readable");
  }
  if (resolvedTop !== repository) {
    throw refusal("AUTH_REVIEW_GIT_REPOSITORY_INVALID", "repository path must name the exact Git worktree root, not a subdirectory");
  }
  const protectedRoots = [repository];
  for (const [argument, description] of [
    ["--git-dir", "Git worktree administration directory"],
    ["--git-common-dir", "Git common administration directory"],
  ]) {
    const resolved = oneLine(await checkedGit(
      repository,
      ["rev-parse", "--path-format=absolute", argument],
      "AUTH_REVIEW_GIT_REPOSITORY_INVALID",
      `${description} cannot be resolved`,
    ), description, "AUTH_REVIEW_GIT_REPOSITORY_INVALID");
    try {
      protectedRoots.push(await realpath(resolved));
    } catch {
      throw refusal("AUTH_REVIEW_GIT_REPOSITORY_INVALID", `${description} is not readable`);
    }
  }
  return { repository, protectedRoots: [...new Set(protectedRoots)] };
}

function validBaseRef(baseRef) {
  return typeof baseRef === "string"
    && baseRef.length > 0
    && baseRef.trim() === baseRef
    && !baseRef.startsWith("-")
    && !baseRef.includes("\0")
    && !baseRef.includes("\n")
    && !baseRef.includes("\r");
}

async function resolveBaseOid(repository, baseRef) {
  if (!validBaseRef(baseRef)) throw refusal("AUTH_REVIEW_BASE_INVALID", "base ref must be one non-option Git commit expression");
  const bytes = await checkedGit(
    repository,
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
    "AUTH_REVIEW_BASE_INVALID",
    "base ref does not resolve to one commit",
  );
  const oid = oneLine(bytes, "resolved base commit OID", "AUTH_REVIEW_BASE_INVALID");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw refusal("AUTH_REVIEW_BASE_INVALID", "base ref did not resolve to one immutable full commit OID");
  return oid;
}

function splitNullRecords(bytes) {
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", "Git tree output is not NUL-terminated");
    if (end === offset) throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", "Git tree output contains an empty entry");
    records.push(bytes.subarray(offset, end));
    offset = end + 1;
  }
  return records;
}

function parseTreeRecord(record) {
  const tab = record.indexOf(9);
  if (tab <= 0 || tab === record.length - 1) throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", "Git tree entry has an invalid binary record shape");
  const header = decodeUtf8(record.subarray(0, tab), "Git tree entry metadata", "AUTH_REVIEW_BASE_ENTRY_INVALID");
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(header);
  if (!match) throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", "Git tree entry metadata is not exact mode, type, and full OID");
  return {
    mode: match[1],
    objectType: match[2],
    oid: match[3],
    rawPath: record.subarray(tab + 1),
  };
}

function validateRelativePath(value) {
  if (value.length === 0 || path.posix.isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function baseTreeEntries(repository, baseOid, hooks) {
  const rootRecords = splitNullRecords(await checkedGit(
    repository,
    ["ls-tree", "-z", baseOid, "--", SPEC_ROOT],
    "AUTH_REVIEW_GIT_OBJECT_MISSING",
    "base commit or authority tree object is missing",
  ));
  if (rootRecords.length !== 1) throw refusal("AUTH_REVIEW_BASE_SPEC_MISSING", "base commit must contain one complete .nimi/spec tree");
  const root = parseTreeRecord(rootRecords[0]);
  const rootPath = decodeUtf8(root.rawPath, "base authority root path", "AUTH_REVIEW_BASE_ENTRY_INVALID");
  if (root.mode !== "040000" || root.objectType !== "tree" || rootPath !== SPEC_ROOT) {
    throw refusal("AUTH_REVIEW_BASE_SPEC_MISSING", "base .nimi/spec must be one Git tree");
  }
  const records = splitNullRecords(await checkedGit(
    repository,
    ["ls-tree", "-r", "-t", "-z", "--full-tree", root.oid],
    "AUTH_REVIEW_GIT_OBJECT_MISSING",
    "base authority tree object is missing or unreadable",
  ));
  const entries = [{ path: SPEC_ROOT, type: "directory", bytes: null }];
  const seen = new Set([SPEC_ROOT]);
  for (const record of records) {
    const parsed = parseTreeRecord(record);
    const relative = decodeUtf8(parsed.rawPath, "base authority entry path", "AUTH_REVIEW_BASE_ENTRY_INVALID");
    if (!validateRelativePath(relative)) throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", "base authority entry path is not one safe relative portable path");
    const entryPath = `${SPEC_ROOT}/${relative}`;
    if (seen.has(entryPath)) throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", `base authority tree contains a duplicate path: ${entryPath}`);
    seen.add(entryPath);
    if (parsed.mode === "040000" && parsed.objectType === "tree") {
      entries.push({ path: entryPath, type: "directory", bytes: null });
    } else if (["100644", "100755"].includes(parsed.mode) && parsed.objectType === "blob") {
      entries.push({ path: entryPath, type: "regular-file", bytes: null, oid: parsed.oid });
    } else {
      throw refusal("AUTH_REVIEW_BASE_ENTRY_INVALID", `base authority entry is not a regular blob or tree: ${entryPath}`);
    }
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  if (hooks?.afterBaseInventory) await hooks.afterBaseInventory({ repository, baseOid, entries: entries.map(({ path: entryPath, type, oid }) => ({ path: entryPath, type, oid })) });
  for (const entry of entries) {
    if (entry.type !== "regular-file") continue;
    entry.bytes = await checkedGit(
      repository,
      ["cat-file", "blob", entry.oid],
      "AUTH_REVIEW_GIT_OBJECT_MISSING",
      `base authority blob is missing or unreadable: ${entry.path}`,
    );
    delete entry.oid;
  }
  return entries;
}

function statToken(info) {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function filesystemFailure(error, initial, entryPath = SPEC_ROOT) {
  if (error instanceof AuthorityReviewRefusal) return error;
  if (!initial && ["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
    return refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority inventory changed during capture: ${entryPath}`, entryPath);
  }
  return refusal("AUTH_REVIEW_WORKTREE_INVALID", `worktree authority entry is not safely readable: ${entryPath}`, entryPath);
}

async function securedDirectory(absolute, containmentRoot, entryPath, initial) {
  try {
    const before = await lstat(absolute, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority entry is not a regular directory: ${entryPath}`, entryPath);
    const beforeReal = await realpath(absolute);
    if (!contained(containmentRoot, beforeReal)) throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority directory escapes .nimi/spec: ${entryPath}`, entryPath);
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const held = await handle.stat({ bigint: true });
      const current = await lstat(absolute, { bigint: true });
      const currentReal = await realpath(absolute);
      if (!held.isDirectory() || !sameObject(before, held) || !sameObject(held, current) || !contained(containmentRoot, currentReal)) {
        throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority directory changed during capture: ${entryPath}`, entryPath);
      }
      return { handle, token: statToken(held) };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    throw filesystemFailure(error, initial, entryPath);
  }
}

async function openSecuredFile(absolute, containmentRoot, entryPath, initial) {
  try {
    const before = await lstat(absolute, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority entry is not a regular non-symlink file: ${entryPath}`, entryPath);
    const beforeReal = await realpath(absolute);
    if (containmentRoot !== null && !contained(containmentRoot, beforeReal)) throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority file escapes .nimi/spec: ${entryPath}`, entryPath);
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const held = await handle.stat({ bigint: true });
      const current = await lstat(absolute, { bigint: true });
      const currentReal = await realpath(absolute);
      if (!held.isFile() || !sameObject(before, held) || !sameObject(held, current) || (containmentRoot !== null && !contained(containmentRoot, currentReal))) {
        throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority file changed before capture: ${entryPath}`, entryPath);
      }
      return { handle, token: statToken(held) };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    throw filesystemFailure(error, initial, entryPath);
  }
}

async function readHandleBytes(handle, size, entryPath) {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw refusal("AUTH_REVIEW_WORKTREE_INVALID", `worktree authority file is too large to capture exactly: ${entryPath}`, entryPath);
  }
  let bytes;
  try {
    bytes = Buffer.alloc(Number(size));
  } catch {
    throw refusal("AUTH_REVIEW_WORKTREE_INVALID", `worktree authority file is too large to capture exactly: ${entryPath}`, entryPath);
  }
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== bytes.length) throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority file changed while bytes were captured: ${entryPath}`, entryPath);
  return bytes;
}

async function readSecuredFile(secured, absolute, containmentRoot, entryPath, initial) {
  try {
    const heldBefore = await secured.handle.stat({ bigint: true });
    const currentBefore = await lstat(absolute, { bigint: true });
    const currentReal = await realpath(absolute);
    if (!heldBefore.isFile() || statToken(heldBefore) !== secured.token || !sameObject(heldBefore, currentBefore) || (containmentRoot !== null && !contained(containmentRoot, currentReal))) {
      throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority file changed before bytes were captured: ${entryPath}`, entryPath);
    }
    const bytes = await readHandleBytes(secured.handle, heldBefore.size, entryPath);
    const heldAfter = await secured.handle.stat({ bigint: true });
    const currentAfter = await lstat(absolute, { bigint: true });
    if (statToken(heldBefore) !== statToken(heldAfter) || !sameObject(heldAfter, currentAfter) || BigInt(bytes.length) !== heldAfter.size) {
      throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority file changed while bytes were captured: ${entryPath}`, entryPath);
    }
    return { bytes, token: statToken(heldAfter) };
  } catch (error) {
    throw filesystemFailure(error, initial, entryPath);
  }
}

async function securedFile(absolute, containmentRoot, entryPath, initial, retainHandle = false) {
  const secured = await openSecuredFile(absolute, containmentRoot, entryPath, initial);
  let retained = false;
  try {
    const captured = await readSecuredFile(secured, absolute, containmentRoot, entryPath, initial);
    if (retainHandle) {
      retained = true;
      return { ...captured, handle: secured.handle };
    }
    return captured;
  } finally {
    if (!retained) await secured.handle.close();
  }
}

function decodeFileName(name) {
  const bytes = Buffer.isBuffer(name) ? name : Buffer.from(name);
  const value = decodeUtf8(bytes, "worktree authority entry name", "AUTH_REVIEW_WORKTREE_ENTRY_INVALID");
  if (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", "worktree authority entry name is not one safe portable path component");
  }
  return value;
}

async function closeHeldEntries(heldEntries) {
  await Promise.all(heldEntries.map(({ handle }) => handle.close().catch(() => {})));
}

async function scanWorktree(repository, initial, { retainHandles = false } = {}) {
  const nimiPath = path.join(repository, ".nimi");
  const specPath = path.join(repository, ".nimi", "spec");
  try {
    const nimi = await lstat(nimiPath, { bigint: true });
    const spec = await lstat(specPath, { bigint: true });
    if (nimi.isSymbolicLink() || !nimi.isDirectory() || spec.isSymbolicLink() || !spec.isDirectory()) {
      throw refusal("AUTH_REVIEW_WORKTREE_INVALID", "worktree .nimi/spec must be one regular non-symlink directory", SPEC_ROOT);
    }
  } catch (error) {
    if (!initial && !(error instanceof AuthorityReviewRefusal)) throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", "worktree .nimi/spec changed during capture", SPEC_ROOT);
    throw filesystemFailure(error, initial, SPEC_ROOT);
  }
  const specReal = await realpath(specPath);
  const entries = [];
  const heldEntries = [];

  async function walk(absolute, entryPath) {
    const secured = await securedDirectory(absolute, specReal, entryPath, initial);
    entries.push({ path: entryPath, type: "directory", bytes: null, token: secured.token });
    if (retainHandles) heldEntries.push({ path: entryPath, type: "directory", absolute, containmentRoot: specReal, ...secured });
    try {
      let children;
      try {
        children = await readdir(absolute, { withFileTypes: true, encoding: "buffer" });
      } catch (error) {
        throw filesystemFailure(error, initial, entryPath);
      }
      const named = children.map((entry) => decodeFileName(entry.name)).sort(compareText);
      if (new Set(named).size !== named.length) throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority directory contains duplicate decoded paths: ${entryPath}`, entryPath);
      for (const name of named) {
        const childAbsolute = path.join(absolute, name);
        const childPath = `${entryPath}/${name}`;
        let childInfo;
        try {
          childInfo = await lstat(childAbsolute, { bigint: true });
        } catch (error) {
          throw filesystemFailure(error, initial, childPath);
        }
        if (childInfo.isSymbolicLink()) throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority input refuses symbolic link: ${childPath}`, childPath);
        if (childInfo.isDirectory()) await walk(childAbsolute, childPath);
        else if (childInfo.isFile()) {
          const captured = await securedFile(childAbsolute, specReal, childPath, initial, retainHandles);
          entries.push({ path: childPath, type: "regular-file", bytes: captured.bytes, token: captured.token });
          if (retainHandles) heldEntries.push({ path: childPath, type: "regular-file", absolute: childAbsolute, containmentRoot: specReal, ...captured });
        } else throw refusal("AUTH_REVIEW_WORKTREE_ENTRY_INVALID", `worktree authority input contains a non-regular filesystem entry: ${childPath}`, childPath);
      }
      const current = await lstat(absolute, { bigint: true });
      const currentReal = await realpath(absolute);
      const held = await secured.handle.stat({ bigint: true });
      if (statToken(held) !== secured.token || !sameObject(held, current) || !contained(specReal, currentReal)) {
        throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority directory changed during traversal: ${entryPath}`, entryPath);
      }
    } finally {
      if (!retainHandles) await secured.handle.close();
    }
  }

  try {
    await walk(specPath, SPEC_ROOT);
    entries.sort((left, right) => compareText(left.path, right.path));
    heldEntries.sort((left, right) => compareText(left.path, right.path));
    return { entries, heldEntries };
  } catch (error) {
    await closeHeldEntries(heldEntries);
    throw error;
  }
}

async function verifyHeldEntries(heldEntries) {
  const results = await Promise.allSettled(heldEntries.map(async (entry) => {
    if (entry.type === "regular-file") {
      const captured = await readSecuredFile(entry, entry.absolute, entry.containmentRoot, entry.path, false);
      if (captured.token !== entry.token || !captured.bytes.equals(entry.bytes)) {
        throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority file changed before capture commit: ${entry.path}`, entry.path);
      }
      return;
    }
    try {
      const held = await entry.handle.stat({ bigint: true });
      const current = await lstat(entry.absolute, { bigint: true });
      const currentReal = await realpath(entry.absolute);
      if (!held.isDirectory() || statToken(held) !== entry.token || !sameObject(held, current) || !contained(entry.containmentRoot, currentReal)) {
        throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `worktree authority directory changed before capture commit: ${entry.path}`, entry.path);
      }
    } catch (error) {
      throw filesystemFailure(error, false, entry.path);
    }
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

function compareCapturedEntries(first, second, includeTokens) {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    const left = first[index];
    const right = second[index];
    if (left.path !== right.path || left.type !== right.type) return false;
    if (includeTokens && left.token !== right.token) return false;
    if (left.type === "regular-file" && !left.bytes.equals(right.bytes)) return false;
  }
  return true;
}

function semanticEntries(entries) {
  return entries.map(({ path: entryPath, type, bytes }) => ({ path: entryPath, type, bytes }));
}

function frame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

export function authoritySnapshotContentIdentity(entries) {
  const ordered = entries
    .filter((entry) => entry.type === "regular-file")
    .sort((left, right) => compareText(left.path, right.path));
  const hash = createHash("sha256");
  frame(hash, SNAPSHOT_IDENTITY_FORMAT);
  frame(hash, String(ordered.length));
  for (const entry of ordered) {
    frame(hash, entry.type);
    frame(hash, entry.path);
    frame(hash, entry.bytes ?? Buffer.alloc(0));
  }
  return `sha256:${hash.digest("hex")}`;
}

function snapshotCounts(entries) {
  const files = entries.filter((entry) => entry.type === "regular-file");
  return {
    fileCount: files.length,
    byteCount: files.reduce((total, entry) => total + entry.bytes.length, 0),
  };
}

async function materializeEntries(root, entries, invalidCode) {
  const directories = entries.filter((entry) => entry.type === "directory").sort((left, right) => left.path.split("/").length - right.path.split("/").length || compareText(left.path, right.path));
  const files = entries.filter((entry) => entry.type === "regular-file").sort((left, right) => compareText(left.path, right.path));
  try {
    for (const entry of directories) await mkdir(path.join(root, ...entry.path.split("/")), { recursive: true, mode: 0o700 });
    for (const entry of files) {
      const target = path.join(root, ...entry.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entry.bytes, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    if (["EEXIST", "EINVAL", "ENAMETOOLONG", "ENOTDIR"].includes(error?.code)) {
      throw refusal(invalidCode, "authority snapshot paths cannot be represented without collision or escape");
    }
    throw error;
  }
  const readback = semanticEntries((await scanWorktree(root, true)).entries);
  if (!compareCapturedEntries(entries, readback, false)) throw refusal(invalidCode, "materialized authority snapshot does not match captured paths, types, and bytes");
}

async function captureWorktree(repository, hooks) {
  const { entries: first, heldEntries } = await scanWorktree(repository, true, { retainHandles: true });
  try {
    if (hooks?.afterWorktreeCapture) await hooks.afterWorktreeCapture({ repository, entries: semanticEntries(first) });
    const { entries: second } = await scanWorktree(repository, false);
    if (!compareCapturedEntries(first, second, true)) throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", "worktree authority paths, types, metadata, or bytes changed during capture", SPEC_ROOT);
    if (hooks?.beforeWorktreeCaptureCommit) await hooks.beforeWorktreeCaptureCommit({ repository, entries: semanticEntries(first) });
    await verifyHeldEntries(heldEntries);
    return semanticEntries(first);
  } finally {
    await closeHeldEntries(heldEntries);
  }
}

export async function captureStableRegularFile(file, label) {
  const absolute = path.resolve(process.cwd(), file);
  const first = await securedFile(absolute, null, label, true);
  const second = await securedFile(absolute, null, label, false);
  if (first.token !== second.token || !first.bytes.equals(second.bytes)) throw refusal("AUTH_REVIEW_CAPTURE_CHANGED", `review input changed during capture: ${label}`, label);
  return first.bytes;
}

async function createTemporaryRoot(protectedRoots) {
  let base;
  try {
    base = await realpath(os.tmpdir());
    const info = await lstat(base);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw refusal("AUTH_REVIEW_TEMPORARY_INVALID", "system temporary directory is not one readable physical directory");
  }
  if (protectedRoots.some((protectedRoot) => contained(protectedRoot, base))) {
    throw refusal("AUTH_REVIEW_TEMPORARY_INVALID", "system temporary directory must be outside the reviewed worktree and Git administration directories");
  }
  const created = await mkdtemp(path.join(base, "nimicoding-authority-review-"));
  try {
    const temporaryRoot = await realpath(created);
    const info = await lstat(temporaryRoot);
    if (!info.isDirectory() || protectedRoots.some((protectedRoot) => contained(protectedRoot, temporaryRoot) || contained(temporaryRoot, protectedRoot))) {
      throw refusal("AUTH_REVIEW_TEMPORARY_INVALID", "authority snapshots require one isolated temporary directory outside the reviewed repository");
    }
    return temporaryRoot;
  } catch (error) {
    await rm(created, { recursive: true, force: true });
    throw error;
  }
}

export async function withGitAuthoritySnapshots({ repositoryPath, baseRef, hooks = null }, callback) {
  const { repository, protectedRoots } = await resolveRepository(repositoryPath);
  const baseOid = await resolveBaseOid(repository, baseRef);
  if (hooks?.afterBaseResolved) await hooks.afterBaseResolved({ repository, baseOid });
  const baseEntries = await baseTreeEntries(repository, baseOid, hooks);
  const worktreeEntries = await captureWorktree(repository, hooks);
  const temporaryRoot = await createTemporaryRoot(protectedRoots);
  const baseRoot = path.join(temporaryRoot, "base");
  const worktreeRoot = path.join(temporaryRoot, "worktree");
  try {
    await mkdir(baseRoot, { mode: 0o700 });
    await mkdir(worktreeRoot, { mode: 0o700 });
    await materializeEntries(baseRoot, baseEntries, "AUTH_REVIEW_BASE_ENTRY_INVALID");
    await materializeEntries(worktreeRoot, worktreeEntries, "AUTH_REVIEW_WORKTREE_ENTRY_INVALID");
    const baseCounts = snapshotCounts(baseEntries);
    const worktreeCounts = snapshotCounts(worktreeEntries);
    return await callback({
      repository,
      baseOid,
      temporaryRoot,
      base: {
        root: baseRoot,
        contentIdentity: authoritySnapshotContentIdentity(baseEntries),
        ...baseCounts,
      },
      worktree: {
        root: worktreeRoot,
        contentIdentity: authoritySnapshotContentIdentity(worktreeEntries),
        ...worktreeCounts,
      },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export { SNAPSHOT_IDENTITY_FORMAT, SPEC_ROOT };
