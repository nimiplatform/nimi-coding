import {
  mkdir,
  readFile,
  rm,
  writeFile,
  path,
  test,
  assert,
  YAML,
  repoRoot,
  runNativeCodexSdkPrompt,
  createBootstrapSeedFileMap,
  applyFixtureScenario,
  withTempProject,
  writeGovernanceConfig,
  captureRunCli,
  runCliSubprocess,
  runCutoverReadinessCheck,
  updateSpecGenerationInputs,
  writeBlueprintReference,
  seedReconstructedTargetTruth,
  seedTargetTruthFilesOnly,
  seedHighRiskCandidateArtifacts,
  readYamlFile,
  markCanonicalTreeReady,
  writeLocalCloseoutArtifact,
  materializeFixtureScenario,
  runSpecReconstructionFixtureLoop,
  seedFrozenAuditSweep,
  clusteredAuditFinding,
  writeAuditEvidence,
} from "./nimicoding-test-utils.mjs";
import { evaluateAgentsFreshnessCheck } from "../cli/lib/internal/governance/ai/check-agents-freshness.mjs";
import { buildSpecChunks } from "../cli/lib/audit-sweep-runtime/inventory-spec-chunks.mjs";

const LOCAL_SPEC_GENERATION_AUDIT_REF = ".nimi/local/state/spec-generation/spec-generation-audit.yaml";
const LOCAL_SPEC_GENERATION_AUDIT_SHARD_REF = ".nimi/local/state/spec-generation/spec-generation-audit/files-0001.yaml";

test("package files publish canonical source dirs and start output matches source projection", { concurrency: false }, async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(packageJson.files.includes("adapters"));
  assert.ok(packageJson.files.includes("config"));
  assert.ok(packageJson.files.includes("contracts"));
  assert.ok(packageJson.files.includes("methodology"));
  assert.ok(packageJson.files.includes("spec"));
  assert.ok(packageJson.files.includes("README.zh-CN.md"));
  assert.ok(packageJson.files.includes("CONTRIBUTING.md"));
  assert.ok(packageJson.files.includes("SECURITY.md"));
  assert.ok(packageJson.files.includes("CODE_OF_CONDUCT.md"));
  assert.ok(!packageJson.files.includes("templates"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "methodology", "spec-target-truth-profile.yaml"), "utf8"));

  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    const seedMap = await createBootstrapSeedFileMap();
    assert.ok(!seedMap.has(".nimi/methodology/spec-target-truth-profile.yaml"));
    assert.ok(seedMap.has(".nimi/config/spec-generation-inputs.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/spec-generation-inputs.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/spec-generation-audit.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/topic.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/wave.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/closeout.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/pending-note.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/forbidden-shortcuts.catalog.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/surface-taxonomy.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/placement-contract.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/table-family.schema.yaml"));
    assert.ok(seedMap.has(".nimi/contracts/domain-admission.schema.yaml"));
    assert.ok(seedMap.has(".nimi/methodology/topic-ontology.yaml"));
    assert.ok(seedMap.has(".nimi/methodology/topic-lifecycle.yaml"));
    assert.ok(seedMap.has(".nimi/methodology/four-closure-policy.yaml"));
    assert.ok(!seedMap.has(".nimi/spec/_meta/spec-tree-model.yaml"));
    assert.ok(!seedMap.has(".nimi/spec/_meta/command-gating-matrix.yaml"));
    assert.ok(!seedMap.has(".nimi/spec/_meta/spec-authority-cutover-readiness.yaml"));
    assert.ok(!seedMap.has(".nimi/spec/bootstrap-state.yaml"));
    assert.ok(!seedMap.has(".nimi/spec/product-scope.yaml"));
    for (const [relativePath, expected] of seedMap.entries()) {
      const actual = await readFile(path.join(projectRoot, relativePath), "utf8");
      assert.equal(actual, expected, `source projection mismatch for ${relativePath}`);
    }
    await assert.rejects(readFile(path.join(projectRoot, ".nimi", "methodology", "spec-target-truth-profile.yaml"), "utf8"));
  });
});

test("package repo exposes package source dirs and is not treated as a host project unless initialized", async () => {
  await assert.doesNotReject(readFile(path.join(repoRoot, "methodology", "core.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "methodology", "topic-ontology.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "config", "spec-generation-inputs.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "contracts", "spec-generation-inputs.schema.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "contracts", "topic.schema.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "contracts", "spec-generation-audit.schema.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "spec", "product-scope.yaml"), "utf8"));
  await assert.doesNotReject(readFile(path.join(repoRoot, "spec", "_meta", "spec-tree-model.yaml"), "utf8"));
  await assert.rejects(readFile(path.join(repoRoot, ".nimicoding-dev", "spec", "authority-map.yaml"), "utf8"));
  await assert.rejects(readFile(path.join(repoRoot, "templates", "bootstrap", ".nimi", "config", "bootstrap.yaml"), "utf8"));
  await assert.rejects(readFile(path.join(repoRoot, ".nimi", "config", "bootstrap.yaml"), "utf8"));

  const doctorResult = await runCliSubprocess(["doctor", "--json"]);
  assert.equal(doctorResult.exitCode, 1);

  const payload = JSON.parse(doctorResult.stdout);
  assert.equal(payload.ok, false);
  assert.ok(payload.checks.some((check) => check.id === "nimi_root" && check.ok === false));
});

test("package governance and sweep defaults are host agnostic", async () => {
  await withTempProject(async (projectRoot) => {
    await writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "ordinary-host", private: true, scripts: { test: "node --test" } }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(projectRoot, "AGENTS.md"),
      [
        "# AGENTS.md",
        "## Scope",
        "Ordinary host.",
        "## Hard Boundaries",
        "None.",
        "## Retrieval Defaults",
        "Read source.",
        "## Verification Commands",
        "`pnpm test`",
        "",
      ].join("\n"),
      "utf8",
    );

    const freshness = evaluateAgentsFreshnessCheck({ projectRoot });
    assert.deepEqual(freshness.targets, [{ rel: "AGENTS.md", maxLines: 120 }]);
    assert.deepEqual(freshness.staleTokens, []);
    assert.deepEqual(freshness.failures, []);
  });

  const runtimeChunks = buildSpecChunks([
    { file_ref: ".nimi/spec/runtime/kernel/index.md", extension: ".md", included: true },
  ], {
    targetRootRef: ".",
    criteria: ["quality"],
    appSliceAdmissions: [],
    auditEvidenceRootAdmissions: [],
    packageAuthorityAdmissions: [],
    authorityTextByRef: new Map(),
  });
  const roots = runtimeChunks[0].evidence_roots;
  assert.ok(roots.includes("runtime"));
  assert.ok(roots.includes("config"));
  assert.ok(roots.includes("scripts"));
  assert.ok(!roots.includes("proto/runtime/v1"));
  assert.ok(!roots.includes("runtime/internal/protocol"));
  assert.ok(!roots.includes("sdk/src"));
  assert.ok(!roots.includes("apps/desktop"));
  assert.ok(!roots.includes("nimi-cognition"));
});

test("doctor accepts v2 canonical tree readiness without bootstrap-state lifecycle truth", { concurrency: false }, async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await seedReconstructedTargetTruth(projectRoot);

    const doctorResult = await captureRunCli(["doctor", "--json"]);
    assert.equal(doctorResult.exitCode, 0);

    const payload = JSON.parse(doctorResult.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.lifecycleState.mode, "class_filtered");
    assert.equal(payload.lifecycleState.treeState, "canonical_tree_ready");
    assert.equal(payload.lifecycleState.authorityMode, "surface_class_validated");
    assert.ok(payload.checks.some((check) => check.id === "bootstrap_state_contract" && check.ok === true));

    const textResult = await captureRunCli(["doctor"]);
    assert.equal(textResult.exitCode, 0);
    assert.match(textResult.stdout, /project rules: ready/);
    assert.match(textResult.stdout, /lifecycle: canonical_tree_ready \/ surface_class_validated/);
    assert.doesNotMatch(textResult.stdout, /project rules: invalid/);
    assert.doesNotMatch(textResult.stdout, /lifecycle: unknown \/ unknown/);
  });
});

test("doctor accepts v2 readiness after legacy meta carriers move out of host spec", { concurrency: false }, async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    const legacyMoves = [
      {
        packageSource: "spec/_meta/spec-tree-model.yaml",
        hostRef: ".nimi/spec/_meta/spec-tree-model.yaml",
        localRef: ".nimi/local/state/spec-tree-model.yaml",
      },
      {
        packageSource: "spec/_meta/command-gating-matrix.yaml",
        hostRef: ".nimi/spec/_meta/command-gating-matrix.yaml",
        localRef: ".nimi/local/state/command-gating-matrix.yaml",
      },
      {
        packageSource: "spec/bootstrap-state.yaml",
        hostRef: ".nimi/spec/bootstrap-state.yaml",
        localRef: ".nimi/local/state/bootstrap-state.yaml",
      },
    ];

    for (const legacyMove of legacyMoves) {
      const content = await readFile(path.join(repoRoot, legacyMove.packageSource), "utf8");
      const hostPath = path.join(projectRoot, legacyMove.hostRef);
      const localPath = path.join(projectRoot, legacyMove.localRef);
      await mkdir(path.dirname(hostPath), { recursive: true });
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(hostPath, content, "utf8");
      await writeFile(localPath, content, "utf8");
      await rm(hostPath, { force: true });
    }

    await seedReconstructedTargetTruth(projectRoot);

    const doctorResult = await captureRunCli(["doctor", "--json"]);
    assert.equal(doctorResult.exitCode, 0);
    const payload = JSON.parse(doctorResult.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.lifecycleState.treeState, "canonical_tree_ready");
    assert.equal(payload.lifecycleState.authorityMode, "surface_class_validated");
    assert.equal(payload.specGenerationAudit.auditPath, ".nimi/local/state/spec-generation/spec-generation-audit.yaml");
  });
});

test("doctor fails closed when v2 benchmark mode lacks a blueprint reference", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await updateSpecGenerationInputs(projectRoot, (inputs) => {
      inputs.benchmark_blueprint_root = "spec";
      inputs.benchmark_mode = "repo_spec_blueprint";
      inputs.acceptance_mode = "semantic_and_structural_parity_when_blueprint_exists";
    });

    const doctorResult = await captureRunCli(["doctor", "--json"]);
    assert.equal(doctorResult.exitCode, 1);
    const payload = JSON.parse(doctorResult.stdout);
    assert.equal(payload.ok, false);
    const blueprintCheck = payload.checks.find((check) => check.id === "blueprint_reference_contract");
    assert.equal(blueprintCheck.ok, false);
    assert.equal(blueprintCheck.severity, "error");
    const benchmarkCheck = payload.checks.find((check) => check.id === "benchmark_audit_readiness");
    assert.equal(benchmarkCheck.ok, false);
    assert.equal(benchmarkCheck.severity, "warn");
  });
});

test("repo docs describe standalone package authority without monorepo cutover truth", async () => {
  const agents = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");
  const packageReadme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const packageReadmeZh = await readFile(path.join(repoRoot, "README.zh-CN.md"), "utf8");
  const adapterReadme = await readFile(path.join(repoRoot, "adapters", "oh-my-codex", "README.md"), "utf8");

  assert.match(agents, /Package-owned methodology source lives directly under `config\/\*\*`, `contracts\/\*\*`, `methodology\/\*\*`, and `spec\/\*\*`/);
  assert.match(packageReadme, /standalone host-agnostic boundary package/i);
  assert.match(packageReadme, /does\s+not\s+make\s+a\s+host\s+read\s+package\s+source\s+paths\s+directly/i);
  assert.match(packageReadmeZh, /standalone host-agnostic boundary package/i);
  assert.match(packageReadmeZh, /包不会让 host 直接读取包源路径/i);
  assert.match(adapterReadme, /\.nimi\/spec\/\*\*` is current authority only when the\s+host has admitted or reconstructed it/i);
  assert.doesNotMatch(`${agents}\n${packageReadme}\n${packageReadmeZh}\n${adapterReadme}`, /In this monorepo|nimi\/nimi-coding|check:spec-authority-cutover-readiness|\/Users\/snwozy\/nimi-realm\/nimi\/nimi-coding/);
});

test("readme topic examples stay aligned with current CLI argument shape", async () => {
  const packageReadme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const packageReadmeZh = await readFile(path.join(repoRoot, "README.zh-CN.md"), "utf8");
  const docs = `${packageReadme}\n${packageReadmeZh}`;

  assert.match(docs, /nimicoding topic wave add <topic-id> <wave-id> <slug>\s+\\\n\s+--goal <text> --owner-domain <domain>/);
  assert.match(docs, /nimicoding topic packet freeze <topic-id> --from <draft-path>/);
  assert.doesNotMatch(docs, /nimicoding topic wave add <topic-id> --owner <domain> --goal <text>/);
  assert.doesNotMatch(docs, /nimicoding topic packet freeze <topic-id> --wave <wave-id>/);
});

test("start output does not install pre-cutover readiness artifacts into host spec", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    const readinessPath = path.join(projectRoot, ".nimi", "spec", "_meta", "spec-authority-cutover-readiness.yaml");
    await assert.rejects(readFile(readinessPath, "utf8"));
  });
});

test("validate-spec-tree accepts a canonical benchmark tree after direct materialization", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "benchmark_success");

    const result = await runCliSubprocess(["validate-spec-tree"], { cwd: projectRoot });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.validator, "validate-spec-tree");
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.profile, "surface_taxonomy_v1");
    assert.equal(payload.summary.missingRequired.length, 0);
  });
});

test("validate-spec-tree fails when a required canonical file is missing after direct materialization", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "missing_domain_file");

    const result = await runCliSubprocess(["validate-spec-tree"], { cwd: projectRoot });
    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.validator, "validate-spec-tree");
    assert.equal(payload.ok, false);
    assert.equal(payload.refusal.code, "SPEC_TREE_INVALID");
    assert.match(JSON.stringify(payload.errors), /missing required canonical files/i);
  });
});

test("validate-spec-tree fails when generated views are placed under product authority roots", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "benchmark_success");

    const generatedPath = path.join(projectRoot, ".nimi", "spec", "runtime", "kernel", "generated", "overview.md");
    await mkdir(path.dirname(generatedPath), { recursive: true });
    await writeFile(generatedPath, "# Generated View\n", "utf8");

    const result = await runCliSubprocess(["validate-spec-tree"], { cwd: projectRoot });
    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.validator, "validate-spec-tree");
    assert.equal(payload.ok, false);
    assert.equal(payload.refusal.code, "SPEC_TREE_INVALID");
    assert.match(JSON.stringify(payload.errors), /derived_view_under_product_authority_root/i);
  });
});

test("validate-spec-audit accepts an auditable canonical benchmark tree after direct materialization", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "benchmark_success");

    const result = await runCliSubprocess(["validate-spec-audit"], { cwd: projectRoot });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.validator, "validate-spec-audit");
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.requiredAuditedFiles, 4);
  });
});

test("validate-spec-audit accepts file entries from canonical audit shards", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "benchmark_success");

    const auditPath = path.join(projectRoot, LOCAL_SPEC_GENERATION_AUDIT_REF);
    const auditPayload = YAML.parse(await readFile(auditPath, "utf8"));
    const files = auditPayload.spec_generation_audit.files;
    auditPayload.spec_generation_audit.files = [];
    auditPayload.spec_generation_audit.file_entry_refs = [
      LOCAL_SPEC_GENERATION_AUDIT_SHARD_REF,
    ];

    const shardPath = path.join(
      projectRoot,
      ...LOCAL_SPEC_GENERATION_AUDIT_SHARD_REF.split("/"),
    );
    await mkdir(path.dirname(shardPath), { recursive: true });
    await writeFile(
      shardPath,
      YAML.stringify({
        version: 2,
        contract_ref: ".nimi/contracts/spec-generation-audit.schema.yaml",
        spec_generation_audit_file_entries: {
          parent_ref: LOCAL_SPEC_GENERATION_AUDIT_REF,
          files,
        },
      }),
      "utf8",
    );
    await writeFile(auditPath, YAML.stringify(auditPayload), "utf8");

    const result = await runCliSubprocess(["validate-spec-audit"], { cwd: projectRoot });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.validator, "validate-spec-audit");
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.auditedFiles, files.length);
    assert.deepEqual(payload.summary.missingAuditEntries, []);
  });
});

test("validate-spec-audit rejects invalid file entry shards", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "benchmark_success");

    const auditPath = path.join(projectRoot, LOCAL_SPEC_GENERATION_AUDIT_REF);
    const auditPayload = YAML.parse(await readFile(auditPath, "utf8"));
    const files = auditPayload.spec_generation_audit.files;
    auditPayload.spec_generation_audit.files = [];
    auditPayload.spec_generation_audit.file_entry_refs = [
      LOCAL_SPEC_GENERATION_AUDIT_SHARD_REF,
    ];

    const shardPath = path.join(projectRoot, ...LOCAL_SPEC_GENERATION_AUDIT_SHARD_REF.split("/"));
    await mkdir(path.dirname(shardPath), { recursive: true });
    await writeFile(
      shardPath,
      YAML.stringify({
        version: 2,
        contract_ref: ".nimi/contracts/spec-generation-audit.schema.yaml",
        spec_generation_audit_file_entries: {
          parent_ref: ".nimi/local/state/spec-generation/other-audit.yaml",
          files,
        },
      }),
      "utf8",
    );
    await writeFile(auditPath, YAML.stringify(auditPayload), "utf8");

    const parentResult = await runCliSubprocess(["validate-spec-audit"], { cwd: projectRoot });
    assert.equal(parentResult.exitCode, 1);
    assert.match(JSON.stringify(JSON.parse(parentResult.stdout).errors), /parent_ref must point to \.nimi\/local\/state\/spec-generation\/spec-generation-audit\.yaml/);

    auditPayload.spec_generation_audit.file_entry_refs = [".nimi/local/spec-generation-audit/files-0001.yaml"];
    await writeFile(auditPath, YAML.stringify(auditPayload), "utf8");

    const pathResult = await runCliSubprocess(["validate-spec-audit"], { cwd: projectRoot });
    assert.equal(pathResult.exitCode, 1);
    assert.match(JSON.stringify(JSON.parse(pathResult.stdout).errors), /file_entry_ref must stay under \.nimi\/local\/state\/spec-generation\/spec-generation-audit\//);
  });
});

test("validate-spec-audit fails when a required canonical file is missing from the audit contract", async () => {
  await withTempProject(async (projectRoot) => {
    const startResult = await captureRunCli(["start"]);
    assert.equal(startResult.exitCode, 0);

    await materializeFixtureScenario(projectRoot, "mini-benchmark", "missing_audit_entry");

    const result = await runCliSubprocess(["validate-spec-audit"], { cwd: projectRoot });
    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.validator, "validate-spec-audit");
    assert.equal(payload.ok, false);
    assert.equal(payload.refusal.code, "SPEC_AUDIT_INVALID");
    assert.match(JSON.stringify(payload.errors), /missing an audit entry|non-existent canonical file/i);
  });
});

const validatorCases = [
  {
    command: "validate-spec-audit",
    valid: null,
    invalid: null,
    refusalCode: "SPEC_AUDIT_INVALID",
  },
  {
    command: "validate-spec-tree",
    valid: null,
    invalid: null,
    refusalCode: "SPEC_TREE_INVALID",
  },
  {
    command: "validate-execution-packet",
    valid: "execution-packet.valid.yaml",
    invalid: "execution-packet.invalid.yaml",
    refusalCode: "EXECUTION_PACKET_INVALID",
  },
  {
    command: "validate-orchestration-state",
    valid: "orchestration-state.valid.yaml",
    invalid: "orchestration-state.invalid.yaml",
    refusalCode: "ORCHESTRATION_STATE_INVALID",
  },
  {
    command: "validate-prompt",
    valid: "prompt.valid.md",
    invalid: "prompt.invalid.md",
    refusalCode: "PROMPT_INVALID",
  },
  {
    command: "validate-worker-output",
    valid: "worker-output.valid.md",
    invalid: "worker-output.invalid.md",
    refusalCode: "RUNNER_SIGNAL_MISSING",
  },
  {
    command: "validate-acceptance",
    valid: "acceptance.valid.md",
    invalid: "acceptance.invalid.md",
    refusalCode: "ACCEPTANCE_INVALID",
  },
];

for (const validatorCase of validatorCases) {
  test(`${validatorCase.command} returns machine-readable success and refusal payloads`, { concurrency: false }, async () => {
    if (validatorCase.command === "validate-spec-tree" || validatorCase.command === "validate-spec-audit") {
      await withTempProject(async (projectRoot) => {
        const startResult = await captureRunCli(["start"]);
        assert.equal(startResult.exitCode, 0);

        await materializeFixtureScenario(projectRoot, "mini-benchmark", "benchmark_success");

        const success = await runCliSubprocess([validatorCase.command], { cwd: projectRoot });
        assert.equal(success.exitCode, 0);
        const successPayload = JSON.parse(success.stdout);
        assert.equal(successPayload.contract, "validator-cli-result.v1");
        assert.equal(successPayload.validator, validatorCase.command);
        assert.equal(successPayload.ok, true);

        await materializeFixtureScenario(
          projectRoot,
          "mini-benchmark",
          validatorCase.command === "validate-spec-tree" ? "missing_domain_file" : "missing_audit_entry",
        );

        const failure = await runCliSubprocess([validatorCase.command], { cwd: projectRoot });
        assert.equal(failure.exitCode, 1);
        const failurePayload = JSON.parse(failure.stdout);
        assert.equal(failurePayload.contract, "validator-cli-result.v1");
        assert.equal(failurePayload.validator, validatorCase.command);
        assert.equal(failurePayload.ok, false);
        assert.equal(failurePayload.refusal.code, validatorCase.refusalCode);
        assert.ok(Array.isArray(failurePayload.errors));
        assert.ok(failurePayload.errors.length > 0);
      });
      return;
    }

    const validPath = path.join(repoRoot, "test", "fixtures", "validators", validatorCase.valid);
    const invalidPath = path.join(repoRoot, "test", "fixtures", "validators", validatorCase.invalid);

    const success = await runCliSubprocess([validatorCase.command, validPath]);
    assert.equal(success.exitCode, 0);
    const successPayload = JSON.parse(success.stdout);
    assert.equal(successPayload.contract, "validator-cli-result.v1");
    assert.equal(successPayload.validator, validatorCase.command);
    assert.equal(successPayload.ok, true);

    const failure = await runCliSubprocess([validatorCase.command, invalidPath]);
    assert.equal(failure.exitCode, 1);
    const failurePayload = JSON.parse(failure.stdout);
    assert.equal(failurePayload.contract, "validator-cli-result.v1");
    assert.equal(failurePayload.validator, validatorCase.command);
    assert.equal(failurePayload.ok, false);
    assert.equal(failurePayload.refusal.code, validatorCase.refusalCode);
    assert.ok(Array.isArray(failurePayload.errors));
    assert.ok(failurePayload.errors.length > 0);
  });
}
