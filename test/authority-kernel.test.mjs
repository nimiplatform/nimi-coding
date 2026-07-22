import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

import { compileAuthorityPath } from "../cli/lib/authority/compile.mjs";
import { parseAuthorityPath } from "../cli/lib/authority/format.mjs";
import { collectIrLeaves } from "../cli/lib/authority/source-map.mjs";
import { stringifyCanonicalYaml } from "../cli/lib/authority/source-yaml.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixtures = path.join(packageRoot, "test", "fixtures", "authority");
const temporaryRoots = [];

async function temporaryProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-authority-"));
  temporaryRoots.push(root);
  return root;
}

async function runExecutable(executable, args, cwd) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function runCli(cwd, args) {
  return runExecutable(process.execPath, [cliPath, ...args], cwd);
}

async function copyCorpus(root, profile = "yaml", directory = "authority") {
  const target = path.join(root, directory);
  await cp(path.join(fixtures, "valid", profile), target, { recursive: true });
  return target;
}

async function mutateYamlUnit(file, id, mutate) {
  const document = YAML.parse(await readFile(file, "utf8"));
  const unit = document.units.find((entry) => entry.id === id);
  assert(unit, id);
  mutate(unit, document);
  await writeFile(file, stringifyCanonicalYaml(document, { container: true }), "utf8");
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const ref = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, ref));
    else if (entry.isFile()) files.push(ref);
  }
  return files.sort();
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("canonical YAML serialization requires an explicit container or frontmatter profile", () => {
  assert.throws(() => stringifyCanonicalYaml({ format: "nimicoding.authority/v1", units: [] }), /exactly one explicit profile/);
  assert.throws(() => stringifyCanonicalYaml({}, { container: true, frontmatter: true }), /exactly one explicit profile/);
});

test("canonical YAML and Markdown lower to the same private IR with complete SourceMaps", async () => {
  const yamlPath = path.join(fixtures, "valid", "yaml");
  const markdownPath = path.join(fixtures, "valid", "markdown");
  const yaml = await compileAuthorityPath(yamlPath);
  const markdown = await compileAuthorityPath(markdownPath);
  assert.equal(yaml.ok, true, JSON.stringify(yaml.diagnostics));
  assert.equal(markdown.ok, true, JSON.stringify(markdown.diagnostics));
  assert.deepEqual(yaml.ir, markdown.ir);
  assert.equal(yaml.fileCount, 1);
  assert.equal(yaml.unitCount, 6);
  assert.equal(yaml.ir.units.length, 6);
  assert.equal(yaml.ir.units.find((unit) => unit.id === "rule.checkout-no-anonymous").semantic.modality, "must_not");
  for (const result of [yaml, markdown]) {
    const expectedLeaves = [...collectIrLeaves(result.ir)].sort();
    const mappedLeaves = Object.keys(result.sourceMap.fields).sort();
    assert.deepEqual(mappedLeaves, expectedLeaves);
    assert(!mappedLeaves.some((pointer) => pointer.endsWith("/format") || pointer === "/format"));
    for (const pointer of mappedLeaves) {
      assert(pointer.startsWith("/units/"));
      const mapped = result.sourceMap.fields[pointer];
      assert(mapped.file);
      assert(mapped.sourcePointer.startsWith("/"));
      assert(mapped.range.start.line >= 1);
      assert(mapped.range.end.line >= mapped.range.start.line);
    }
  }
  assert.equal(yaml.sourceMap.fields["/units/0/id"].sourcePointer, "/units/1/id");
  assert.equal(yaml.sourceMap.fields["/units/3/id"].sourcePointer, "/units/0/id");
  assert.deepEqual((await compileAuthorityPath(yamlPath)).ir, yaml.ir);
});

test("fmt is idempotent, keeps semantic status unevaluated, and never invents missing failure", async () => {
  const root = await temporaryProject();
  const file = path.join(root, "draft.authority.yaml");
  await writeFile(file, [
    "format: nimicoding.authority/v1",
    "units:",
    "  - id: rule.draft",
    "    kind: rule",
    "    owner: team.checkout",
    "    lifecycle: active",
    "    title: Draft rule",
    "    modality: must",
    "    scope: [api.checkout]",
    "    statement: A checkout request carries a session.",
    "    condition: Always.",
    "    relations:",
    "      - target: definition.session",
    "        type: applies_to",
    "",
  ].join("\n"), "utf8");
  const first = await runCli(root, ["authority", "fmt", file, "--json"]);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.semantic_status, "not_evaluated");
  assert.equal(report.changed, true);
  const formatted = await readFile(file, "utf8");
  assert.doesNotMatch(formatted, /failure:/);
  assert.match(formatted, /scope:\n      - api\.checkout/);
  const second = await runCli(root, ["authority", "fmt", file, "--check", "--json"]);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(JSON.parse(second.stdout).changed, false);
  const checked = await runCli(root, ["authority", "check", file, "--json"]);
  assert.equal(checked.code, 1);
  const missingFailure = JSON.parse(checked.stdout).diagnostics.find((entry) => entry.pointer === "/units/0/failure");
  assert(missingFailure);
  assert.equal(missingFailure.code, "AUTH_FIELD_REQUIRED");

  const markdownDraft = path.join(root, "missing-title.authority.md");
  const markdown = await readFile(path.join(fixtures, "valid", "markdown", "session.authority.md"), "utf8");
  await writeFile(markdownDraft, markdown.replace("# Session\n\n", ""), "utf8");
  const markdownFmt = await runCli(root, ["authority", "fmt", markdownDraft, "--json"]);
  assert.equal(markdownFmt.code, 0, markdownFmt.stderr || markdownFmt.stdout);
  assert.equal(JSON.parse(markdownFmt.stdout).semantic_status, "not_evaluated");
  assert.equal((await runCli(root, ["authority", "fmt", markdownDraft, "--check", "--json"])).code, 0);
  const markdownCheck = await runCli(root, ["authority", "check", markdownDraft, "--json"]);
  assert.equal(markdownCheck.code, 1);
  const missingTitle = JSON.parse(markdownCheck.stdout).diagnostics.find((entry) => entry.pointer === "/title");
  assert.equal(missingTitle.code, "AUTH_FIELD_REQUIRED");
  assert.deepEqual(missingTitle.range, {
    start: { line: 11, column: 1 },
    end: { line: 11, column: 1 },
  });
});

test("strict syntax and complete relation item structure fail before formatting", async () => {
  const root = await temporaryProject();
  for (const fixture of ["duplicate-key.authority.yaml", "duplicate-frontmatter.authority.md"]) {
    const source = path.join(fixtures, "invalid", fixture);
    const target = path.join(root, fixture);
    await cp(source, target);
    for (const operation of ["fmt", "check", "compile"]) {
      const result = await runCli(root, ["authority", operation, target, "--json"]);
      assert.equal(result.code, 1, `${operation}: ${result.stderr || result.stdout}`);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "AUTH_DUPLICATE_KEY");
    }
  }
  for (const [fixture, code] of [
    ["ambiguous-heading.authority.md", "AUTH_MARKDOWN_AMBIGUOUS"],
    ["alias.authority.yaml", "AUTH_SYNTAX_UNSUPPORTED"],
  ]) {
    const target = path.join(root, fixture);
    await cp(path.join(fixtures, "invalid", fixture), target);
    const result = await runCli(root, ["authority", "fmt", target, "--json"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, code);
  }
  const yamlBaseline = await readFile(path.join(fixtures, "valid", "yaml", "session.authority.yaml"));
  const invalidUtf8 = path.join(root, "invalid-utf8.authority.yaml");
  await writeFile(invalidUtf8, Buffer.concat([yamlBaseline, Buffer.from([0xc3, 0x28])]));
  for (const operation of ["fmt", "check", "compile"]) {
    const result = await runCli(root, ["authority", operation, invalidUtf8, "--json"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /not valid UTF-8/);
  }
  const trailingComment = path.join(root, "trailing-comment.authority.yaml");
  await writeFile(trailingComment, `${yamlBaseline.toString("utf8")}# forbidden trailing comment\n`, "utf8");
  for (const operation of ["fmt", "check", "compile"]) {
    const result = await runCli(root, ["authority", operation, trailingComment, "--json"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "AUTH_SYNTAX_UNSUPPORTED");
  }
  const markdownBaseline = await readFile(path.join(fixtures, "valid", "markdown", "session.authority.md"), "utf8");
  for (const forbidden of ["1. ordered item", "> blockquote", "---", "~~~", "[label]: target", "`inline code`"]) {
    const target = path.join(root, `forbidden-${Buffer.from(forbidden).toString("hex")}.authority.md`);
    await writeFile(target, markdownBaseline.replace(
      "A server-issued identity context presented with a protected request.",
      forbidden,
    ), "utf8");
    const result = await runCli(root, ["authority", "check", target, "--json"]);
    assert.equal(result.code, 1, forbidden);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "AUTH_MARKDOWN_AMBIGUOUS");
  }
  const incomplete = path.join(root, "incomplete.authority.yaml");
  await writeFile(incomplete, [
    "format: nimicoding.authority/v1",
    "units:",
    "  - id: definition.incomplete",
    "    kind: definition",
    "    owner: team.identity",
    "    lifecycle: active",
    "    title: Incomplete relation",
    "    meaning: A relation item without a type.",
    "    relations:",
    "      - target: definition.other",
    "",
  ].join("\n"), "utf8");
  for (const operation of ["fmt", "check", "compile"]) {
    const result = await runCli(root, ["authority", operation, incomplete, "--json"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].pointer, "/units/0/relations/0/type");
  }
  const legacyShape = path.join(fixtures, "invalid", "legacy-single-unit.authority.yaml");
  for (const operation of ["fmt", "check", "compile"]) {
    const rejected = await runCli(root, ["authority", operation, legacyShape, "--json"]);
    assert.equal(rejected.code, 1);
    const report = JSON.parse(rejected.stdout);
    assert(report.diagnostics.some((entry) => entry.pointer === "/units" && entry.code === "AUTH_FIELD_REQUIRED"));
    assert(report.diagnostics.some((entry) => entry.pointer === "/id" && entry.code === "AUTH_UNKNOWN_FIELD"));
  }
  assert.equal((await runCli(root, ["authority", "fmt", root])).code, 2);
});

test("semantic relation and identity mutations fail closed with stable codes", async () => {
  const root = await temporaryProject();
  const corpus = await copyCorpus(root);
  const rulePath = path.join(corpus, "session.authority.yaml");
  const original = await readFile(rulePath, "utf8");

  await writeFile(rulePath, original.replace("definition.session", "definition.unknown"), "utf8");
  let result = await runCli(root, ["authority", "compile", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics.map((entry) => entry.code), ["AUTH_RELATION_DANGLING"]);

  await mutateYamlUnit(rulePath, "rule.checkout-session", (unit) => { unit.relations = []; });
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "AUTH_RELATION_CARDINALITY");

  await writeFile(rulePath, original, "utf8");
  await mutateYamlUnit(rulePath, "rule.checkout-session", (unit) => { unit.relations.push({ type: "applies_to", target: "definition.session" }); });
  assert.equal((await runCli(root, ["authority", "fmt", rulePath, "--check", "--json"])).code, 0);
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "AUTH_RELATION_CARDINALITY");

  const definitionPath = path.join(corpus, "session.authority.yaml");
  const definition = await readFile(definitionPath, "utf8");
  await writeFile(rulePath, original, "utf8");
  await writeFile(definitionPath, definition.replace("type: supersedes", "type: resembles"), "utf8");
  assert.equal((await runCli(root, ["authority", "fmt", definitionPath, "--check", "--json"])).code, 0);
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.code === "AUTH_RELATION_UNKNOWN"));

  await writeFile(definitionPath, definition, "utf8");
  await writeFile(rulePath, original, "utf8");
  await cp(path.join(corpus, "session.authority.yaml"), path.join(corpus, "session-copy.authority.yaml"));
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  const duplicate = JSON.parse(result.stdout).diagnostics.find((entry) => entry.code === "AUTH_ID_DUPLICATE");
  assert(duplicate);
  assert.equal(duplicate.related.length, 1);
});

test("semantic envelope, lifecycle, owner, typed-reference, and lineage mutations are located and rejected", async () => {
  const root = await temporaryProject();
  const corpus = await copyCorpus(root);
  const rulePath = path.join(corpus, "session.authority.yaml");
  const definitionPath = rulePath;
  const removedPath = rulePath;
  const rule = await readFile(rulePath, "utf8");
  const definition = await readFile(definitionPath, "utf8");
  const removed = await readFile(removedPath, "utf8");

  const fieldMutations = [
    ["rule.checkout-session", "id"],
    ["rule.checkout-session", "owner"],
    ["rule.checkout-session", "title"],
    ["rule.checkout-session", "modality"],
    ["rule.checkout-session", "scope"],
    ["rule.checkout-session", "statement"],
    ["rule.checkout-session", "condition"],
    ["rule.checkout-session", "failure"],
    ["rule.checkout-session", "relations"],
    ["definition.session", "meaning"],
    ["definition.session-v0", "reason"],
  ];
  for (const [id, field] of fieldMutations) {
    await mutateYamlUnit(rulePath, id, (unit) => { delete unit[field]; });
    const result = await runCli(root, ["authority", "check", corpus, "--json"]);
    const pointer = `/${field}`;
    assert.equal(result.code, 1, pointer);
    const diagnostic = JSON.parse(result.stdout).diagnostics.find((entry) => entry.pointer.endsWith(pointer) && entry.code === "AUTH_FIELD_REQUIRED");
    assert(diagnostic, `${pointer}: ${result.stdout}`);
    if (pointer === "/id") assert.equal(diagnostic.pointer, "/units/0/id");
    assert(diagnostic.range.start.line >= 3);
    await writeFile(rulePath, rule, "utf8");
  }

  for (const [find, replacement, pointer] of [
    ["format: nimicoding.authority/v1", "format: nimicoding.authority/v0", "/format"],
    ["kind: rule", "kind: concept", "/kind"],
    ["lifecycle: active", "lifecycle: draft", "/lifecycle"],
  ]) {
    await writeFile(rulePath, rule.replace(find, replacement), "utf8");
    const result = await runCli(root, ["authority", "fmt", rulePath, "--check", "--json"]);
    assert.equal(result.code, 1);
    assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.pointer === pointer || entry.pointer.endsWith(pointer)));
  }
  await writeFile(rulePath, rule.replace("id: rule.checkout-session", "id: rule.checkout-session-"), "utf8");
  let result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.pointer === "/units/0/id" && entry.code === "AUTH_FIELD_INVALID"));

  await writeFile(rulePath, rule.replace("    owner: team.checkout\n", "    owner: team.checkout\n    default_owner: team.fallback\n"), "utf8");
  result = await runCli(root, ["authority", "fmt", rulePath, "--check", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "AUTH_UNKNOWN_FIELD");
  await writeFile(rulePath, rule, "utf8");
  await mutateYamlUnit(definitionPath, "definition.session", (unit) => { unit.modality = "must"; });
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.code === "AUTH_FIELD_FORBIDDEN"));
  await writeFile(definitionPath, definition, "utf8");

  await writeFile(rulePath, rule.replace("target: definition.session", "target: definition.session-v0"), "utf8");
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.code === "AUTH_RELATION_TYPE"));
  await writeFile(rulePath, rule, "utf8");

  await writeFile(path.join(corpus, "cycle-a.authority.yaml"), [
    "format: nimicoding.authority/v1", "units:", "  - id: rule.cycle-a", "    kind: rule", "    owner: team.checkout", "    lifecycle: removed",
    "    title: Cycle A", "    reason: Isolated cycle mutation.", "    relations:", "      - type: supersedes", "        target: rule.cycle-b", "",
  ].join("\n"), "utf8");
  await writeFile(path.join(corpus, "cycle-b.authority.yaml"), [
    "format: nimicoding.authority/v1", "units:", "  - id: rule.cycle-b", "    kind: rule", "    owner: team.checkout", "    lifecycle: removed",
    "    title: Cycle B", "    reason: Isolated cycle mutation.", "    relations:", "      - type: supersedes", "        target: rule.cycle-a", "",
  ].join("\n"), "utf8");
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  const cycleDiagnostics = JSON.parse(result.stdout).diagnostics;
  assert(cycleDiagnostics.some((entry) => entry.code === "AUTH_RELATION_CYCLE"));
  assert(!cycleDiagnostics.some((entry) => entry.code === "AUTH_RELATION_CARDINALITY"));
  await rm(path.join(corpus, "cycle-a.authority.yaml"));
  await rm(path.join(corpus, "cycle-b.authority.yaml"));

  const alternateDefinition = path.join(corpus, "session-alternate.authority.yaml");
  await writeFile(alternateDefinition, [
    "format: nimicoding.authority/v1", "units:", "  - id: definition.session-alternate", "    kind: definition", "    owner: team.identity", "    lifecycle: active",
    "    title: Alternate session", "    meaning: An alternate definition for cardinality mutation.", "    relations:", "      - type: supersedes", "        target: definition.session-v0", "",
  ].join("\n"), "utf8");
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.code === "AUTH_RELATION_CARDINALITY" && /incoming/.test(entry.reason)));
  await rm(alternateDefinition);

  const unusedOldRule = path.join(corpus, "unused-old.authority.yaml");
  await writeFile(unusedOldRule, [
    "format: nimicoding.authority/v1", "units:", "  - id: rule.unused-old", "    kind: rule", "    owner: team.checkout", "    lifecycle: removed",
    "    title: Unused old rule", "    reason: Cardinality mutation target.", "    relations: []", "",
  ].join("\n"), "utf8");
  await writeFile(rulePath, rule, "utf8");
  await mutateYamlUnit(rulePath, "rule.checkout-session", (unit) => { unit.relations.push({ type: "supersedes", target: "rule.unused-old" }); });
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  assert(JSON.parse(result.stdout).diagnostics.some((entry) => entry.code === "AUTH_RELATION_CARDINALITY" && /at most one supersedes/.test(entry.reason)));
  await rm(unusedOldRule);
  await writeFile(rulePath, rule, "utf8");

  await writeFile(path.join(corpus, "session-copy.authority.yaml"), definition.replace("owner: team.identity", "owner: team.checkout"), "utf8");
  result = await runCli(root, ["authority", "check", corpus, "--json"]);
  assert.equal(result.code, 1);
  const conflict = JSON.parse(result.stdout).diagnostics.find((entry) => entry.code === "AUTH_OWNER_CONFLICT");
  assert(conflict);
  assert.equal(conflict.related.length, 1);
});

test("multi-unit YAML fails atomically for same-file/cross-file identity conflicts and one invalid unit", async () => {
  const root = await temporaryProject();
  const corpus = await copyCorpus(root);
  const file = path.join(corpus, "session.authority.yaml");
  const baselineText = await readFile(file, "utf8");
  const baseline = YAML.parse(baselineText);

  const sameFile = structuredClone(baseline);
  sameFile.units.push(structuredClone(sameFile.units[0]));
  await writeFile(file, stringifyCanonicalYaml(sameFile, { container: true }), "utf8");
  let result = await compileAuthorityPath(corpus);
  assert.equal(result.ok, false);
  assert.equal(result.ir, null);
  assert.equal(result.sourceMap, null);
  const duplicate = result.diagnostics.find((entry) => entry.code === "AUTH_ID_DUPLICATE");
  assert.equal(duplicate.pointer, "/units/0/id");
  assert.equal(duplicate.related[0].pointer, "/units/6/id");

  await writeFile(file, baselineText, "utf8");
  await writeFile(path.join(corpus, "duplicate.authority.yaml"), stringifyCanonicalYaml({
    format: baseline.format,
    units: [structuredClone(baseline.units[1])],
  }, { container: true }), "utf8");
  result = await compileAuthorityPath(corpus);
  assert.equal(result.ok, false);
  const crossFileDuplicate = result.diagnostics.find((entry) => entry.code === "AUTH_ID_DUPLICATE");
  assert.equal(crossFileDuplicate.path.endsWith("duplicate.authority.yaml"), true);
  assert.equal(crossFileDuplicate.pointer, "/units/0/id");
  assert.equal(crossFileDuplicate.related[0].path.endsWith("session.authority.yaml"), true);
  assert.equal(crossFileDuplicate.related[0].pointer, "/units/1/id");
  await rm(path.join(corpus, "duplicate.authority.yaml"));

  const invalid = structuredClone(baseline);
  delete invalid.units[2].failure;
  await writeFile(file, stringifyCanonicalYaml(invalid, { container: true }), "utf8");
  result = await compileAuthorityPath(corpus);
  assert.equal(result.ok, false);
  assert.equal(result.unitCount, 0);
  assert.equal(result.ir, null);
  assert.equal(result.sourceMap, null);
  const missing = result.diagnostics.find((entry) => entry.pointer === "/units/2/failure");
  assert.equal(missing.code, "AUTH_FIELD_REQUIRED");
  const parsed = await parseAuthorityPath(corpus);
  const unitRange = parsed.documents[0].locations.get("/units/2");
  assert(missing.range.start.line >= unitRange.start.line && missing.range.start.line <= unitRange.end.line);

  const structurallyInvalid = baselineText.replace("    owner: team.checkout\n", "    owner: team.checkout\n    default_owner: team.fallback\n");
  await writeFile(file, structurallyInvalid, "utf8");
  const beforeFmt = await readFile(file, "utf8");
  const formatted = await runCli(root, ["authority", "fmt", file, "--json"]);
  assert.equal(formatted.code, 1);
  assert.equal(await readFile(file, "utf8"), beforeFmt);
});

test("the bounded authoring exercise uses the current projected guide rather than internal contracts", async () => {
  const root = await temporaryProject();
  assert.equal((await runCli(root, ["start", "--yes"])).code, 0);
  const guidePath = path.join(root, ".nimi", "methodology", "authority-authoring.yaml");
  const guideText = await readFile(guidePath, "utf8");
  assert.match(guideText, /invalid_utf8/);
  assert.match(guideText, /active_definition_sections: \[Meaning\]/);
  assert.match(guideText, /active_rule_sections: \[Statement, Condition, Failure\]/);
  assert.match(guideText, /line separator U\+2028, and paragraph separator U\+2029/);
  assert.match(guideText, /authority context <path> <id> --max-units/);
  assert.match(guideText, /missing fields point to their containing mapping or section's canonical insertion point/);
  assert.doesNotMatch(guideText, /\.nimi\/contracts\/\*\*/);

  const task = YAML.parse(await readFile(path.join(fixtures, "exercise", "task.yaml"), "utf8"));
  assert.deepEqual(task.allowed_inputs, ["projected_authority_guide", "task_authority", "diagnostics"]);
  const exerciseCorpus = path.join(root, "authority-exercise");
  await cp(path.join(fixtures, "exercise", "output"), exerciseCorpus, { recursive: true });
  assert.equal((await runCli(root, ["authority", "check", exerciseCorpus, "--json"])).code, 0);
  assert.equal((await runCli(root, ["authority", "compile", exerciseCorpus, "--json"])).code, 0);
  const exerciseDiagnostic = JSON.parse(await readFile(path.join(fixtures, "exercise", "diagnostics.json"), "utf8"));
  assert.match(exerciseDiagnostic.repair, /task authority/);
  assert.doesNotMatch(exerciseDiagnostic.repair, /Reject the request/);
});

test("packed package runs the full chain and projections cannot alter compiler semantics", async () => {
  const root = await temporaryProject();
  const packDir = path.join(root, "pack");
  const consumer = path.join(root, "consumer");
  await mkdir(packDir, { recursive: true });
  await mkdir(consumer, { recursive: true });
  const packed = await runExecutable("npm", ["pack", "--pack-destination", packDir], packageRoot);
  assert.equal(packed.code, 0, packed.stderr || packed.stdout);
  const tarballName = packed.stdout.trim().split("\n").at(-1);
  const tarball = path.join(packDir, tarballName);
  await writeFile(path.join(consumer, "package.json"), '{"name":"authority-consumer","private":true}\n', "utf8");
  const installed = await runExecutable("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  assert.equal(installed.code, 0, installed.stderr || installed.stdout);
  const bin = path.join(consumer, "node_modules", ".bin", "nimicoding");

  const invalidLarge = path.join(consumer, "invalid-large.authority.yaml");
  await writeFile(invalidLarge, [
    "format: nimicoding.authority/v1",
    "units:",
    "  - id: definition.large-invalid",
    "    kind: definition",
    "    owner: team.large",
    "    lifecycle: active",
    "    title: Large invalid authority",
    "    meaning: Invalid only because undeclared fields follow.",
    "    relations: []",
    ...Array.from({ length: 500 }, (_, index) => `    unknown-${index}: value-${index}`),
    "",
  ].join("\n"), "utf8");
  const largeCompile = await runExecutable(bin, ["authority", "compile", invalidLarge, "--json"], consumer);
  assert.equal(largeCompile.code, 1);
  assert(Buffer.byteLength(largeCompile.stdout, "utf8") > 65536);
  assert.equal(JSON.parse(largeCompile.stdout).diagnostics.filter((item) => item.code === "AUTH_UNKNOWN_FIELD").length, 500);

  const largeBefore = path.join(consumer, "large-before");
  const largeAfter = path.join(consumer, "large-after");
  await mkdir(largeBefore);
  await mkdir(largeAfter);
  const largeUnit = (meaning) => [
    "format: nimicoding.authority/v1",
    "units:",
    "  - id: definition.large",
    "    kind: definition",
    "    owner: team.large",
    "    lifecycle: active",
    "    title: Large definition",
    `    meaning: ${meaning}`,
    "    relations: []",
    "",
  ].join("\n");
  await writeFile(path.join(largeBefore, "large.authority.yaml"), largeUnit("😀界".repeat(15000)), "utf8");
  await writeFile(path.join(largeAfter, "large.authority.yaml"), largeUnit("界😀".repeat(15000)), "utf8");
  for (const operation of ["query", "context"]) {
    const args = operation === "query"
      ? ["authority", operation, largeBefore, "definition.large", "--max-bytes", "500000", "--json"]
      : ["authority", operation, largeBefore, "definition.large", "--max-units", "1", "--max-bytes", "500000", "--json"];
    const output = await runExecutable(bin, args, consumer);
    assert.equal(output.code, 0, output.stderr);
    assert(Buffer.byteLength(output.stdout, "utf8") > 65536);
    assert.equal(JSON.parse(output.stdout).packet.units[0].id, "definition.large");
  }
  const largeDiff = await runExecutable(bin, ["authority", "diff", largeBefore, largeAfter, "--max-bytes", "500000", "--json"], consumer);
  assert.equal(largeDiff.code, 0, largeDiff.stderr);
  assert(Buffer.byteLength(largeDiff.stdout, "utf8") > 65536);
  const largeDiffReport = JSON.parse(largeDiff.stdout);
  assert.equal(largeDiffReport.diff.summary.changes, 1);
  const largeDiffJson = JSON.stringify(largeDiffReport.diff);
  const largeDiffBytes = Buffer.byteLength(largeDiffJson, "utf8");
  assert.notEqual(largeDiffBytes, largeDiffJson.length);
  assert.equal(largeDiffReport.payload_bytes, largeDiffBytes);
  assert.equal((await runExecutable(bin, ["authority", "diff", largeBefore, largeAfter, "--max-bytes", String(largeDiffBytes), "--json"], consumer)).code, 0);
  const largeDiffOverflow = await runExecutable(bin, ["authority", "diff", largeBefore, largeAfter, "--max-bytes", String(largeDiffBytes - 1), "--json"], consumer);
  assert.equal(largeDiffOverflow.code, 1);
  assert.equal(JSON.parse(largeDiffOverflow.stdout).diff, null);
  assert.equal(JSON.parse(largeDiffOverflow.stdout).diagnostics[0].code, "AUTH_DIFF_BUDGET");
  const largeDispositions = path.join(consumer, "large-dispositions.yaml");
  await writeFile(largeDispositions, "format: nimicoding.authority-impact-dispositions/v1\nrules: []\n", "utf8");
  const largeImpact = await runExecutable(bin, ["authority", "impact", largeBefore, largeAfter, "--dispositions", largeDispositions, "--max-bytes", "500000", "--json"], consumer);
  assert.equal(largeImpact.code, 0, largeImpact.stderr);
  assert(Buffer.byteLength(largeImpact.stdout, "utf8") > 65536);
  const largeImpactReport = JSON.parse(largeImpact.stdout);
  assert.equal(largeImpactReport.impact.complete, true);
  const largeImpactJson = JSON.stringify({ diff: largeImpactReport.diff, impact: largeImpactReport.impact });
  const largeImpactBytes = Buffer.byteLength(largeImpactJson, "utf8");
  assert.notEqual(largeImpactBytes, largeImpactJson.length);
  assert.equal(largeImpactReport.payload_bytes, largeImpactBytes);
  assert.equal((await runExecutable(bin, ["authority", "impact", largeBefore, largeAfter, "--dispositions", largeDispositions, "--max-bytes", String(largeImpactBytes), "--json"], consumer)).code, 0);
  const largeImpactOverflow = await runExecutable(bin, ["authority", "impact", largeBefore, largeAfter, "--dispositions", largeDispositions, "--max-bytes", String(largeImpactBytes - 1), "--json"], consumer);
  assert.equal(largeImpactOverflow.code, 1);
  const largeImpactOverflowReport = JSON.parse(largeImpactOverflow.stdout);
  assert.equal(largeImpactOverflowReport.diff, null);
  assert.equal(largeImpactOverflowReport.impact, null);
  assert.equal(largeImpactOverflowReport.diagnostics[0].code, "AUTH_IMPACT_BUDGET");

  const privateImport = await runExecutable(process.execPath, [
    "--input-type=module",
    "--eval",
    "await import('@nimiplatform/nimi-coding/cli/lib/authority/compile.mjs')",
  ], consumer);
  assert.notEqual(privateImport.code, 0);
  assert.match(privateImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  const corpus = await copyCorpus(consumer);
  const markdownCorpus = await copyCorpus(consumer, "markdown", "authority-markdown");

  assert.equal((await runExecutable(bin, ["authority", "fmt", path.join(corpus, "session.authority.yaml"), "--check"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "check", corpus, "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "compile", corpus, "--json"], consumer)).code, 0);
  const packedQuery = await runExecutable(bin, ["authority", "query", corpus, "rule.checkout-session", "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedQuery.code, 0);
  assert.deepEqual(JSON.parse(packedQuery.stdout).packet.units.map((unit) => unit.id), ["rule.checkout-session"]);
  const packedContext = await runExecutable(bin, ["authority", "context", corpus, "rule.checkout-session", "--max-units", "5", "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedContext.code, 0);
  assert.equal(JSON.parse(packedContext.stdout).packet.units.length, 5);
  const packedOverflow = await runExecutable(bin, ["authority", "context", corpus, "rule.checkout-session", "--max-units", "4", "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedOverflow.code, 1);
  assert.equal(JSON.parse(packedOverflow.stdout).packet, null);
  const packedUnknown = await runExecutable(bin, ["authority", "query", corpus, "rule.unknown", "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedUnknown.code, 1);
  assert.equal(JSON.parse(packedUnknown.stdout).diagnostics[0].code, "AUTH_QUERY_NOT_FOUND");
  const packedByteOverflow = await runExecutable(bin, ["authority", "query", corpus, "rule.checkout-session", "--max-bytes", "1", "--json"], consumer);
  assert.equal(packedByteOverflow.code, 1);
  assert.equal(JSON.parse(packedByteOverflow.stdout).diagnostics[0].code, "AUTH_CONTEXT_BUDGET");

  const impactAfter = await copyCorpus(consumer, "yaml", "authority-impact-after");
  const impactRule = path.join(impactAfter, "session.authority.yaml");
  await writeFile(impactRule, (await readFile(impactRule, "utf8")).replace("condition: Always.", "condition: For authenticated checkout."), "utf8");
  const packedDiff = await runExecutable(bin, ["authority", "diff", corpus, impactAfter, "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedDiff.code, 0);
  assert.equal(JSON.parse(packedDiff.stdout).diff.summary.changes, 1);
  assert.equal((await runExecutable(bin, ["start", "--yes"], consumer)).code, 0);
  await writeFile(path.join(consumer, ".nimi/config/host-overlay.yaml"), "version: 1\nhost_overlay: {}\n", "utf8");
  await writeFile(path.join(consumer, ".nimi/config/spec-layout.yaml"), [
    "version: 1",
    "contract_ref: package://@nimiplatform/nimi-coding/contracts/spec-layout.schema.yaml",
    "spec_layout:",
    "  canonical_root: .nimi/spec",
    "  host_instruction_paths: []",
    "  tracked_derived_projections: []",
    "  table_family_extensions: []",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(consumer, ".nimi/config/governance.yaml"), "profile_id: fixture\nspec_governance: {}\nai_governance: {}\n", "utf8");
  const packedProjectionClassification = await runExecutable(bin, ["classify-spec-tree", "--root", ".nimi", "--json"], consumer);
  assert.equal(packedProjectionClassification.code, 0, packedProjectionClassification.stdout || packedProjectionClassification.stderr);
  const packedProjectionEntries = new Map(JSON.parse(packedProjectionClassification.stdout).inventory.inventory.map((entry) => [entry.source_path, entry]));
  assert.equal(packedProjectionEntries.get(".nimi/methodology/authority-authoring.yaml").owner, "nimi-coding");
  for (const ref of [".nimi/config/spec-generation-inputs.yaml", ".nimi/contracts/domain-admission.schema.yaml", ".nimi/config/spec-layout.yaml", ".nimi/config/governance.yaml"]) {
    assert.equal(packedProjectionEntries.get(ref).owner, "product_host");
  }
  assert.equal(packedProjectionEntries.get(".nimi/config/host-overlay.yaml").owner, "host_projection");
  const packedAttackRef = ".nimi/contracts/not-in-seed-allowlist.schema.yaml";
  await writeFile(path.join(consumer, packedAttackRef), "version: 1\n", "utf8");
  for (const command of ["classify-spec-tree", "validate-placement"]) {
    const blocked = await runExecutable(bin, [command, "--root", ".nimi", "--json"], consumer);
    assert.equal(blocked.code, 1, `${command}: ${blocked.stdout || blocked.stderr}`);
    assert.match(blocked.stdout, /unclassified_file/);
    if (command === "classify-spec-tree") {
      const attack = JSON.parse(blocked.stdout).inventory.inventory.find((entry) => entry.source_path === packedAttackRef);
      assert.equal(attack.current_inferred_class, "unclassified");
      assert.equal(attack.disposition, "block");
      assert.notEqual(attack.owner, "nimi-coding");
    }
  }
  const packedAttackSync = await runExecutable(bin, ["sync", "--check", "--json"], consumer);
  assert.equal(packedAttackSync.code, 1, packedAttackSync.stdout || packedAttackSync.stderr);
  assert(JSON.parse(packedAttackSync.stdout).checkFailures.some((entry) => entry.outputRelativePath === packedAttackRef && entry.status === "unexpected_unadmitted_path"));
  await rm(path.join(consumer, packedAttackRef));
  const guide = path.join(consumer, ".nimi", "methodology", "authority-authoring.yaml");
  const projectedGuide = YAML.parse(await readFile(guide, "utf8"));
  const missingDispositions = path.join(consumer, "missing-impact-dispositions.yaml");
  await writeFile(missingDispositions, projectedGuide.disposition_authoring.empty_skeleton, "utf8");
  const packedUndisposed = await runExecutable(bin, ["authority", "impact", corpus, impactAfter, "--dispositions", missingDispositions, "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedUndisposed.code, 1);
  const discovered = JSON.parse(packedUndisposed.stdout);
  assert.equal(discovered.diagnostics[0].code, "AUTH_IMPACT_UNDISPOSED");
  assert.deepEqual(discovered.impact.obligations.map(({ type, target }) => [type, target]), [["consumer", "api.checkout"], ["test", "rule.checkout-session"]]);
  const packedDispositions = path.join(consumer, "impact-dispositions.yaml");
  await writeFile(packedDispositions, projectedGuide.disposition_authoring.complete_example, "utf8");
  const packedImpact = await runExecutable(bin, ["authority", "impact", corpus, impactAfter, "--dispositions", packedDispositions, "--max-bytes", "65536", "--json"], consumer);
  assert.equal(packedImpact.code, 0);
  assert.equal(JSON.parse(packedImpact.stdout).impact.complete, true);

  const markdownRule = path.join(markdownCorpus, "checkout-session.authority.md");
  const markdownSource = await readFile(markdownRule, "utf8");
  const condition = "## Condition\n\nAlways.\n\n";
  const failure = "## Failure\n\nReject the request before creating an order.\n";
  await writeFile(markdownRule, markdownSource.replace(`${condition}${failure}`, `${failure}\n${condition.trimEnd()}\n`), "utf8");
  assert.equal((await runExecutable(bin, ["authority", "fmt", markdownRule, "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "fmt", markdownRule, "--check", "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "check", markdownCorpus, "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "compile", markdownCorpus, "--json"], consumer)).code, 0);
  assert.deepEqual(await listFiles(path.join(consumer, ".nimi")), [
    "config/governance.yaml",
    "config/host-overlay.yaml",
    "config/spec-generation-inputs.yaml",
    "config/spec-layout.yaml",
    "contracts/domain-admission.schema.yaml",
    "methodology/authority-authoring.yaml",
  ]);
  assert.match(await readFile(path.join(consumer, ".nimi/config/spec-generation-inputs.yaml"), "utf8"), /contract_ref: package:\/\//);
  assert.match(await readFile(path.join(consumer, ".nimi/contracts/domain-admission.schema.yaml"), "utf8"), /shared_enum_ref: package:\/\//);
  assert.equal((await runExecutable(bin, ["sync", "--check", "--json"], consumer)).code, 0);
  await writeFile(guide, "version: tampered\n", "utf8");
  assert.equal((await runExecutable(bin, ["authority", "compile", corpus, "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "context", corpus, "rule.checkout-session", "--max-units", "5", "--max-bytes", "65536", "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["authority", "impact", corpus, impactAfter, "--dispositions", packedDispositions, "--max-bytes", "65536", "--json"], consumer)).code, 0);
  assert.equal((await runExecutable(bin, ["sync", "--check", "--json"], consumer)).code, 1);

  const packedInvalid = path.join(consumer, "duplicate-key.authority.yaml");
  await cp(path.join(fixtures, "invalid", "duplicate-key.authority.yaml"), packedInvalid);
  for (const operation of ["fmt", "check", "compile"]) {
    const rejected = await runExecutable(bin, ["authority", operation, packedInvalid, "--json"], consumer);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stdout, /AUTH_DUPLICATE_KEY/);
  }

  const unicodeCorpus = await copyCorpus(consumer, "yaml", "authority-unicode");
  const unicodeDefinition = path.join(unicodeCorpus, "session.authority.yaml");
  await writeFile(unicodeDefinition, (await readFile(unicodeDefinition, "utf8")).replace("title: Session", "title: \"\\uD800\""), "utf8");
  const unicodeFmt = await runExecutable(bin, ["authority", "fmt", unicodeDefinition, "--json"], consumer);
  assert.equal(unicodeFmt.code, 0);
  assert.equal(JSON.parse(unicodeFmt.stdout).semantic_status, "not_evaluated");
  assert.equal((await runExecutable(bin, ["authority", "fmt", unicodeDefinition, "--check", "--json"], consumer)).code, 0);
  for (const operation of ["check", "compile"]) {
    const rejected = await runExecutable(bin, ["authority", operation, unicodeCorpus, "--json"], consumer);
    assert.equal(rejected.code, 1);
    const diagnostic = JSON.parse(rejected.stdout).diagnostics.find((entry) => entry.pointer.endsWith("/title"));
    assert.equal(diagnostic.code, "AUTH_FIELD_INVALID");
  }

  const rule = path.join(corpus, "session.authority.yaml");
  await writeFile(rule, (await readFile(rule, "utf8")).replace("    failure: Reject the request before creating an order.\n", ""), "utf8");
  assert.equal((await runExecutable(bin, ["authority", "fmt", rule, "--check", "--json"], consumer)).code, 0);
  const invalidCheck = await runExecutable(bin, ["authority", "check", corpus, "--json"], consumer);
  const invalidCompile = await runExecutable(bin, ["authority", "compile", corpus, "--json"], consumer);
  assert.equal(invalidCheck.code, 1);
  assert.equal(invalidCompile.code, 1);
  assert.match(invalidCheck.stdout, /AUTH_FIELD_REQUIRED/);
  assert.match(invalidCompile.stdout, /AUTH_FIELD_REQUIRED/);
});
