import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalEvidenceBytes, evidenceAuthorityRepository, parseEvidenceBindings } from "../cli/lib/authority/evidence.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const canonicalFixture = path.join(packageRoot, "test", "fixtures", "authority", "valid", "yaml", "session.authority.yaml");
const bindingPath = ".nimi/config/authority-evidence.yaml";
const resultPath = ".nimi/local/authority-evidence-results.yaml";
const temporaryRoots = [];
const generousBudgets = {
  maxUnits: 100,
  maxBindings: 100,
  maxLocators: 100,
  maxEdges: 100,
  maxInputBytes: 2_000_000,
  maxBytes: 2_000_000,
};

const primaryBinding = Object.freeze({
  id: "checkout.session.command",
  unit: "rule.checkout-session",
  scope: "api.checkout",
  probe: "package-script-target-reachability/v1",
  manifest: "package.json",
  commandScript: "checkout:apply",
  commandTarget: "src/checkout-provider.mjs",
  testScript: "test:checkout",
  testTargets: ["test/checkout-provider.test.mjs"],
  externalProbe: null,
});

const secondaryBinding = Object.freeze({
  id: "checkout.anonymous.command",
  unit: "rule.checkout-no-anonymous",
  scope: "api.checkout",
  probe: "package-script-target-reachability/v1",
  manifest: "package.json",
  commandScript: "checkout:anonymous",
  commandTarget: "src/checkout-anonymous.mjs",
  testScript: "test:checkout:anonymous",
  testTargets: ["test/checkout-anonymous.test.mjs"],
  externalProbe: null,
});

async function temporaryRoot(prefix = "nimicoding-evidence-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function run(executable, args, cwd) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function git(root, args) {
  const result = await run("git", args, root);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

function bindingYaml(binding) {
  const external = binding.externalProbe === null
    ? ["    external_probe: null"]
    : [
      "    external_probe:",
      `      id: ${binding.externalProbe.id}`,
      `      version: ${JSON.stringify(binding.externalProbe.version)}`,
      `      required: ${binding.externalProbe.required}`,
    ];
  return [
    `  - id: ${binding.id}`,
    "    authority:",
    `      unit: ${binding.unit}`,
    `      scope: ${binding.scope}`,
    `    probe: ${binding.probe}`,
    `    manifest: ${binding.manifest}`,
    "    command:",
    `      script: ${binding.commandScript}`,
    `      target: ${binding.commandTarget}`,
    "    tests:",
    `      script: ${binding.testScript}`,
    "      targets:",
    ...binding.testTargets.map((target) => `        - ${target}`),
    ...external,
  ];
}

function bindingsDocument(bindings = [primaryBinding], required = bindings.map((binding) => binding.id)) {
  return [
    "format: nimicoding.authority-evidence-bindings/v1",
    "required_bindings:",
    ...required.map((id) => `  - ${id}`),
    ...(bindings.length === 0 ? ["bindings: []"] : ["bindings:", ...bindings.flatMap(bindingYaml)]),
    "",
  ].join("\n");
}

function scriptsFor(bindings) {
  const scripts = {};
  for (const binding of bindings) {
    scripts[binding.commandScript] = `node --import tsx ${binding.commandTarget}`;
    scripts[binding.testScript] = `pnpm exec vitest run ${binding.testTargets.join(" ")}`;
  }
  return scripts;
}

async function repository({ bindings = [primaryBinding], required = bindings.map((binding) => binding.id) } = {}) {
  const root = await temporaryRoot();
  await mkdir(path.join(root, ".nimi", "spec"), { recursive: true });
  await mkdir(path.join(root, ".nimi", "config"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await cp(canonicalFixture, path.join(root, ".nimi", "spec", "session.authority.yaml"));
  await writeFile(path.join(root, bindingPath), bindingsDocument(bindings, required), "utf8");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "evidence-fixture", private: true, scripts: scriptsFor(bindings) }, null, 2)}\n`, "utf8");
  for (const binding of bindings) {
    await mkdir(path.dirname(path.join(root, binding.commandTarget)), { recursive: true });
    await writeFile(path.join(root, binding.commandTarget), `export const evidenceMarker = ${JSON.stringify(`证据-${binding.id}-😀`)};\n`, "utf8");
    for (const target of binding.testTargets) {
      await mkdir(path.dirname(path.join(root, target)), { recursive: true });
      await writeFile(path.join(root, target), `export const evidenceTestMarker = ${JSON.stringify(`test-${binding.id}`)};\n`, "utf8");
    }
  }
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Nimi Coding Tests"]);
  await git(root, ["config", "user.email", "tests@nimi.invalid"]);
  await git(root, ["add", "--", ".nimi", "package.json", ...(bindings.length > 0 ? ["src", "test"] : [])]);
  await git(root, ["commit", "-q", "-m", "evidence fixture"]);
  return {
    root,
    binding: path.join(root, bindingPath),
    manifest: path.join(root, "package.json"),
    commandTarget: path.join(root, primaryBinding.commandTarget),
  };
}

async function updateManifest(state, update) {
  const manifest = JSON.parse(await readFile(state.manifest, "utf8"));
  update(manifest.scripts);
  await writeFile(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function evidence(state, budgets = {}, probeResults = null) {
  return evidenceAuthorityRepository(state.root, bindingPath, probeResults, { ...generousBudgets, ...budgets });
}

function cliArgs(state, extra = []) {
  return [
    "authority", "evidence", state.root,
    "--bindings", bindingPath,
    "--max-units", String(generousBudgets.maxUnits),
    "--max-bindings", String(generousBudgets.maxBindings),
    "--max-locators", String(generousBudgets.maxLocators),
    "--max-edges", String(generousBudgets.maxEdges),
    "--max-input-bytes", String(generousBudgets.maxInputBytes),
    "--max-bytes", String(generousBudgets.maxBytes),
    ...extra,
  ];
}

function assertNullEvidence(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.evidence, null);
  assert.equal(result.partial, false);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === code), JSON.stringify(result.diagnostics));
}

function assertFixedConformance(product) {
  assert.equal(product.conformanceStatus, "not_evaluated");
  for (const binding of product.bindings) assert.equal(binding.packageProbe.conformance, "not_evaluated");
}

function externalResultYaml(identities, { execution, outcome }, overrides = {}) {
  const authorityIdentity = overrides.authorityContentIdentity ?? identities.authorityContentIdentity;
  const repositoryIdentity = overrides.repositoryInputIdentity ?? identities.repositoryInputIdentity;
  const bindingIdentity = overrides.bindingIdentity ?? identities.bindingIdentity;
  return [
    "format: nimicoding.authority-evidence-probe-results/v1",
    `authority_content_identity: ${authorityIdentity}`,
    `repository_input_identity: ${repositoryIdentity}`,
    `binding_identity: ${bindingIdentity}`,
    "results:",
    "  - binding: checkout.session.command",
    "    probe: checkout.reset.runtime",
    "    version: \"1\"",
    "    adapter:",
    "      id: checkout.test.adapter",
    "      version: \"1\"",
    `    execution: ${execution}`,
    `    outcome: ${outcome === null ? "null" : outcome}`,
    "",
  ].join("\n");
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("reachable command and tests return exact available evidence without execution or conformance claims", async () => {
  const state = await repository();
  const beforeHead = await git(state.root, ["rev-parse", "HEAD"]);
  const beforeStatus = await git(state.root, ["status", "--porcelain=v1", "-z"]);
  const result = await evidence(state);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.partial, false);
  assert.equal(result.evidence.format, "nimicoding.authority-evidence/v1");
  assert.equal(result.evidence.operationStatus, "completed");
  assert.equal(result.evidence.evidenceStatus, "available");
  assert.equal(result.evidence.complete, true);
  assertFixedConformance(result.evidence);
  assert.equal(result.evidence.identities.headCommitOid, beforeHead.trim());
  assert.match(result.evidence.identities.authorityContentIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.evidence.identities.repositoryInputIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.evidence.identities.bindingIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.evidence.identities.externalResultContentIdentity, null);
  assert.equal(result.evidence.identities.unboundRepositoryFilesInspected, false);
  assert.equal(result.evidence.bindings.length, 1);
  const [binding] = result.evidence.bindings;
  assert.deepEqual(binding.authority, {
    unit: "rule.checkout-session",
    scope: "api.checkout",
    location: binding.authority.location,
    scopeLocation: binding.authority.scopeLocation,
  });
  assert.match(binding.authority.location.file, /^\.nimi\/spec\//);
  assert.equal(binding.authority.scopeLocation.file, binding.authority.location.file);
  assert.match(binding.authority.scopeLocation.sourcePointer, /^\/units\/\d+\/scope\/\d+$/);
  assert.deepEqual(binding.packageProbe, {
    id: "package-script-target-reachability/v1",
    version: "1",
    execution: "package_computed",
    reachability: "reachable",
    conformance: "not_evaluated",
  });
  assert.equal(binding.command.edge.status, "reachable");
  assert.deepEqual(binding.tests.edges.map((edge) => edge.status), ["reachable"]);
  const commandScriptLocator = binding.locators.find((locator) => locator.id === "command-script");
  assert.equal(commandScriptLocator.existence, "present");
  assert.equal(commandScriptLocator.repositoryLocation.file, "package.json");
  assert.equal(commandScriptLocator.repositoryLocation.sourcePointer, "/scripts/checkout:apply");
  const testScriptLocator = binding.locators.find((locator) => locator.id === "test-script");
  assert.equal(testScriptLocator.existence, "present");
  assert.equal(testScriptLocator.repositoryLocation.file, "package.json");
  assert.equal(testScriptLocator.repositoryLocation.sourcePointer, "/scripts/test:checkout");
  assert.equal(binding.externalProbe, null);
  assert.equal(binding.edges.length, 6);
  assert.equal(binding.edges.length, result.evidence.counts.proof.edges);
  assert.deepEqual(binding.edges.map((edge) => edge.id), [
    "authority-binding",
    "binding-manifest",
    "command-script-command-target",
    "manifest-command-script",
    "manifest-test-script",
    "test-script-test-target-1",
  ]);
  assert.deepEqual(result.evidence.findings, []);
  assert.deepEqual(result.evidence.gaps, []);
  assert.equal(result.evidence.counts.proof.locators, 6);
  assert.equal(result.evidence.counts.proof.edges, 6);
  const packageObservation = result.evidence.observations.find((item) => item.code === "AUTH_EVIDENCE_PACKAGE_PROBE_OBSERVATION");
  assert(packageObservation);
  assert.equal(packageObservation.witness.execution, "not_executed");
  assert.equal(packageObservation.witness.conformance, "not_evaluated");
  assert.equal(result.evidenceBytes, canonicalEvidenceBytes(result.evidence));
  assert.equal(await git(state.root, ["rev-parse", "HEAD"]), beforeHead);
  assert.equal(await git(state.root, ["status", "--porcelain=v1", "-z"]), beforeStatus);

  const output = await run(process.execPath, [cliPath, ...cliArgs(state), "--json"], state.root);
  assert.equal(output.code, 0, output.stderr || output.stdout);
  assert.equal(output.stderr, "");
  const report = JSON.parse(output.stdout);
  assert.equal(report.operation, "evidence");
  assert.equal(report.evidence.evidenceStatus, "available");
  assert.equal(report.evidence.conformanceStatus, "not_evaluated");
  assert.equal(report.evidence.bindings[0].packageProbe.execution, "package_computed");
});

test("missing script, missing target, and target mismatch return complete unavailable products", async () => {
  const missingScriptState = await repository();
  await updateManifest(missingScriptState, (scripts) => delete scripts[primaryBinding.commandScript]);
  const missingScript = await evidence(missingScriptState);
  assert.equal(missingScript.ok, true);
  assert.equal(missingScript.evidence.evidenceStatus, "unavailable");
  assert.equal(missingScript.evidence.complete, true);
  assert.equal(missingScript.evidence.partial, false);
  assertFixedConformance(missingScript.evidence);
  assert.equal(missingScript.evidence.bindings[0].command.edge.status, "missing");
  assert.equal(missingScript.evidence.bindings[0].locators.find((locator) => locator.id === "command-script").existence, "missing");
  assert.equal(missingScript.evidence.bindings[0].locators.find((locator) => locator.id === "command-script").repositoryLocation, undefined);
  assert(missingScript.evidence.findings.some((item) => item.code === "AUTH_EVIDENCE_REQUIRED_TARGET_UNREACHABLE"));
  assert.deepEqual(missingScript.evidence.gaps, []);

  const missingTargetState = await repository();
  await unlink(missingTargetState.commandTarget);
  const missingTarget = await evidence(missingTargetState);
  assert.equal(missingTarget.ok, true);
  assert.equal(missingTarget.evidence.evidenceStatus, "unavailable");
  assert.equal(missingTarget.evidence.complete, true);
  assert.equal(missingTarget.evidence.bindings[0].command.edge.status, "missing");
  assert.equal(missingTarget.evidence.counts.inputs.locatorFilesMissing, 1);
  assertFixedConformance(missingTarget.evidence);

  const mismatchState = await repository();
  await writeFile(path.join(mismatchState.root, "src", "other-provider.mjs"), "export const unrelated = true;\n", "utf8");
  await updateManifest(mismatchState, (scripts) => {
    scripts[primaryBinding.commandScript] = "node --import tsx src/other-provider.mjs";
  });
  const mismatch = await evidence(mismatchState);
  assert.equal(mismatch.ok, true);
  assert.equal(mismatch.evidence.evidenceStatus, "unavailable");
  assert.equal(mismatch.evidence.complete, true);
  assert.equal(mismatch.evidence.bindings[0].command.edge.status, "mismatch");
  const finding = mismatch.evidence.findings.find((item) => item.logicalTarget === "command-script-target-match");
  assert(finding);
  assert.deepEqual(finding.witness, {
    type: "command-target",
    expected: primaryBinding.commandTarget,
    observed: "src/other-provider.mjs",
    match: false,
  });
  assertFixedConformance(mismatch.evidence);

  const missingAndMismatchState = await repository();
  await unlink(missingAndMismatchState.commandTarget);
  await updateManifest(missingAndMismatchState, (scripts) => {
    scripts[primaryBinding.commandScript] = "node --import tsx src/other-provider.mjs";
  });
  const layered = await evidence(missingAndMismatchState);
  assert.equal(layered.ok, true);
  assert.deepEqual(layered.evidence.findings.map((item) => item.logicalTarget), ["command-script-target-match", "command-target"]);
  assert.equal(new Set(layered.evidence.findings.map((item) => item.fingerprint)).size, layered.evidence.findings.length);
});

test("missing-target fingerprints use stable logical locator IDs instead of repository paths", async () => {
  const fingerprints = [];
  for (const target of ["test/first-location.test.mjs", "test/moved-location.test.mjs"]) {
    const binding = { ...primaryBinding, testTargets: [target] };
    const state = await repository({ bindings: [binding] });
    await unlink(path.join(state.root, target));
    const result = await evidence(state);
    assert.equal(result.ok, true);
    const finding = result.evidence.findings.find((item) => item.logicalTarget === "test-target-1");
    assert(finding);
    assert.equal(finding.witness.path, target);
    fingerprints.push(finding.fingerprint);
  }
  assert.equal(fingerprints[0], fingerprints[1]);
});

test("unsupported shell grammar returns a complete indeterminate gap and never executes the script", async () => {
  const state = await repository();
  const sentinel = path.join(state.root, ".probe-executed");
  await writeFile(path.join(state.root, "src", "create-sentinel.mjs"), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('.probe-executed', 'executed\\n');",
    "",
  ].join("\n"), "utf8");
  await updateManifest(state, (scripts) => {
    scripts[primaryBinding.commandScript] = "node --import tsx src/checkout-provider.mjs && node src/create-sentinel.mjs";
  });
  const result = await evidence(state);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.operationStatus, "completed");
  assert.equal(result.evidence.evidenceStatus, "indeterminate");
  assert.equal(result.evidence.complete, false);
  assert.equal(result.evidence.partial, false);
  assert.deepEqual(result.evidence.findings, []);
  assert.equal(result.evidence.gaps.length, 1);
  assert.equal(result.evidence.gaps[0].code, "AUTH_EVIDENCE_PROBE_UNSUPPORTED");
  assert.equal(result.evidence.bindings[0].packageProbe.reachability, "indeterminate");
  assert.equal(result.evidence.bindings[0].command.edge.status, "indeterminate");
  assertFixedConformance(result.evidence);
  await assert.rejects(lstat(sentinel), (error) => error.code === "ENOENT");

  const missingTargetState = await repository();
  await unlink(missingTargetState.commandTarget);
  await updateManifest(missingTargetState, (scripts) => {
    scripts[primaryBinding.commandScript] = "node --import tsx src/checkout-provider.mjs && node src/never-execute.mjs";
  });
  const layered = await evidence(missingTargetState);
  assert.equal(layered.ok, true);
  assert.equal(layered.evidence.evidenceStatus, "unavailable");
  assert.equal(layered.evidence.complete, false);
  assert.equal(layered.evidence.bindings[0].packageProbe.reachability, "unreachable");
  assert(layered.evidence.findings.some((item) => item.logicalTarget === "command-target"));
  assert(layered.evidence.gaps.some((item) => item.code === "AUTH_EVIDENCE_PROBE_UNSUPPORTED"));
});

test("malformed or null bindings and unknown authority, scope, or probe refuse with null evidence", async () => {
  const state = await repository();
  const valid = bindingsDocument();
  for (const [label, bytes] of [
    ["null", "null\n"],
    ["malformed", `${valid}extra: true\n`],
    ["unknown authority", valid.replace("rule.checkout-session", "rule.checkout-unknown")],
    ["unknown scope", valid.replace("scope: api.checkout", "scope: api.unknown")],
    ["unknown probe", valid.replace("package-script-target-reachability/v1", "unknown-probe/v1")],
    ["same command and test script", valid.replace("script: test:checkout", "script: checkout:apply")],
    ["Git administration alias", valid.replace("src/checkout-provider.mjs", ".GIT/index")],
  ]) {
    await writeFile(state.binding, bytes, "utf8");
    const result = await evidence(state);
    assertNullEvidence(result, "AUTH_EVIDENCE_BINDING_INVALID");
    assert.match(result.diagnostics[0].path, /authority-evidence\.yaml$/, label);
  }

  const portableCollision = await parseEvidenceBindings(Buffer.from(bindingsDocument([
    primaryBinding,
    { ...secondaryBinding, commandTarget: "SRC/checkout-provider.mjs" },
  ])), bindingPath);
  assert.equal(portableCollision.ok, false);
  assert.equal(portableCollision.diagnostics[0].code, "AUTH_EVIDENCE_BINDING_INVALID");
  assert.match(portableCollision.diagnostics[0].reason, /portable-collide/);
});

test("malformed or ambiguously addressable manifests refuse instead of becoming a clean or partial probe result", async () => {
  for (const bytes of [
    "{not-json}\n",
    "{\"scripts\":{},\"scripts\":{}}\n",
    "{\"name\":\"missing-scripts\"}\n",
  ]) {
    const state = await repository();
    await writeFile(state.manifest, bytes, "utf8");
    const result = await evidence(state);
    assertNullEvidence(result, "AUTH_EVIDENCE_MANIFEST_INVALID");
    assert.equal(result.partial, false);
  }
});

test("a missing required binding is an explicit incomplete indeterminate gap", async () => {
  const state = await repository({ required: [primaryBinding.id, "checkout.required.missing"] });
  const result = await evidence(state);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.evidenceStatus, "indeterminate");
  assert.equal(result.evidence.complete, false);
  assert.equal(result.evidence.partial, false);
  assert.equal(result.evidence.bindings[0].packageProbe.reachability, "reachable");
  assert.deepEqual(result.evidence.findings, []);
  const gap = result.evidence.gaps.find((item) => item.code === "AUTH_EVIDENCE_REQUIRED_BINDING_MISSING");
  assert(gap);
  assert.equal(gap.binding, "checkout.required.missing");
  assert.equal(gap.required, true);
  assertFixedConformance(result.evidence);

  const emptyState = await repository({ bindings: [], required: ["checkout.required.missing"] });
  const empty = await evidence(emptyState);
  assert.equal(empty.ok, true, JSON.stringify(empty.diagnostics));
  assert.equal(empty.evidence.evidenceStatus, "indeterminate");
  assert.equal(empty.evidence.complete, false);
  assert.equal(empty.evidence.bindings.length, 0);
  assert.equal(empty.evidence.counts.bindings.configured, 0);
  assert.equal(empty.evidence.counts.proof.locators, 0);
  assert.equal(empty.evidence.counts.proof.edges, 0);
  assert(empty.evidence.gaps.some((item) => item.code === "AUTH_EVIDENCE_REQUIRED_BINDING_MISSING"));
});

test("external supplied results preserve not-provided, pass, failure, execution failure, unsupported, and identity mismatch semantics", async () => {
  const externalBinding = {
    ...primaryBinding,
    externalProbe: { id: "checkout.reset.runtime", version: "1", required: true },
  };
  const state = await repository({ bindings: [externalBinding] });
  const absent = await evidence(state);
  assert.equal(absent.ok, true);
  assert.equal(absent.evidence.evidenceStatus, "indeterminate");
  assert.equal(absent.evidence.complete, false);
  assert.equal(absent.evidence.bindings[0].externalProbe.status, "not_provided");
  assert.equal(absent.evidence.bindings[0].externalProbe.packageAttestation, false);
  assert(absent.evidence.gaps.some((item) => item.code === "AUTH_EVIDENCE_EXTERNAL_PROBE_NOT_PROVIDED"));
  assertFixedConformance(absent.evidence);
  const identities = absent.evidence.identities;
  await mkdir(path.join(state.root, ".nimi", "local"), { recursive: true });

  async function supplied(execution, outcome) {
    await writeFile(path.join(state.root, resultPath), externalResultYaml(identities, { execution, outcome }), "utf8");
    return evidence(state, {}, resultPath);
  }

  const passed = await supplied("completed", "passed");
  assert.equal(passed.ok, true);
  assert.equal(passed.evidence.evidenceStatus, "available");
  assert.equal(passed.evidence.complete, true);
  assert.equal(passed.evidence.bindings[0].externalProbe.status, "reported_completed");
  assert.equal(passed.evidence.bindings[0].externalProbe.reportedOutcome, "reported_passed");
  assert.equal(passed.evidence.bindings[0].externalProbe.source, "external_supplied");
  assert.equal(passed.evidence.bindings[0].externalProbe.packageAttestation, false);
  assert.deepEqual(passed.evidence.gaps, []);
  assert.match(passed.evidence.identities.externalResultContentIdentity, /^sha256:[0-9a-f]{64}$/);
  assertFixedConformance(passed.evidence);

  const reportedFailure = await supplied("completed", "failed");
  assert.equal(reportedFailure.evidence.evidenceStatus, "indeterminate");
  assert.equal(reportedFailure.evidence.complete, false);
  assert.equal(reportedFailure.evidence.bindings[0].externalProbe.reportedOutcome, "reported_failed");
  assert(reportedFailure.evidence.gaps.some((item) => item.code === "AUTH_EVIDENCE_EXTERNAL_PROBE_REPORTED_FAILURE"));
  assertFixedConformance(reportedFailure.evidence);

  const executionFailure = await supplied("failed", null);
  assert.equal(executionFailure.evidence.evidenceStatus, "indeterminate");
  assert.equal(executionFailure.evidence.bindings[0].externalProbe.status, "reported_execution_failed");
  assert(executionFailure.evidence.gaps.some((item) => item.code === "AUTH_EVIDENCE_EXTERNAL_PROBE_EXECUTION_FAILED"));
  assertFixedConformance(executionFailure.evidence);

  const unsupported = await supplied("unsupported", null);
  assert.equal(unsupported.evidence.evidenceStatus, "indeterminate");
  assert.equal(unsupported.evidence.bindings[0].externalProbe.status, "reported_unsupported");
  assert(unsupported.evidence.gaps.some((item) => item.code === "AUTH_EVIDENCE_EXTERNAL_PROBE_UNSUPPORTED"));
  assertFixedConformance(unsupported.evidence);

  const wrongIdentity = `sha256:${"0".repeat(64)}`;
  await writeFile(path.join(state.root, resultPath), externalResultYaml(
    identities,
    { execution: "completed", outcome: "passed" },
    { repositoryInputIdentity: wrongIdentity },
  ), "utf8");
  const mismatched = await evidence(state, {}, resultPath);
  assertNullEvidence(mismatched, "AUTH_EVIDENCE_RESULT_INVALID");
});

test("unit, binding, locator, edge, input-byte, and output-byte budgets hold at exact N and fail at N-1", async () => {
  const state = await repository({ bindings: [primaryBinding, secondaryBinding] });
  const baseline = await evidence(state);
  assert.equal(baseline.ok, true, JSON.stringify(baseline.diagnostics));
  const boundaries = [
    ["maxUnits", baseline.evidence.counts.inputs.authorityUnits],
    ["maxBindings", 2],
    ["maxLocators", baseline.evidence.counts.proof.locators],
    ["maxEdges", baseline.evidence.counts.proof.edges],
    ["maxInputBytes", baseline.evidence.counts.inputs.capturedBytes],
  ];
  for (const [budget, exact] of boundaries) {
    assert(exact > 1, `${budget} requires a positive N-1 boundary`);
    const admitted = await evidence(state, { [budget]: exact });
    assert.equal(admitted.ok, true, `${budget}=N: ${JSON.stringify(admitted.diagnostics)}`);
    assert(admitted.evidence);
    const refused = await evidence(state, { [budget]: exact - 1 });
    assert.equal(refused.evidence, null, budget);
    assert.equal(refused.partial, false, budget);
    assert(refused.diagnostics.some((diagnostic) => ["AUTH_EVIDENCE_BUDGET", "AUTH_EVIDENCE_INPUT_BUDGET"].includes(diagnostic.code)), `${budget}: ${JSON.stringify(refused.diagnostics)}`);
  }

  let exactBytes = baseline.evidenceBytes;
  let exactOutput = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    exactOutput = await evidence(state, { maxBytes: exactBytes });
    assert(exactOutput.evidence, JSON.stringify(exactOutput.diagnostics));
    if (exactOutput.evidenceBytes === exactBytes) break;
    exactBytes = exactOutput.evidenceBytes;
  }
  assert(exactOutput);
  assert.equal(exactOutput.evidenceBytes, exactBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(exactOutput.evidence), "utf8"), exactBytes);
  const outputUnder = await evidence(state, { maxBytes: exactBytes - 1 });
  assertNullEvidence(outputUnder, "AUTH_EVIDENCE_BUDGET");
  assert.equal(outputUnder.evidenceBytes, exactBytes);
});

test("evidence CLI treats incomplete, repeated, invalid, and unknown usage as exit 2", async () => {
  const state = await repository();
  const complete = cliArgs(state);
  const cases = [
    complete.filter((value, index, values) => value !== "--max-bytes" && values[index - 1] !== "--max-bytes"),
    [...complete, "--max-units", "100"],
    complete.map((value) => value === "2000000" ? "0" : value),
    [...complete, "--sarif"],
    [...complete, "extra-positional"],
  ];
  for (const args of cases) {
    const output = await run(process.execPath, [cliPath, ...args, "--json"], state.root);
    assert.equal(output.code, 2, args.join(" "));
    assert.equal(output.stdout, "", args.join(" "));
  }
});

test("packed installed-package CLI evaluates real Git evidence and emits parseable JSON", async () => {
  const root = await temporaryRoot("nimicoding-evidence-packed-");
  const packDirectory = path.join(root, "pack");
  const consumer = path.join(root, "consumer");
  await mkdir(packDirectory);
  await mkdir(consumer);
  const packed = await run("npm", ["pack", "--pack-destination", packDirectory], packageRoot);
  assert.equal(packed.code, 0, packed.stderr || packed.stdout);
  const tarball = path.join(packDirectory, packed.stdout.trim().split("\n").at(-1));
  await writeFile(path.join(consumer, "package.json"), '{"name":"evidence-consumer","private":true}\n', "utf8");
  const installed = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  assert.equal(installed.code, 0, installed.stderr || installed.stdout);

  const state = await repository();
  const bin = path.join(consumer, "node_modules", ".bin", "nimicoding");
  const output = await run(bin, [...cliArgs(state), "--json"], state.root);
  assert.equal(output.code, 0, output.stderr || output.stdout);
  assert.equal(output.stderr, "");
  const report = JSON.parse(output.stdout);
  assert.equal(report.evidence.format, "nimicoding.authority-evidence/v1");
  assert.equal(report.evidence.evidenceStatus, "available");
  assert.equal(report.evidence.complete, true);
  assert.equal(report.evidence.conformanceStatus, "not_evaluated");
  assert.equal(report.evidence.bindings[0].packageProbe.reachability, "reachable");
  assert.equal(report.evidence.bindings[0].packageProbe.execution, "package_computed");
});
