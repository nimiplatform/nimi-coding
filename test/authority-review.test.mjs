import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";

import { reviewAuthorityRepository } from "../cli/lib/authority/review.mjs";
import { withGitAuthoritySnapshots } from "../cli/lib/authority/git-snapshot.mjs";
import { stringifyCanonicalMarkdown } from "../cli/lib/authority/source-markdown.mjs";
import { stringifyCanonicalYaml } from "../cli/lib/authority/source-yaml.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const canonicalFixture = path.join(packageRoot, "test", "fixtures", "authority", "valid", "yaml", "session.authority.yaml");
const temporaryRoots = [];
const generousBudgets = { maxUnits: 100, maxEdges: 100, maxBytes: 1_000_000 };

async function temporaryRoot(prefix = "nimicoding-review-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function run(executable, args, cwd, environment = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1", ...environment },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function runGit(root, args) {
  return run("git", args, root);
}

function runCli(root, args) {
  return run(process.execPath, [cliPath, ...args], root);
}

function binding(minimum = 1, configured = true) {
  return [
    "format: nimicoding.authority-verifier-bindings/v1",
    "required_bindings:",
    "  - checkout.session-independent-reference",
    configured ? "bindings:" : "bindings: []",
    ...(configured ? [
      "  - id: checkout.session-independent-reference",
      "    detector: minimum-independent-incoming-reference/v1",
      "    premise: rule.checkout-session",
      "    targets:",
      "      - definition.session",
      `    minimum: ${minimum}`,
      "    policy: blocking",
    ] : []),
    "",
  ].join("\n");
}

function emptyDispositions() {
  return "format: nimicoding.authority-impact-dispositions/v1\nrules: []\n";
}

function addressedDisposition(ruleId) {
  return [
    "format: nimicoding.authority-impact-dispositions/v1",
    "rules:",
    `  - id: ${ruleId}`,
    "    consumers:",
    "      - scope: api.checkout",
    "        status: addressed",
    "        evidence: tests/exact-change-review.test.mjs",
    "    test:",
    "      status: addressed",
    "      evidence: tests/exact-change-review.test.mjs",
    "",
  ].join("\n");
}

async function writeUnit(file, unit) {
  await writeFile(file, stringifyCanonicalYaml({ format: "nimicoding.authority/v1", units: [unit] }, { container: true }), "utf8");
}

async function repository() {
  const root = await temporaryRoot();
  const spec = path.join(root, ".nimi", "spec");
  const config = path.join(root, ".nimi", "config");
  await mkdir(spec, { recursive: true });
  await mkdir(config, { recursive: true });
  const source = path.join(spec, "session.authority.yaml");
  const other = path.join(spec, "other.authority.yaml");
  const deleted = path.join(spec, "deleted.authority.yaml");
  const bindings = path.join(config, "authority-verifiers.yaml");
  const dispositions = path.join(config, "authority-impact-dispositions.yaml");
  await cp(canonicalFixture, source);
  await writeUnit(other, {
    id: "definition.other",
    kind: "definition",
    owner: "team.identity",
    lifecycle: "active",
    title: "Other definition",
    meaning: "An alternate exact target used by review mutations.",
    relations: [],
  });
  await writeUnit(deleted, {
    id: "definition.delete-me",
    kind: "definition",
    owner: "team.identity",
    lifecycle: "removed",
    title: "Retained deletion fixture",
    reason: "Retained so physical deletion remains invalid.",
    relations: [],
  });
  await writeFile(bindings, binding(), "utf8");
  await writeFile(dispositions, emptyDispositions(), "utf8");
  assert.equal((await runGit(root, ["init", "-q", "-b", "main"])).code, 0);
  assert.equal((await runGit(root, ["config", "user.name", "Nimi Coding Tests"])).code, 0);
  assert.equal((await runGit(root, ["config", "user.email", "tests@nimi.invalid"])).code, 0);
  assert.equal((await runGit(root, ["add", "--", ".nimi"])).code, 0);
  const committed = await runGit(root, ["commit", "-q", "-m", "authority baseline"]);
  assert.equal(committed.code, 0, committed.stderr);
  return { root, spec, source, other, deleted, bindings, dispositions };
}

function reviewArgs(state, extra = []) {
  return [
    "authority", "review", state.root,
    "--base", "HEAD",
    "--bindings", state.bindings,
    "--dispositions", state.dispositions,
    "--max-units", "100",
    "--max-edges", "100",
    "--max-bytes", "1000000",
    ...extra,
  ];
}

async function replace(file, before, after) {
  const text = await readFile(file, "utf8");
  assert(text.includes(before));
  await writeFile(file, text.replace(before, after), "utf8");
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("clean base and worktree produce identical snapshot identities, semantic zero, and a passed current audit", async () => {
  const state = await repository();
  const beforeHead = (await runGit(state.root, ["rev-parse", "HEAD"])).stdout;
  const beforeStatus = (await runGit(state.root, ["status", "--porcelain=v1", "-z"])).stdout;
  const output = await runCli(state.root, [...reviewArgs(state), "--json"]);
  assert.equal(output.code, 0, output.stderr || output.stdout);
  assert.equal(output.stderr, "");
  const report = JSON.parse(output.stdout);
  assert.equal(report.operation, "review");
  assert.equal(report.ok, true);
  assert.equal(report.partial, false);
  assert.equal(report.review.format, "nimicoding.authority-review/v1");
  assert.equal(report.review.operationStatus, "completed");
  assert.equal(report.review.policyStatus, "passed");
  assert.equal(report.review.complete, true);
  assert.equal(report.review.partial, false);
  assert.match(report.review.snapshots.base.commitOid, /^[0-9a-f]{40}$/);
  assert.equal(report.review.snapshots.base.contentIdentity, report.review.snapshots.worktree.contentIdentity);
  assert.deepEqual(report.review.snapshots.base.counts, { files: 3, units: 8, bytes: report.review.snapshots.base.counts.bytes });
  assert.deepEqual(report.review.snapshots.worktree.counts, report.review.snapshots.base.counts);
  assert.deepEqual(report.review.diff.summary, { units: 0, changes: 0 });
  assert.equal(report.review.impact.complete, true);
  assert.equal(report.review.audit.policyStatus, "passed");
  assert.equal(report.review.audit.findings.length, 0);
  assert.equal(report.review.audit.gaps.length, 0);
  assert.deepEqual(Object.values(report.review.components).map((value) => value.operationStatus), ["completed", "completed", "completed", "completed"]);
  assert.equal(report.review_bytes, Buffer.byteLength(JSON.stringify(report.review), "utf8"));
  assert.equal((await runGit(state.root, ["rev-parse", "HEAD"])).stdout, beforeHead);
  assert.equal((await runGit(state.root, ["status", "--porcelain=v1", "-z"])).stdout, beforeStatus);

  const human = await runCli(state.root, reviewArgs(state));
  assert.equal(human.code, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /^nimicoding authority review: operation=completed; policy=passed; complete=true$/m);
  assert.match(human.stdout, /^semantic changes: 0; impacted units: 0; unresolved obligations: 0$/m);
  assert.doesNotMatch(human.stdout, /review unavailable/);
});

test("tracked field changes preserve exact diff SourceMaps and unresolved impact without attributing current audit findings", async () => {
  const state = await repository();
  await replace(state.source, "condition: Always.", "condition: For authenticated exact review.");
  const unresolved = await runCli(state.root, [...reviewArgs(state), "--json"]);
  assert.equal(unresolved.code, 1, unresolved.stderr || unresolved.stdout);
  const report = JSON.parse(unresolved.stdout);
  assert(report.review);
  assert.equal(report.review.complete, false);
  assert.equal(report.review.policyStatus, "indeterminate");
  assert.notEqual(report.review.snapshots.base.contentIdentity, report.review.snapshots.worktree.contentIdentity);
  assert.deepEqual(report.review.diff.summary, { units: 1, changes: 1 });
  const change = report.review.diff.changes[0];
  assert.deepEqual({ unitId: change.unitId, operation: change.operation, pointer: change.pointer }, {
    unitId: "rule.checkout-session",
    operation: "modified",
    pointer: "/semantic/condition",
  });
  assert.equal(change.beforeSource.file, ".nimi/spec/session.authority.yaml");
  assert.equal(change.afterSource.file, ".nimi/spec/session.authority.yaml");
  assert.match(change.beforeSource.sourcePointer, /\/condition$/);
  assert.match(change.afterSource.sourcePointer, /\/condition$/);
  assert.deepEqual(report.review.impact.obligations.map(({ type, target, disposition }) => [type, target, disposition]), [
    ["consumer", "api.checkout", null],
    ["test", "rule.checkout-session", null],
  ]);
  assert.equal(report.review.audit.policyStatus, "passed");
  assert.equal(report.review.audit.findings.length, 0);
  assert(report.diagnostics.every((diagnostic) => diagnostic.code === "AUTH_IMPACT_UNDISPOSED"));

  await writeFile(state.dispositions, addressedDisposition("rule.checkout-session"), "utf8");
  const addressed = await runCli(state.root, [...reviewArgs(state), "--json"]);
  assert.equal(addressed.code, 0, addressed.stderr || addressed.stdout);
  const addressedReport = JSON.parse(addressed.stdout);
  assert.equal(addressedReport.review.complete, true);
  assert.equal(addressedReport.review.policyStatus, "passed");
  assert(addressedReport.review.impact.obligations.every((obligation) => obligation.disposition?.status === "addressed"));
});

test("untracked canonical files are captured and tracked physical deletion remains fail closed", async () => {
  const addedState = await repository();
  await writeUnit(path.join(addedState.spec, "untracked.authority.yaml"), {
    id: "definition.untracked",
    kind: "definition",
    owner: "team.identity",
    lifecycle: "removed",
    title: "Untracked authority tombstone",
    reason: "Created as an untracked exact review input.",
    relations: [],
  });
  const added = await runCli(addedState.root, [...reviewArgs(addedState), "--json"]);
  assert.equal(added.code, 0, added.stderr || added.stdout);
  const addedReport = JSON.parse(added.stdout);
  assert.equal(addedReport.review.snapshots.base.counts.files, 3);
  assert.equal(addedReport.review.snapshots.worktree.counts.files, 4);
  assert.equal(addedReport.review.snapshots.worktree.counts.units, 9);
  assert(addedReport.review.diff.changes.some((change) => change.unitId === "definition.untracked" && change.operation === "unit_added"));

  const deletedState = await repository();
  await unlink(deletedState.deleted);
  const deleted = await runCli(deletedState.root, [...reviewArgs(deletedState), "--json"]);
  assert.equal(deleted.code, 1);
  const deletedReport = JSON.parse(deleted.stdout);
  assert.equal(deletedReport.review, null);
  assert.equal(deletedReport.partial, false);
  assert(deletedReport.diagnostics.some((diagnostic) => diagnostic.code === "AUTH_DIFF_TRANSITION_INVALID" && /physically disappear/.test(diagnostic.reason)));
});

test("rename, regroup, source order, and YAML-to-Markdown profile conversion remain semantic zero", async () => {
  const state = await repository();
  const document = YAML.parse(await readFile(state.source, "utf8"));
  await rm(state.source);
  for (const [index, unit] of [...document.units].reverse().entries()) {
    await writeFile(
      path.join(state.spec, `regrouped-${index}-多.authority.md`),
      stringifyCanonicalMarkdown({ format: document.format, ...unit }),
      "utf8",
    );
  }
  const output = await runCli(state.root, [...reviewArgs(state), "--json"]);
  assert.equal(output.code, 0, output.stderr || output.stdout);
  const report = JSON.parse(output.stdout);
  assert.notEqual(report.review.snapshots.base.contentIdentity, report.review.snapshots.worktree.contentIdentity);
  assert.equal(report.review.diff.summary.changes, 0);
  assert.equal(report.review.impact.impactedUnits.length, 0);
  assert.equal(report.review.audit.policyStatus, "passed");
  assert(report.review.audit.observations[0].relatedLocations.some(({ location }) => location.file.includes("regrouped-") && location.file.endsWith(".authority.md")));
});

test("invalid Git input, missing spec trees, and missing base blobs never return clean", async () => {
  const invalidRefState = await repository();
  const invalidRef = await runCli(invalidRefState.root, [...reviewArgs(invalidRefState).map((value) => value === "HEAD" ? "refs/heads/missing" : value), "--json"]);
  assert.equal(invalidRef.code, 1);
  assert.equal(JSON.parse(invalidRef.stdout).review, null);
  assert.equal(JSON.parse(invalidRef.stdout).diagnostics[0].code, "AUTH_REVIEW_BASE_INVALID");

  const nonGit = await temporaryRoot("nimicoding-review-nongit-");
  await mkdir(path.join(nonGit, ".nimi", "spec"), { recursive: true });
  const nonGitOutput = await runCli(nonGit, [
    "authority", "review", nonGit, "--base", "HEAD", "--bindings", invalidRefState.bindings, "--dispositions", invalidRefState.dispositions,
    "--max-units", "10", "--max-edges", "10", "--max-bytes", "100000", "--json",
  ]);
  assert.equal(nonGitOutput.code, 1);
  assert.equal(JSON.parse(nonGitOutput.stdout).diagnostics[0].code, "AUTH_REVIEW_GIT_REPOSITORY_INVALID");

  const noSpec = await temporaryRoot("nimicoding-review-nospec-");
  assert.equal((await runGit(noSpec, ["init", "-q", "-b", "main"])).code, 0);
  assert.equal((await runGit(noSpec, ["config", "user.name", "Nimi Coding Tests"])).code, 0);
  assert.equal((await runGit(noSpec, ["config", "user.email", "tests@nimi.invalid"])).code, 0);
  await writeFile(path.join(noSpec, "README.md"), "no authority\n", "utf8");
  assert.equal((await runGit(noSpec, ["add", "--", "README.md"])).code, 0);
  assert.equal((await runGit(noSpec, ["commit", "-q", "-m", "no spec"])).code, 0);
  await mkdir(path.join(noSpec, ".nimi", "spec"), { recursive: true });
  await cp(canonicalFixture, path.join(noSpec, ".nimi", "spec", "session.authority.yaml"));
  const noSpecOutput = await runCli(noSpec, [
    "authority", "review", noSpec, "--base", "HEAD", "--bindings", invalidRefState.bindings, "--dispositions", invalidRefState.dispositions,
    "--max-units", "10", "--max-edges", "10", "--max-bytes", "100000", "--json",
  ]);
  assert.equal(noSpecOutput.code, 1);
  assert.equal(JSON.parse(noSpecOutput.stdout).diagnostics[0].code, "AUTH_REVIEW_BASE_SPEC_MISSING");

  const missingObjectState = await repository();
  const blob = (await runGit(missingObjectState.root, ["rev-parse", "HEAD:.nimi/spec/session.authority.yaml"])).stdout.trim();
  await unlink(path.join(missingObjectState.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const missingObject = await runCli(missingObjectState.root, [...reviewArgs(missingObjectState), "--json"]);
  assert.equal(missingObject.code, 1);
  const missingReport = JSON.parse(missingObject.stdout);
  assert.equal(missingReport.review, null);
  assert.equal(missingReport.partial, false);
  assert.equal(missingReport.diagnostics[0].code, "AUTH_REVIEW_GIT_OBJECT_MISSING");
});

test("complete tree capture includes unsupported blobs and rejects worktree symlinks and invalid canonical bytes", async () => {
  const unsupportedBase = await repository();
  await writeFile(path.join(unsupportedBase.spec, "unsupported.txt"), "must not be filtered\n", "utf8");
  assert.equal((await runGit(unsupportedBase.root, ["add", "--", ".nimi/spec/unsupported.txt"])).code, 0);
  assert.equal((await runGit(unsupportedBase.root, ["commit", "-q", "-m", "unsupported authority entry"])).code, 0);
  const unsupported = await runCli(unsupportedBase.root, [...reviewArgs(unsupportedBase), "--json"]);
  assert.equal(unsupported.code, 1);
  const unsupportedReport = JSON.parse(unsupported.stdout);
  assert.equal(unsupportedReport.review, null);
  assert.equal(unsupportedReport.diagnostics[0].code, "AUTH_REVIEW_CORPUS_INVALID");
  assert.match(unsupportedReport.diagnostics[0].reason, /unsupported\.txt/);
  assert.doesNotMatch(unsupported.stdout, /nimicoding-authority-review-/);

  const unsupportedWorktree = await repository();
  await writeFile(path.join(unsupportedWorktree.spec, "untracked-unsupported.txt"), "must reach compiler admission\n", "utf8");
  const unsupportedCurrent = await runCli(unsupportedWorktree.root, [...reviewArgs(unsupportedWorktree), "--json"]);
  assert.equal(unsupportedCurrent.code, 1);
  const unsupportedCurrentReport = JSON.parse(unsupportedCurrent.stdout);
  assert.equal(unsupportedCurrentReport.review, null);
  assert.equal(unsupportedCurrentReport.diagnostics[0].code, "AUTH_REVIEW_CORPUS_INVALID");
  assert.match(unsupportedCurrentReport.diagnostics[0].reason, /untracked-unsupported\.txt/);

  const baseSymlinkState = await repository();
  const baseSentinel = path.join(baseSymlinkState.root, "base-sentinel.authority.yaml");
  await writeFile(baseSentinel, "outside\n", "utf8");
  await symlink(baseSentinel, path.join(baseSymlinkState.spec, "base-linked.authority.yaml"));
  assert.equal((await runGit(baseSymlinkState.root, ["add", "--", ".nimi/spec/base-linked.authority.yaml"])).code, 0);
  assert.equal((await runGit(baseSymlinkState.root, ["commit", "-q", "-m", "base symlink"])).code, 0);
  const baseLinked = await runCli(baseSymlinkState.root, [...reviewArgs(baseSymlinkState), "--json"]);
  assert.equal(baseLinked.code, 1);
  assert.equal(JSON.parse(baseLinked.stdout).review, null);
  assert.equal(JSON.parse(baseLinked.stdout).diagnostics[0].code, "AUTH_REVIEW_BASE_ENTRY_INVALID");

  const symlinkState = await repository();
  const sentinel = path.join(symlinkState.root, "sentinel.authority.yaml");
  await writeFile(sentinel, "outside\n", "utf8");
  await symlink(sentinel, path.join(symlinkState.spec, "linked.authority.yaml"));
  const linked = await runCli(symlinkState.root, [...reviewArgs(symlinkState), "--json"]);
  assert.equal(linked.code, 1);
  const linkedReport = JSON.parse(linked.stdout);
  assert.equal(linkedReport.review, null);
  assert.equal(linkedReport.diagnostics[0].code, "AUTH_REVIEW_WORKTREE_ENTRY_INVALID");

  const invalidState = await repository();
  await replace(invalidState.source, "    title: Session\n", "    title: Session\n    unknown: forbidden\n");
  const invalid = await runCli(invalidState.root, [...reviewArgs(invalidState), "--json"]);
  assert.equal(invalid.code, 1);
  const invalidReport = JSON.parse(invalid.stdout);
  assert.equal(invalidReport.review, null);
  assert(invalidReport.diagnostics.some((diagnostic) => diagnostic.code === "AUTH_UNKNOWN_FIELD"));
  assert(invalidReport.diagnostics.every((diagnostic) => !diagnostic.path.includes("nimicoding-authority-review-")));
});

test("worktree byte and inventory races refuse the whole capture", async () => {
  for (const phase of ["afterWorktreeCapture", "beforeWorktreeCaptureCommit"]) {
    for (const mutation of ["bytes", "inventory"]) {
      const state = await repository();
      const result = await reviewAuthorityRepository(
        state.root,
        "HEAD",
        state.bindings,
        state.dispositions,
        generousBudgets,
        {
          snapshotHooks: {
            async [phase]() {
              if (mutation === "bytes") await replace(state.source, "condition: Always.", `condition: Changed during ${phase}.`);
              else await writeFile(path.join(state.spec, "appeared.txt"), `inventory changed during ${phase}\n`, "utf8");
            },
          },
        },
      );
      assert.equal(result.ok, false, `${phase}:${mutation}`);
      assert.equal(result.review, null, `${phase}:${mutation}`);
      assert.equal(result.partial, false, `${phase}:${mutation}`);
      assert.equal(result.diagnostics[0].code, "AUTH_REVIEW_CAPTURE_CHANGED", `${phase}:${mutation}`);
    }
  }
});

test("caller-controlled temporary roots inside the repository are refused before materialization", async () => {
  for (const suffix of [[], [".nimi", "spec"], [".nimi", "contracts"]]) {
    const state = await repository();
    const unsafe = path.join(state.root, ...suffix);
    await mkdir(unsafe, { recursive: true });
    const before = (await readdir(unsafe)).sort();
    const output = await run(process.execPath, [cliPath, ...reviewArgs(state), "--json"], state.root, { TMPDIR: unsafe });
    assert.equal(output.code, 1, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout);
    assert.equal(report.review, null);
    assert.equal(report.partial, false);
    assert.equal(report.diagnostics[0].code, "AUTH_REVIEW_TEMPORARY_INVALID");
    assert.deepEqual((await readdir(unsafe)).sort(), before);
    assert(!(await readdir(unsafe)).some((name) => name.startsWith("nimicoding-authority-review-")));
  }
});

test("temporary snapshot materialization is removed after callback success and failure", async () => {
  const state = await repository();
  let successfulRoot;
  await withGitAuthoritySnapshots({ repositoryPath: state.root, baseRef: "HEAD" }, async ({ temporaryRoot }) => {
    successfulRoot = temporaryRoot;
    assert.equal((await lstat(temporaryRoot)).isDirectory(), true);
  });
  await assert.rejects(lstat(successfulRoot), { code: "ENOENT" });

  let failedRoot;
  await assert.rejects(
    withGitAuthoritySnapshots({ repositoryPath: state.root, baseRef: "HEAD" }, async ({ temporaryRoot }) => {
      failedRoot = temporaryRoot;
      throw new Error("callback failure fixture");
    }),
    /callback failure fixture/,
  );
  await assert.rejects(lstat(failedRoot), { code: "ENOENT" });
});

test("a movable ref is resolved once and the review remains bound to the initial full commit OID", async () => {
  const state = await repository();
  const initialOid = (await runGit(state.root, ["rev-parse", "HEAD"])).stdout.trim();
  let resolved;
  const result = await reviewAuthorityRepository(
    state.root,
    "main",
    state.bindings,
    state.dispositions,
    generousBudgets,
    {
      snapshotHooks: {
        async afterBaseResolved({ baseOid }) {
          resolved = baseOid;
          await replace(state.source, "condition: Always.", "condition: Branch moved after resolution.");
          assert.equal((await runGit(state.root, ["add", "--", ".nimi/spec/session.authority.yaml"])).code, 0);
          assert.equal((await runGit(state.root, ["commit", "-q", "-m", "move branch"])).code, 0);
        },
      },
    },
  );
  assert.equal(resolved, initialOid);
  assert(result.review);
  assert.equal(result.review.snapshots.base.commitOid, initialOid);
  assert.notEqual((await runGit(state.root, ["rev-parse", "HEAD"])).stdout.trim(), initialOid);
  assert.equal(result.review.diff.summary.changes, 1);
  assert.equal(result.review.diff.changes[0].before, "Always.");
  assert.equal(result.review.diff.changes[0].after, "Branch moved after resolution.");
});

test("unit, edge, and complete UTF-8 review byte budgets admit exact N and refuse N-1", async () => {
  const state = await repository();
  await rename(state.source, path.join(state.spec, "会话.authority.yaml"));
  const seed = await reviewAuthorityRepository(state.root, "HEAD", state.bindings, state.dispositions, generousBudgets);
  assert(seed.review);
  const traversal = seed.review.audit.counts.traversal;
  const exactTraversal = await reviewAuthorityRepository(state.root, "HEAD", state.bindings, state.dispositions, {
    maxUnits: traversal.units,
    maxEdges: traversal.edges,
    maxBytes: 1_000_000,
  });
  assert(exactTraversal.review);
  for (const budgets of [
    { maxUnits: traversal.units - 1, maxEdges: traversal.edges, maxBytes: 1_000_000 },
    { maxUnits: traversal.units, maxEdges: traversal.edges - 1, maxBytes: 1_000_000 },
  ]) {
    const failed = await reviewAuthorityRepository(state.root, "HEAD", state.bindings, state.dispositions, budgets);
    assert.equal(failed.review, null);
    assert.equal(failed.partial, false);
    assert.equal(failed.diagnostics[0].code, "AUTH_AUDIT_BUDGET");
  }

  let exactBytes = seed.reviewBytes;
  let exact;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    exact = await reviewAuthorityRepository(state.root, "HEAD", state.bindings, state.dispositions, {
      maxUnits: traversal.units,
      maxEdges: traversal.edges,
      maxBytes: exactBytes,
    });
    assert(exact.review, JSON.stringify(exact.diagnostics));
    if (exact.reviewBytes === exactBytes) break;
    exactBytes = exact.reviewBytes;
  }
  assert.equal(exact.reviewBytes, exactBytes);
  const serialized = JSON.stringify(exact.review);
  assert.equal(Buffer.byteLength(serialized, "utf8"), exactBytes);
  assert.notEqual(serialized.length, exactBytes);
  const oneUnder = await reviewAuthorityRepository(state.root, "HEAD", state.bindings, state.dispositions, {
    maxUnits: traversal.units,
    maxEdges: traversal.edges,
    maxBytes: exactBytes - 1,
  });
  assert.equal(oneUnder.review, null);
  assert.equal(oneUnder.partial, false);
  assert.equal(oneUnder.diagnostics[0].code, "AUTH_REVIEW_BUDGET");
  assert.equal(oneUnder.reviewBytes, exactBytes);
});

test("binding and disposition failures are null while required gaps and blocking findings return complete logical products", async () => {
  const missingState = await repository();
  await unlink(missingState.dispositions);
  const missing = await runCli(missingState.root, [...reviewArgs(missingState), "--json"]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).review, null);
  assert.equal(JSON.parse(missing.stdout).diagnostics[0].code, "AUTH_REVIEW_INPUT_INVALID");

  const malformedState = await repository();
  await writeFile(malformedState.dispositions, "format: wrong\nrules: []\n", "utf8");
  const malformed = await runCli(malformedState.root, [...reviewArgs(malformedState), "--json"]);
  assert.equal(malformed.code, 1);
  assert.equal(JSON.parse(malformed.stdout).review, null);
  assert.equal(JSON.parse(malformed.stdout).diagnostics[0].code, "AUTH_IMPACT_DISPOSITION_INVALID");
  assert.equal(JSON.parse(malformed.stdout).diagnostics[0].path, path.basename(malformedState.dispositions));

  const extraState = await repository();
  await writeFile(extraState.dispositions, addressedDisposition("rule.checkout-session"), "utf8");
  const extra = await runCli(extraState.root, [...reviewArgs(extraState), "--json"]);
  assert.equal(extra.code, 1);
  assert.equal(JSON.parse(extra.stdout).review, null);
  assert.equal(JSON.parse(extra.stdout).diagnostics[0].code, "AUTH_IMPACT_DISPOSITION_INVALID");

  const invalidBindingState = await repository();
  await writeFile(invalidBindingState.bindings, binding().replace("minimum-independent-incoming-reference/v1", "unknown/v1"), "utf8");
  const invalidBinding = await runCli(invalidBindingState.root, [...reviewArgs(invalidBindingState), "--json"]);
  assert.equal(invalidBinding.code, 1);
  assert.equal(JSON.parse(invalidBinding.stdout).review, null);
  assert.equal(JSON.parse(invalidBinding.stdout).diagnostics[0].code, "AUTH_AUDIT_BINDING_INVALID");

  const gapState = await repository();
  await writeFile(gapState.bindings, binding(1, false), "utf8");
  const gap = await runCli(gapState.root, [...reviewArgs(gapState), "--json"]);
  assert.equal(gap.code, 1, gap.stderr || gap.stdout);
  const gapReport = JSON.parse(gap.stdout);
  assert(gapReport.review);
  assert.equal(gapReport.review.complete, false);
  assert.equal(gapReport.review.policyStatus, "indeterminate");
  assert.equal(gapReport.review.audit.gaps.length, 1);
  assert.equal(gapReport.review.components.audit.complete, false);

  const blockedState = await repository();
  await replace(
    blockedState.source,
    "statement: Checkout creates an order without a valid session.\n    condition: Always.\n    failure: Reject the request before creating an order.\n    relations:\n      - type: applies_to\n        target: definition.session",
    "statement: Checkout creates an order without a valid session.\n    condition: Always.\n    failure: Reject the request before creating an order.\n    relations:\n      - type: applies_to\n        target: definition.other",
  );
  await writeFile(blockedState.dispositions, addressedDisposition("rule.checkout-no-anonymous"), "utf8");
  const blocked = await runCli(blockedState.root, [...reviewArgs(blockedState), "--json"]);
  assert.equal(blocked.code, 1, blocked.stderr || blocked.stdout);
  const blockedReport = JSON.parse(blocked.stdout);
  assert(blockedReport.review);
  assert.equal(blockedReport.review.complete, true);
  assert.equal(blockedReport.review.policyStatus, "blocked");
  assert.equal(blockedReport.review.audit.complete, true);
  assert.equal(blockedReport.review.audit.findings.length, 1);
  assert.equal(blockedReport.review.audit.findings[0].code, "AUTH_AUDIT_MINIMUM_INDEPENDENT_INCOMING_REFERENCE");
  assert.equal(blockedReport.review.audit.findings[0].target, "definition.session");
});

test("review CLI rejects incomplete or option-like usage with exit 2", async () => {
  const state = await repository();
  for (const args of [
    reviewArgs(state).filter((value, index, values) => value !== "--base" && values[index - 1] !== "--base"),
    [...reviewArgs(state), "--base", "HEAD"],
    reviewArgs(state).map((value) => value === "HEAD" ? "--help" : value),
    reviewArgs(state).map((value) => value === "100" ? "0" : value),
    [...reviewArgs(state), "--sarif"],
  ]) {
    const output = await runCli(state.root, [...args, "--json"]);
    assert.equal(output.code, 2, args.join(" "));
    assert.equal(output.stdout, "");
  }
});

test("packed installed-package CLI performs a real Git review and emits parseable complete JSON", async () => {
  const root = await temporaryRoot("nimicoding-review-packed-");
  const packDirectory = path.join(root, "pack");
  const consumer = path.join(root, "consumer");
  await mkdir(packDirectory);
  await mkdir(consumer);
  const packed = await run("npm", ["pack", "--pack-destination", packDirectory], packageRoot);
  assert.equal(packed.code, 0, packed.stderr || packed.stdout);
  const tarball = path.join(packDirectory, packed.stdout.trim().split("\n").at(-1));
  await writeFile(path.join(consumer, "package.json"), '{"name":"review-consumer","private":true}\n', "utf8");
  const installed = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  assert.equal(installed.code, 0, installed.stderr || installed.stdout);

  const state = await repository();
  const bin = path.join(consumer, "node_modules", ".bin", "nimicoding");
  const output = await run(bin, reviewArgs(state).concat("--json"), state.root);
  assert.equal(output.code, 0, output.stderr || output.stdout);
  const report = JSON.parse(output.stdout);
  assert.equal(report.review.format, "nimicoding.authority-review/v1");
  assert.equal(report.review.snapshots.base.contentIdentity, report.review.snapshots.worktree.contentIdentity);
  assert.equal(report.review.diff.summary.changes, 0);
  assert.equal(report.review.audit.policyStatus, "passed");
});
