import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { analyzeManagedBlockText, ManagedBlockError } from "../cli/lib/entrypoints.mjs";
import { hasExactGitignoreRule, hasExactTextLine, ManagedPathError, preflightManagedProjectPaths } from "../cli/lib/fs-helpers.mjs";

const roots = [];
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-managed-surface-unit-"));
  roots.push(root);
  return root;
}
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("managed block parser admits zero or one ordered pair and rejects malformed marker topology", () => {
  const begin = "<!-- begin -->";
  const end = "<!-- end -->";
  const block = `${begin}\nowned\n${end}`;
  assert.equal(analyzeManagedBlockText("# Host\n", begin, end, block).state, "missing");
  assert.equal(analyzeManagedBlockText(`# Host\n${block}\n`, begin, end, block).state, "exact");
  assert.equal(analyzeManagedBlockText(`# Host\n${begin}\ndrift\n${end}\n`, begin, end, block).state, "drifted");
  for (const malformed of [
    `${begin}\none\n${end}\n${begin}\ntwo\n${end}`,
    `${begin}\nmissing end`,
    `${end}\n${begin}`,
    `${begin}\n${begin}\nnested\n${end}\n${end}`,
  ]) {
    assert.throws(() => analyzeManagedBlockText(malformed, begin, end, block), ManagedBlockError);
  }
});

test("gitignore admission requires one exact effective rule line", () => {
  assert.equal(hasExactGitignoreRule(".nimi/local/\n", ".nimi/local/"), true);
  assert.equal(hasExactGitignoreRule("host-rule\r\n.nimi/local/\r\n", ".nimi/local/"), true);
  assert.equal(hasExactTextLine("*.authority.yaml text eol=lf\r\nhost text\r\n", "*.authority.yaml text eol=lf"), true);
  assert.equal(hasExactTextLine("# *.authority.md text eol=lf\n", "*.authority.md text eol=lf"), false);
  for (const text of [
    "# .nimi/local/\n",
    "docs/.nimi/local/notes\n",
    "!.nimi/local/\n",
    " .nimi/local/\n",
    ".nimi/local/cache\n",
    ".nimi/local/\n!.nimi/local/\n",
    ".nimi/local/\nhost-owned/**\n",
  ]) assert.equal(hasExactGitignoreRule(text, ".nimi/local/"), false, text);
});

test("managed path preflight uses lstat for final, parent, broken, and type-conflict attacks", async () => {
  const external = await temporaryRoot();
  const sentinel = path.join(external, "sentinel");
  await writeFile(sentinel, "sentinel\n", "utf8");

  const finalRoot = await temporaryRoot();
  await symlink(sentinel, path.join(finalRoot, "AGENTS.md"));
  await assert.rejects(preflightManagedProjectPaths(finalRoot), ManagedPathError);

  const parentRoot = await temporaryRoot();
  await symlink(external, path.join(parentRoot, ".nimi"));
  await assert.rejects(preflightManagedProjectPaths(parentRoot), ManagedPathError);

  const brokenRoot = await temporaryRoot();
  await mkdir(path.join(brokenRoot, ".nimi/config"), { recursive: true });
  await symlink(path.join(external, "missing"), path.join(brokenRoot, ".nimi/config/spec-generation-inputs.yaml"));
  await assert.rejects(preflightManagedProjectPaths(brokenRoot), ManagedPathError);

  const conflictRoot = await temporaryRoot();
  await mkdir(path.join(conflictRoot, ".nimi"));
  await writeFile(path.join(conflictRoot, ".nimi/local"), "not a directory\n", "utf8");
  await assert.rejects(preflightManagedProjectPaths(conflictRoot), ManagedPathError);
});
