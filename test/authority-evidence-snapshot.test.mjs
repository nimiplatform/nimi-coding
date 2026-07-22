import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileAuthorityPath } from "../cli/lib/authority/compile.mjs";
import { withGitEvidenceSnapshot } from "../cli/lib/authority/evidence-snapshot.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureAuthority = path.join(packageRoot, "test", "fixtures", "authority", "valid", "yaml");
const temporaryRoots = [];

async function git(repository, args) {
  const result = await execFileAsync("git", args, {
    cwd: repository,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
  });
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-evidence-snapshot-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, ".nimi", "config"), { recursive: true });
  await mkdir(path.join(root, ".nimi", "local"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await cp(fixtureAuthority, path.join(root, ".nimi", "spec"), { recursive: true });
  await writeFile(path.join(root, ".nimi", "config", "authority-evidence.yaml"), "format: nimicoding.authority-evidence-bindings/v1\n", "utf8");
  await writeFile(path.join(root, "src", "provider.mjs"), "export const provider = true;\n", "utf8");
  await writeFile(path.join(root, "test", "provider.test.mjs"), "import { provider } from '../src/provider.mjs';\n", "utf8");
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Nimi Coding Test"]);
  await git(root, ["config", "user.email", "nimicoding@example.invalid"]);
  await git(root, ["add", "--", ".nimi/spec", ".nimi/config/authority-evidence.yaml", "src/provider.mjs", "test/provider.test.mjs"]);
  await git(root, ["commit", "-qm", "fixture"]);
  await writeFile(path.join(root, ".nimi", "local", "probe-results.yaml"), "format: nimicoding.authority-evidence-probe-results/v1\n", "utf8");
  return {
    root,
    bindingPath: ".nimi/config/authority-evidence.yaml",
    probeResultsPath: ".nimi/local/probe-results.yaml",
    locatorPaths: ["test/provider.test.mjs", "src/missing.mjs", "src/provider.mjs"],
  };
}

function args(state, overrides = {}) {
  return {
    repositoryPath: state.root,
    bindingPath: state.bindingPath,
    probeResultsPath: state.probeResultsPath,
    locatorPaths: state.locatorPaths,
    maxInputBytes: 10_000_000,
    ...overrides,
  };
}

async function refusal(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.stack);
    return true;
  });
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("captures one stable current repository evidence snapshot with deterministic shape and exact input-byte budget", async () => {
  const state = await repository();
  const expectedHead = await git(state.root, ["rev-parse", "HEAD"]);
  const beforeStatus = await git(state.root, ["status", "--porcelain=v1", "-z"]);
  let temporaryRoot;
  const captured = await withGitEvidenceSnapshot(args(state), async (snapshot) => {
    temporaryRoot = snapshot.temporaryRoot;
    assert.equal((await lstat(temporaryRoot)).isDirectory(), true);
    const compiled = await compileAuthorityPath(snapshot.authority.root);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    return {
      ...snapshot,
      authority: { ...snapshot.authority },
      inputs: snapshot.inputs.map((entry) => ({ ...entry, bytes: entry.bytes === null ? null : Buffer.from(entry.bytes) })),
    };
  });
  await assert.rejects(lstat(temporaryRoot), { code: "ENOENT" });
  assert.equal(captured.repository, await realpath(state.root));
  assert.equal(captured.headOid, expectedHead);
  assert.match(captured.authority.contentIdentity, /^sha256:[0-9a-f]{64}$/);
  assert(captured.authority.fileCount > 0);
  assert(captured.authority.byteCount > 0);
  assert.deepEqual(captured.inputs.map(({ role, path: inputPath, type }) => ({ role, path: inputPath, type })), [
    { role: "binding", path: state.bindingPath, type: "regular-file" },
    { role: "probe-results", path: state.probeResultsPath, type: "regular-file" },
    { role: "locator", path: "src/missing.mjs", type: "missing" },
    { role: "locator", path: "src/provider.mjs", type: "regular-file" },
    { role: "locator", path: "test/provider.test.mjs", type: "regular-file" },
  ]);
  assert.equal(captured.inputs[2].bytes, null);
  assert.equal(
    captured.capturedInputBytes,
    captured.authority.byteCount + captured.inputs.reduce((total, entry) => total + (entry.bytes?.length ?? 0), 0),
  );
  await withGitEvidenceSnapshot(args(state, { maxInputBytes: captured.capturedInputBytes }), async (snapshot) => {
    assert.equal(snapshot.capturedInputBytes, captured.capturedInputBytes);
  });
  await refusal(
    withGitEvidenceSnapshot(args(state, { maxInputBytes: captured.capturedInputBytes - 1 }), async () => {}),
    "AUTH_EVIDENCE_INPUT_BUDGET",
  );
  assert.equal(await git(state.root, ["status", "--porcelain=v1", "-z"]), beforeStatus);
});

test("refuses unsafe repositories, bindings, supplied results, and locator entry types while preserving stable missing locators", async () => {
  const state = await repository();
  await withGitEvidenceSnapshot(args(state, { probeResultsPath: null }), async (snapshot) => {
    assert.equal(snapshot.inputs.find((entry) => entry.path === "src/missing.mjs").type, "missing");
    assert.equal(snapshot.inputs.some((entry) => entry.role === "probe-results"), false);
  });
  await withGitEvidenceSnapshot(args(state, { probeResultsPath: null, locatorPaths: [] }), async (snapshot) => {
    assert.deepEqual(snapshot.inputs.map((entry) => entry.role), ["binding"]);
  });

  await writeFile(path.join(state.root, ".nimi", "config", "untracked.yaml"), "format: untracked\n", "utf8");
  await refusal(withGitEvidenceSnapshot(args(state, { bindingPath: ".nimi/config/untracked.yaml" }), async () => {}), "AUTH_EVIDENCE_BINDING_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { bindingPath: path.join(state.root, state.bindingPath) }), async () => {}), "AUTH_EVIDENCE_BINDING_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { bindingPath: "src/provider.mjs" }), async () => {}), "AUTH_EVIDENCE_BINDING_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: ["../escape.mjs"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: [".GIT/index"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: ["nested/.git/config"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: ["src/provider.mjs", "src/provider.mjs"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { repositoryPath: path.join(state.root, "src") }), async () => {}), "AUTH_EVIDENCE_REPOSITORY_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { probeResultsPath: ".nimi/local/missing-results.yaml" }), async () => {}), "AUTH_EVIDENCE_INPUT_INVALID");

  await symlink("provider.mjs", path.join(state.root, "src", "provider-link.mjs"));
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: ["src/provider-link.mjs"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await symlink("src", path.join(state.root, "linked-src"));
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: ["linked-src/provider.mjs"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await refusal(withGitEvidenceSnapshot(args(state, { locatorPaths: ["src"] }), async () => {}), "AUTH_EVIDENCE_LOCATOR_INVALID");
  await symlink("probe-results.yaml", path.join(state.root, ".nimi", "local", "probe-results-link.yaml"));
  await refusal(withGitEvidenceSnapshot(args(state, { probeResultsPath: ".nimi/local/probe-results-link.yaml" }), async () => {}), "AUTH_EVIDENCE_INPUT_INVALID");

  const symlinkedBinding = await repository();
  await rm(path.join(symlinkedBinding.root, symlinkedBinding.bindingPath));
  await symlink("../local/probe-results.yaml", path.join(symlinkedBinding.root, symlinkedBinding.bindingPath));
  await refusal(withGitEvidenceSnapshot(args(symlinkedBinding), async () => {}), "AUTH_EVIDENCE_BINDING_INVALID");

  const missingAuthority = await repository();
  await rm(path.join(missingAuthority.root, ".nimi", "spec"), { recursive: true });
  await refusal(withGitEvidenceSnapshot(args(missingAuthority), async () => {}), "AUTH_EVIDENCE_AUTHORITY_INVALID");

  const nonGit = await mkdtemp(path.join(os.tmpdir(), "nimicoding-evidence-non-git-"));
  temporaryRoots.push(nonGit);
  await refusal(withGitEvidenceSnapshot(args(state, { repositoryPath: nonGit }), async () => {}), "AUTH_EVIDENCE_REPOSITORY_INVALID");
});

test("refuses authority, binding, supplied-result, locator-byte, inventory, missing-state, and index races as one mixed snapshot", async (t) => {
  const cases = [
    ["authority bytes", async (state) => writeFile(path.join(state.root, ".nimi", "spec", "session.authority.yaml"), `${await readFile(path.join(state.root, ".nimi", "spec", "session.authority.yaml"), "utf8")}\n`, "utf8"), "afterInitialCapture"],
    ["binding bytes", async (state) => writeFile(path.join(state.root, state.bindingPath), "format: changed\n", "utf8"), "afterInitialCapture"],
    ["supplied result bytes", async (state) => writeFile(path.join(state.root, state.probeResultsPath), "format: changed\n", "utf8"), "afterInitialCapture"],
    ["locator bytes", async (state) => writeFile(path.join(state.root, "src", "provider.mjs"), "export const provider = false;\n", "utf8"), "afterInitialCapture"],
    ["missing locator appears", async (state) => writeFile(path.join(state.root, "src", "missing.mjs"), "export {};\n", "utf8"), "afterInitialCapture"],
    ["authority inventory", async (state) => writeFile(path.join(state.root, ".nimi", "spec", "added.authority.yaml"), "unsupported during race\n", "utf8"), "afterInitialCapture"],
    ["locator changes before commit", async (state) => writeFile(path.join(state.root, "src", "provider.mjs"), "export const provider = 'late';\n", "utf8"), "beforeCaptureCommit"],
    ["binding index", async (state) => git(state.root, ["update-index", "--chmod=+x", "--", state.bindingPath]), "beforeCaptureCommit"],
  ];
  for (const [name, mutate, hook] of cases) {
    await t.test(name, async () => {
      const state = await repository();
      await refusal(withGitEvidenceSnapshot(args(state, {
        hooks: { [hook]: async () => mutate(state) },
      }), async () => {}), "AUTH_EVIDENCE_CAPTURE_CHANGED");
    });
  }
});

test("pins HEAD at capture start and cleans isolated materialization after callback failure", async () => {
  const state = await repository();
  const initialHead = await git(state.root, ["rev-parse", "HEAD"]);
  const observed = await withGitEvidenceSnapshot(args(state, {
    hooks: {
      afterHeadResolved: async () => {
        await git(state.root, ["commit", "--allow-empty", "-qm", "move HEAD"]);
      },
    },
  }), async ({ headOid }) => headOid);
  assert.equal(observed, initialHead);
  assert.notEqual(await git(state.root, ["rev-parse", "HEAD"]), initialHead);

  let temporaryRoot;
  const marker = new Error("callback failure");
  await assert.rejects(withGitEvidenceSnapshot(args(state), async (snapshot) => {
    temporaryRoot = snapshot.temporaryRoot;
    throw marker;
  }), marker);
  await assert.rejects(lstat(temporaryRoot), { code: "ENOENT" });
});
