import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const temporaryRoots = [];

async function temporaryProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-v3-"));
  temporaryRoots.push(root);
  return root;
}

async function runCli(projectRoot, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const ref = path.posix.join(prefix.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, ref));
    else if (entry.isFile()) files.push(ref);
  }
  return files.sort();
}

async function bootstrapProject(root) {
  const result = await runCli(root, ["start", "--yes"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function writeValidSpec(root) {
  const kernel = path.join(root, ".nimi/spec/project/kernel");
  await mkdir(path.join(kernel, "tables"), { recursive: true });
  await writeFile(path.join(root, ".nimi/spec/INDEX.md"), "# Product specification\n\nSee `project/kernel/index.md`.\n", "utf8");
  await writeFile(path.join(kernel, "index.md"), "# Project kernel\n\nCanonical project rules are defined here.\n", "utf8");
  await writeFile(path.join(kernel, "core-rules.md"), "# Core rules\n\nThe project preserves explicit authority.\n", "utf8");
  await writeFile(path.join(kernel, "tables/rule-catalog.yaml"), [
    "table_family: closed_enum",
    "owner: project",
    "enum_id: project_rules",
    "values:",
    "  - explicit_authority",
    "",
  ].join("\n"), "utf8");
}

async function writeCanonicalAuthoritySpec(root) {
  const authorityRoot = path.join(root, ".nimi/spec/project/canonical");
  await mkdir(authorityRoot, { recursive: true });
  await cp(
    path.join(packageRoot, "test/fixtures/authority/valid/yaml/session.authority.yaml"),
    path.join(authorityRoot, "session.authority.yaml"),
  );
}

async function writeValidAudit(root) {
  const canonicalFiles = [
    ".nimi/spec/INDEX.md",
    ".nimi/spec/project/kernel/index.md",
    ".nimi/spec/project/kernel/core-rules.md",
    ".nimi/spec/project/kernel/tables/rule-catalog.yaml",
  ];
  const audit = {
    version: 2,
    contract_ref: "package://@nimiplatform/nimi-coding/contracts/spec-generation-audit.schema.yaml",
    spec_generation_audit: {
      generation_mode: "class_filtered",
      canonical_target_root: ".nimi/spec",
      declared_profile: "surface_taxonomy_v2",
      input_roots: {
        code_roots: [],
        docs_roots: [".nimi/spec"],
        structure_roots: [],
        human_note_paths: [],
        benchmark_blueprint_root: null,
      },
      placement_report_ref: null,
      files: canonicalFiles.map((canonicalPath) => ({
        canonical_path: canonicalPath,
        surface_class: canonicalPath.endsWith(".yaml") ? "product_authority_table" : canonicalPath.endsWith("INDEX.md") ? "thin_guidance" : "product_authority",
        source_refs: [canonicalPath],
        source_basis: "grounded",
        coverage_status: "complete",
        unresolved_items: [],
      })),
    },
  };
  const auditPath = path.join(root, ".nimi/local/state/spec-generation/spec-generation-audit.yaml");
  await mkdir(path.dirname(auditPath), { recursive: true });
  await writeFile(auditPath, YAML.stringify(audit), "utf8");
}

async function writeSpecLayout(root, specLayout) {
  const layoutPath = path.join(root, ".nimi/config/spec-layout.yaml");
  await writeFile(layoutPath, YAML.stringify({
    version: 1,
    contract_ref: "package://@nimiplatform/nimi-coding/contracts/spec-layout.schema.yaml",
    spec_layout: specLayout,
  }), "utf8");
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("public CLI exposes the complete methodology and spec-governance surface", async () => {
  const root = await temporaryProject();
  const help = await runCli(root, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /spec construction/i);
  const commandNames = help.stdout
    .split("\n")
    .filter((line) => line.startsWith("  nimicoding "))
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((command) => !command.startsWith("--"));
  assert.deepEqual(commandNames, [
    "authority",
    "authority",
    "authority",
    "authority",
    "authority",
    "authority",
    "authority",
    "start",
    "sync",
    "clear",
    "doctor",
    "blueprint-audit",
    "validate-spec-tree",
    "validate-spec-audit",
    "classify-spec-tree",
    "generate-spec-migration-plan",
    "validate-placement",
    "validate-table-family",
    "validate-projection-edges",
    "validate-guidance-bodies",
    "validate-domain-admission",
    "validate-tracked-output-admission",
    "validate-spec-governance",
    "generate-spec-derived-docs",
    "validate-ai-governance",
  ]);
  const unknown = await runCli(root, ["not-a-command"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command/);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.3.1");
  assert.equal(packageJson.dependencies["@openai/codex-sdk"], undefined);
  assert.deepEqual(packageJson.exports, {});
  assert.deepEqual(packageJson.files, [
    "bin",
    "cli",
    "config",
    "contracts",
    "methodology",
    "spec",
    "README.md",
    "README.zh-CN.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "LICENSE",
  ]);
});

test("start projects the exact package-managed authority support surface", async () => {
  const root = await temporaryProject();
  const output = await bootstrapProject(root);
  assert.equal(output.ok, true);
  const projected = await listFiles(path.join(root, ".nimi"));
  assert.deepEqual(projected, [
    "config/spec-generation-inputs.yaml",
    "contracts/domain-admission.schema.yaml",
    "methodology/authority-authoring.yaml",
  ]);
  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  const claude = await readFile(path.join(root, "CLAUDE.md"), "utf8");
  for (const entrypoint of [agents, claude]) {
    assert.match(entrypoint, /\.nimi\/methodology\/authority-authoring\.yaml/);
    assert.match(entrypoint, /authority context/);
    assert.doesNotMatch(entrypoint, /\.nimi\/methodology\/\*\*/);
    assert.doesNotMatch(entrypoint, /\.nimi\/contracts\/\*\*/);
  }
  const managedBlocks = [
    agents.match(/<!-- nimicoding:managed:agents:start -->[\s\S]*?<!-- nimicoding:managed:agents:end -->/)[0],
    claude.match(/<!-- nimicoding:managed:claude:start -->[\s\S]*?<!-- nimicoding:managed:claude:end -->/)[0],
  ];
  assert(managedBlocks.reduce((total, block) => total + Buffer.byteLength(`${block}\n`, "utf8"), 0) <= 16 * 1024);
  const guide = await readFile(path.join(root, ".nimi/methodology/authority-authoring.yaml"), "utf8");
  assert(Buffer.byteLength(guide, "utf8") <= 32 * 1024);
});

test("sync rejects package-owned projection drift and repairs it deterministically", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  const projectedContract = path.join(root, ".nimi/methodology/authority-authoring.yaml");
  await writeFile(projectedContract, "version: broken\n", "utf8");
  assert.equal((await runCli(root, ["sync", "--check"])).code, 1);
  assert.equal((await runCli(root, ["sync", "--apply"])).code, 0);
  assert.equal((await runCli(root, ["sync", "--check"])).code, 0);
  assert.equal(await readFile(projectedContract, "utf8"), await readFile(path.join(packageRoot, "methodology/authority-authoring.yaml"), "utf8"));
});

test("exact projection registry preserves host ownership and blocks undeclared managed-surface paths", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeSpecLayout(root, {
    canonical_root: ".nimi/spec",
    host_instruction_paths: [],
    tracked_derived_projections: [],
    table_family_extensions: [],
  });
  await writeFile(path.join(root, ".nimi/config/host-overlay.yaml"), "version: 1\nhost_overlay: {}\n", "utf8");
  await writeFile(path.join(root, ".nimi/config/governance.yaml"), "profile_id: fixture\nspec_governance: {}\nai_governance: {}\n", "utf8");

  const classified = await runCli(root, ["classify-spec-tree", "--root", ".nimi", "--json"]);
  assert.equal(classified.code, 0, classified.stdout || classified.stderr);
  const byPath = new Map(JSON.parse(classified.stdout).inventory.inventory.map((entry) => [entry.source_path, entry]));
  for (const ref of [
    ".nimi/config/spec-generation-inputs.yaml",
    ".nimi/contracts/domain-admission.schema.yaml",
  ]) {
    assert.equal(byPath.get(ref).current_inferred_class, "support_registry");
    assert.equal(byPath.get(ref).owner, "product_host");
  }
  assert.equal(byPath.get(".nimi/methodology/authority-authoring.yaml").current_inferred_class, "nimicoding_managed_projection");
  assert.equal(byPath.get(".nimi/methodology/authority-authoring.yaml").owner, "nimi-coding");
  assert.equal(byPath.get(".nimi/config/host-overlay.yaml").current_inferred_class, "host_projection_anchor");
  assert.equal(byPath.get(".nimi/config/host-overlay.yaml").owner, "host_projection");
  for (const ref of [".nimi/config/spec-layout.yaml", ".nimi/config/governance.yaml"]) {
    assert.equal(byPath.get(ref).current_inferred_class, "support_registry");
    assert.equal(byPath.get(ref).owner, "product_host");
  }

  const attackRef = ".nimi/contracts/not-in-seed-allowlist.schema.yaml";
  await writeFile(path.join(root, attackRef), "version: 1\n", "utf8");
  for (const command of ["classify-spec-tree", "validate-placement"]) {
    const blocked = await runCli(root, [command, "--root", ".nimi", "--json"]);
    assert.equal(blocked.code, 1, `${command}: ${blocked.stdout || blocked.stderr}`);
    const report = JSON.parse(blocked.stdout);
    assert(report.errors.some((error) => error.includes(`unclassified_file: ${attackRef}`)));
    if (command === "classify-spec-tree") {
      const entry = report.inventory.inventory.find((item) => item.source_path === attackRef);
      assert.equal(entry.current_inferred_class, "unclassified");
      assert.equal(entry.disposition, "block");
      assert.notEqual(entry.owner, "nimi-coding");
    }
  }
  const sync = await runCli(root, ["sync", "--check", "--json"]);
  assert.equal(sync.code, 1, sync.stdout || sync.stderr);
  const syncReport = JSON.parse(sync.stdout);
  assert(syncReport.checkFailures.some((entry) => entry.outputRelativePath === attackRef && entry.status === "unexpected_unadmitted_path"));
});

test("the exact allowlist does not inherit the legacy bootstrap marker", async () => {
  const root = await temporaryProject();
  await mkdir(path.join(root, ".nimi/config"), { recursive: true });
  const legacy = path.join(root, ".nimi/config/bootstrap.yaml");
  await writeFile(legacy, "version: 1\ncontract:\n  id: legacy\n", "utf8");
  const result = await runCli(root, ["start", "--yes"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(await readFile(legacy, "utf8"), "version: 1\ncontract:\n  id: legacy\n");
  const classified = await runCli(root, ["classify-spec-tree", "--root", ".nimi", "--json"]);
  assert.equal(classified.code, 1);
  const legacyEntry = JSON.parse(classified.stdout).inventory.inventory.find((entry) => entry.source_path === ".nimi/config/bootstrap.yaml");
  assert.equal(legacyEntry.current_inferred_class, "unclassified");
  assert.equal(legacyEntry.disposition, "block");
  assert.notEqual(legacyEntry.owner, "nimi-coding");
  const sync = await runCli(root, ["sync", "--check", "--json"]);
  assert.equal(sync.code, 1);
  assert(JSON.parse(sync.stdout).checkFailures.some((entry) => entry.outputRelativePath === ".nimi/config/bootstrap.yaml" && entry.status === "unexpected_unadmitted_path"));
});

test("spec tree and generation audit validation accept a complete canonical surface", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  await writeValidAudit(root);
  const tree = await runCli(root, ["validate-spec-tree"]);
  assert.equal(tree.code, 0, tree.stdout || tree.stderr);
  assert.equal(JSON.parse(tree.stdout).ok, true);
  const audit = await runCli(root, ["validate-spec-audit"]);
  assert.equal(audit.code, 0, audit.stdout || audit.stderr);
  assert.equal(JSON.parse(audit.stdout).ok, true);
});

test("placement and spec-tree admit canonical multi-unit authority without a legacy skeleton", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeCanonicalAuthoritySpec(root);

  const authorityCheck = await runCli(root, ["authority", "check", ".nimi/spec", "--json"]);
  assert.equal(authorityCheck.code, 0, authorityCheck.stdout || authorityCheck.stderr);
  const authorityCompile = await runCli(root, ["authority", "compile", ".nimi/spec", "--json"]);
  assert.equal(authorityCompile.code, 0, authorityCompile.stdout || authorityCompile.stderr);

  const placement = await runCli(root, ["validate-placement", "--profile", "fixture", "--root", ".nimi/spec", "--json"]);
  assert.equal(placement.code, 0, placement.stdout || placement.stderr);
  const placementReport = JSON.parse(placement.stdout);
  assert.equal(placementReport.summary.by_surface_class.product_authority, 1);
  assert.equal(placementReport.summary.by_surface_class.unclassified, undefined);

  const tree = await runCli(root, ["validate-spec-tree", ".nimi/spec"]);
  assert.equal(tree.code, 0, tree.stdout || tree.stderr);
  const treeReport = JSON.parse(tree.stdout);
  assert.deepEqual(treeReport.summary.missingRequired, []);

  await rm(path.join(root, ".nimi/spec/project/canonical"), { recursive: true });
  await writeFile(path.join(root, ".nimi/spec/project/guide.md"), "# Guidance only\n", "utf8");
  const guidanceOnly = await runCli(root, ["validate-spec-tree", ".nimi/spec"]);
  assert.equal(guidanceOnly.code, 1, guidanceOnly.stdout || guidanceOnly.stderr);
  assert.match(guidanceOnly.stdout, /missing required canonical surface: product_authority/);
});

test("package-owned contract references reject stale downstream projection paths", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  await writeValidAudit(root);

  const configPath = path.join(root, ".nimi/config/spec-generation-inputs.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.contract_ref = ".nimi/contracts/spec-generation-inputs.schema.yaml";
  await writeFile(configPath, YAML.stringify(config), "utf8");
  let result = await runCli(root, ["validate-spec-tree"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /invalid spec generation inputs config/);
  await writeFile(configPath, await readFile(path.join(packageRoot, "config/spec-generation-inputs.yaml"), "utf8"), "utf8");

  const auditPath = path.join(root, ".nimi/local/state/spec-generation/spec-generation-audit.yaml");
  const audit = YAML.parse(await readFile(auditPath, "utf8"));
  audit.contract_ref = ".nimi/contracts/spec-generation-audit.schema.yaml";
  await writeFile(auditPath, YAML.stringify(audit), "utf8");
  result = await runCli(root, ["validate-spec-audit", auditPath]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /contract_ref must be package:\/\//);

  await writeSpecLayout(root, {
    canonical_root: ".nimi/spec",
    host_instruction_paths: [],
    tracked_derived_projections: [],
    table_family_extensions: [],
  });
  const layoutPath = path.join(root, ".nimi/config/spec-layout.yaml");
  const layout = YAML.parse(await readFile(layoutPath, "utf8"));
  layout.contract_ref = ".nimi/contracts/spec-layout.schema.yaml";
  await writeFile(layoutPath, YAML.stringify(layout), "utf8");
  result = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /invalid_spec_layout_config/);
});

test("generation input configuration rejects every undeclared field", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  const configPath = path.join(root, ".nimi/config/spec-generation-inputs.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.spec_generation_inputs.undeclared = [];
  await writeFile(configPath, YAML.stringify(config), "utf8");

  const tree = await runCli(root, ["validate-spec-tree"]);
  assert.equal(tree.code, 1);
  assert.match(tree.stdout, /invalid spec generation inputs config/);

  const audit = await runCli(root, ["validate-spec-audit"]);
  assert.equal(audit.code, 1);
  assert.match(audit.stdout, /invalid spec generation inputs config/);
  assert.doesNotMatch(audit.stdout, /\.nimi\/spec\/_meta/);
});

test("all retained surface validators agree on a valid canonical tree", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  for (const command of [
    "classify-spec-tree",
    "validate-placement",
    "validate-table-family",
    "validate-projection-edges",
    "validate-guidance-bodies",
    "validate-domain-admission",
    "validate-tracked-output-admission",
  ]) {
    const result = await runCli(root, [command, "--root", ".nimi/spec", "--json"]);
    assert.equal(result.code, 0, `${command}: ${result.stdout || result.stderr}`);
  }
});

test("host spec layout admits only isolated instruction and generated projection surfaces", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  const instructionPath = path.join(root, ".nimi/spec/project/AGENTS.md");
  const projectionPath = path.join(root, ".nimi/spec/project/kernel/generated/overview.md");
  await writeFile(instructionPath, "# Repository instructions\n\nRead the project kernel first.\n", "utf8");
  await mkdir(path.dirname(projectionPath), { recursive: true });
  await writeFile(projectionPath, "<!-- generated:project-summary -->\n# Project summary\n", "utf8");
  await writeSpecLayout(root, {
    canonical_root: ".nimi/spec",
    host_instruction_paths: [".nimi/spec/project/AGENTS.md"],
    tracked_derived_projections: [{
      projection_id: "project-summary",
      root: ".nimi/spec/project/kernel/generated",
      source_roots: [
        ".nimi/spec/project/kernel/core-rules.md",
        ".nimi/spec/project/kernel/tables/rule-catalog.yaml",
      ],
      generate_command: "node tools/generate-project-summary.mjs",
      drift_check_command: "node tools/generate-project-summary.mjs --check",
      required_marker: "<!-- generated:project-summary -->",
    }],
    table_family_extensions: [],
  });

  const valid = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(valid.code, 0, valid.stdout || valid.stderr);

  await writeFile(projectionPath, "# Marker removed\n", "utf8");
  const missingMarker = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(missingMarker.code, 1);
  assert.match(missingMarker.stdout, /tracked_derived_projection_missing_generated_marker/);

  const layoutPath = path.join(root, ".nimi/config/spec-layout.yaml");
  const layout = YAML.parse(await readFile(layoutPath, "utf8"));
  layout.spec_layout.undeclared = true;
  await writeFile(layoutPath, YAML.stringify(layout), "utf8");
  const undeclared = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(undeclared.code, 1);
  assert.match(undeclared.stdout, /invalid_spec_layout_fields/);

  await writeSpecLayout(root, {
    canonical_root: ".nimi/spec",
    host_instruction_paths: [".nimi/spec/project/kernel/core-rules.md"],
    tracked_derived_projections: [{
      projection_id: "project-summary",
      root: ".nimi/spec/project/kernel",
      source_roots: [".nimi/spec/project/kernel/core-rules.md"],
      generate_command: "node tools/generate-project-summary.mjs",
      drift_check_command: "node tools/generate-project-summary.mjs --check",
      required_marker: "<!-- generated:project-summary -->",
    }],
    table_family_extensions: [],
  });
  const authorityOverlap = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(authorityOverlap.code, 1);
  assert.match(authorityOverlap.stdout, /invalid_host_instruction_path/);
  assert.match(authorityOverlap.stdout, /invalid_or_duplicate_projection_root/);
});

test("host table-family extensions cannot weaken package contracts", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  const tablePath = path.join(root, ".nimi/spec/project/kernel/tables/relationships.yaml");
  await writeFile(tablePath, YAML.stringify({
    table_family: "relationship_catalog",
    owner: "project",
    catalog_id: "project_relationships",
    entries: [],
  }), "utf8");
  const extension = {
    table_family: "relationship_catalog",
    authority_class: "product_authority_table",
    required_fields: ["table_family", "owner", "catalog_id", "entries"],
    forbidden_fields: ["runtime_status"],
  };
  await writeSpecLayout(root, {
    canonical_root: ".nimi/spec",
    host_instruction_paths: [],
    tracked_derived_projections: [],
    table_family_extensions: [extension],
  });

  const valid = await runCli(root, ["validate-table-family", "--root", ".nimi/spec", "--json"]);
  assert.equal(valid.code, 0, valid.stdout || valid.stderr);

  const table = YAML.parse(await readFile(tablePath, "utf8"));
  table.runtime_status = "current";
  await writeFile(tablePath, YAML.stringify(table), "utf8");
  const forbidden = await runCli(root, ["validate-table-family", "--root", ".nimi/spec", "--json"]);
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.stdout, /table_contains_family_forbidden_field/);

  extension.table_family = "closed_enum";
  await writeSpecLayout(root, {
    canonical_root: ".nimi/spec",
    host_instruction_paths: [],
    tracked_derived_projections: [],
    table_family_extensions: [extension],
  });
  const shadowed = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(shadowed.code, 1);
  assert.match(shadowed.stdout, /table_family_extension_shadows_package_family/);
});

test("blueprint audit verifies structure and rule identity without mutating canonical spec", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  await cp(path.join(root, ".nimi/spec"), path.join(root, "blueprint"), { recursive: true });
  const audit = await runCli(root, [
    "blueprint-audit",
    "--blueprint-root", "blueprint",
    "--canonical-root", ".nimi/spec",
    "--write-local",
    "--json",
  ]);
  assert.equal(audit.code, 0, audit.stdout || audit.stderr);
  const payload = JSON.parse(audit.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.contractVersion, "nimicoding.blueprint-audit.v2");
  assert.equal(payload.semanticMappingGaps.ruleIdPreservation.missingRuleIds.length, 0);
  await assert.doesNotReject(readFile(path.join(root, ".nimi/local/state/spec-generation/blueprint-equivalence-audit.json"), "utf8"));
});

test("repository governance profile dispatch remains deterministic", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeFile(path.join(root, "AGENTS.md"), [
    "# AGENTS.md",
    "",
    "## Scope",
    "",
    "Fixture repository.",
    "",
    "## Hard Boundaries",
    "",
    "Authority remains explicit.",
    "",
    "## Retrieval Defaults",
    "",
    "Read contracts first.",
    "",
    "## Verification Commands",
    "",
    "Run deterministic checks.",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "package.json"), '{"name":"governance-fixture","scripts":{}}\n', "utf8");
  await writeFile(path.join(root, ".nimi/config/governance.yaml"), [
    "profile_id: fixture",
    "spec_governance:",
    "  validate_commands:",
    "    contract: ['node --version']",
    "  generate_commands:",
    "    docs: ['node --version']",
    "ai_governance:",
    "  agents_freshness:",
    "    targets:",
    "      - rel: AGENTS.md",
    "        max_lines: 40",
    "    required_sections: ['## Scope', '## Hard Boundaries', '## Retrieval Defaults', '## Verification Commands']",
    "    stale_tokens: []",
    "",
  ].join("\n"), "utf8");
  const validated = await runCli(root, ["validate-spec-governance", "--profile", "fixture", "--scope", "contract"]);
  assert.equal(validated.code, 0, validated.stdout || validated.stderr);
  const generated = await runCli(root, ["generate-spec-derived-docs", "--profile", "fixture", "--scope", "docs"]);
  assert.equal(generated.code, 0, generated.stdout || generated.stderr);
  assert.match(generated.stdout, /^v\d+/);
  const ai = await runCli(root, ["validate-ai-governance", "--profile", "fixture", "--scope", "agents-freshness", "--json"]);
  assert.equal(ai.code, 0, ai.stdout || ai.stderr);
  assert.equal(JSON.parse(ai.stdout).ok, true);
});

test("repository governance all scope is gated by the canonical spec tree", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  await writeFile(path.join(root, ".nimi/config/governance.yaml"), [
    "profile_id: fixture",
    "spec_governance:",
    "  canonical_root: .nimi/spec",
    "  validate_commands:",
    "    contract: ['node --version']",
    "ai_governance: {}",
    "",
  ].join("\n"), "utf8");

  const valid = await runCli(root, ["validate-spec-governance", "--profile", "fixture", "--scope", "all"]);
  assert.equal(valid.code, 0, valid.stdout || valid.stderr);

  const generated = path.join(root, ".nimi/spec/project/kernel/generated/overview.md");
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(generated, "# Unadmitted generated view\n", "utf8");
  const invalid = await runCli(root, ["validate-spec-governance", "--profile", "fixture", "--scope", "all"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /derived_view_under_product_authority_root/);

  const governancePath = path.join(root, ".nimi/config/governance.yaml");
  const governance = YAML.parse(await readFile(governancePath, "utf8"));
  governance.spec_governance.canonical_root = "../outside";
  await writeFile(governancePath, YAML.stringify(governance), "utf8");
  const escapedRoot = await runCli(root, ["validate-spec-governance", "--profile", "fixture", "--scope", "all"]);
  assert.equal(escapedRoot.code, 2);
  assert.match(escapedRoot.stderr, /canonical_root must be \.nimi\/spec/);
});

test("spec placement fails closed for generated content under product authority", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  const generated = path.join(root, ".nimi/spec/project/kernel/generated/overview.md");
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(generated, "# Generated\n", "utf8");
  const result = await runCli(root, ["validate-placement", "--root", ".nimi/spec", "--json"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /derived_view_under_product_authority_root/);
});

test("host spec layout admits a reproducible tracked projection without promoting it to authority", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  await writeFile(path.join(root, ".nimi/config/spec-layout.yaml"), [
    "version: 1",
    "contract_ref: package://@nimiplatform/nimi-coding/contracts/spec-layout.schema.yaml",
    "spec_layout:",
    "  canonical_root: .nimi/spec",
    "  host_instruction_paths: []",
    "  tracked_derived_projections:",
    "    - projection_id: project-kernel-docs",
    "      root: .nimi/spec/project/kernel/generated",
    "      source_roots: [.nimi/spec/project/kernel/tables]",
    "      generate_command: pnpm generate:project-spec",
    "      drift_check_command: pnpm check:project-spec-drift",
    "      required_marker: '<!-- DO NOT EDIT:'",
    "  table_family_extensions: []",
    "",
  ].join("\n"), "utf8");
  const generated = path.join(root, ".nimi/spec/project/kernel/generated/overview.md");
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(generated, "<!-- DO NOT EDIT: generated by project spec builder -->\n\n# Generated\n", "utf8");
  const result = await runCli(root, ["validate-spec-tree"]);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("doctor checks package integration without replacing project-specific spec validation", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  const generated = path.join(root, ".nimi/spec/project/kernel/generated/overview.md");
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(generated, "# Project-generated view\n", "utf8");
  const doctor = await runCli(root, ["doctor", "--json"]);
  assert.equal(doctor.code, 0, doctor.stdout || doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.spec.present, true);
  assert.equal(report.spec.ok, null);
  assert.match(report.checks.find((entry) => entry.id === "spec_tree").detail, /project-specific validators/);
});

test("migration planning is descriptive and non-mutating", async () => {
  const root = await temporaryProject();
  await bootstrapProject(root);
  await writeValidSpec(root);
  const result = await runCli(root, ["generate-spec-migration-plan", "--root", ".nimi/spec", "--json"]);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.contract, "nimicoding.spec-migration-plan.v2");
  assert(Array.isArray(plan.migration_groups));
  assert.equal(plan.mutation_policy.mutates_source_tree, false);
});
