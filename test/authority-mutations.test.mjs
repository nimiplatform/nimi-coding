import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

import { compileAuthorityPath } from "../cli/lib/authority/compile.mjs";
import { parseAuthorityPath } from "../cli/lib/authority/format.mjs";
import { buildSourceMap } from "../cli/lib/authority/source-map.mjs";
import { validAuthorityText } from "../cli/lib/authority/validate.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixtureRoot = path.join(packageRoot, "test", "fixtures", "authority");
const manifest = YAML.parse(await readFile(path.join(fixtureRoot, "mutations.yaml"), "utf8"));
const temporaryRoots = [];

async function tempCorpus(profile = "yaml") {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-mutation-"));
  temporaryRoots.push(root);
  const corpus = path.join(root, "authority");
  await cp(path.join(fixtureRoot, "valid", profile), corpus, { recursive: true });
  return { root, corpus, profile };
}

async function runCli(root, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function diagnostic(root, operation, target, expectedCode, pointer = null) {
  const result = await runCli(root, ["authority", operation, target, "--json"]);
  assert.equal(result.code, 1, `${operation}: ${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  const found = payload.diagnostics.find((entry) => entry.code === expectedCode && (pointer === null
    || entry.pointer === pointer
    || entry.pointer.endsWith(pointer)
    || (/^\/relations\/0\/(?:type|target)$/.test(pointer) && entry.pointer.includes("/relations/") && entry.pointer.endsWith(pointer.slice(pointer.lastIndexOf("/"))))));
  assert(found, `${expectedCode} ${pointer ?? ""}: ${result.stdout}`);
  return found;
}

async function replace(file, before, after) {
  const text = await readFile(file, "utf8");
  const indent = (value) => value.split("\n").map((line) => line.length > 0 ? `    ${line}` : line).join("\n");
  const nestedBefore = indent(before);
  if (file.endsWith(".yaml") && text.includes(nestedBefore)) {
    await writeFile(file, text.replace(nestedBefore, indent(after)), "utf8");
    return;
  }
  assert(text.includes(before), `${path.basename(file)} does not contain mutation source`);
  await writeFile(file, text.replace(before, after), "utf8");
}

function paths(corpus, profile = "yaml") {
  const yaml = path.join(corpus, "session.authority.yaml");
  if (profile === "yaml") return {
    rule: yaml,
    definition: yaml,
    removedDefinition: yaml,
    removedRule: yaml,
    oldestRule: yaml,
  };
  return {
    rule: path.join(corpus, "checkout-session.authority.md"),
    definition: path.join(corpus, "session.authority.md"),
    removedDefinition: path.join(corpus, "session-v0.authority.md"),
    removedRule: path.join(corpus, "checkout-session-v0.authority.md"),
    oldestRule: path.join(corpus, "checkout-session-v00.authority.md"),
  };
}

async function addRemovedRule(corpus, id, target = null) {
  const relations = target ? `    relations:\n      - type: supersedes\n        target: ${target}` : "    relations: []";
  await writeFile(path.join(corpus, `${id.split(".").at(-1)}.authority.yaml`), [
    "format: nimicoding.authority/v1",
    "units:",
    `  - id: ${id}`,
    "    kind: rule",
    "    owner: team.checkout",
    "    lifecycle: removed",
    `    title: ${id}`,
    "    reason: Isolated mutation unit.",
    relations,
    "",
  ].join("\n"), "utf8");
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("the unified semantic-text predicate admits scalars and rejects every defined line break", () => {
  assert.equal(validAuthorityText("A valid supplementary scalar: 😀"), true);
  assert.equal(validAuthorityText("\uD800"), false);
  for (const lineBreak of ["\u000A", "\u000B", "\u000C", "\u000D", "\u0085", "\u2028", "\u2029"]) {
    assert.equal(validAuthorityText(`before${lineBreak}after`), false, lineBreak.codePointAt(0).toString(16));
  }
});

test("YAML-escaped invalid Unicode text preserves fmt boundaries and fails check/compile for every semantic text field", async (t) => {
  assert.equal(manifest.unicode_text_regressions.length, 8);
  const fieldTargets = {
    title: ["definition", "title: Session"],
    meaning: ["definition", "meaning: A server-issued identity context presented with a protected request."],
    statement: ["rule", "statement: A checkout request carries a valid session."],
    condition: ["rule", "condition: Always."],
    failure: ["rule", "failure: Reject the request before creating an order."],
    reason: ["removedDefinition", "reason: Replaced by definition.session."],
  };

  for (const mutation of manifest.unicode_text_regressions) {
    await t.test(mutation.id, async () => {
      const state = await tempCorpus("yaml");
      const file = paths(state.corpus);
      const [targetKey, originalLine] = fieldTargets[mutation.field];
      await replace(file[targetKey], originalLine, `${mutation.field}: "${mutation.yaml_escape}"`);

      const formatted = await runCli(state.root, ["authority", "fmt", file[targetKey], "--json"]);
      assert.equal(formatted.code, 0, formatted.stderr || formatted.stdout);
      assert.equal(JSON.parse(formatted.stdout).semantic_status, "not_evaluated");
      assert.equal((await runCli(state.root, ["authority", "fmt", file[targetKey], "--check", "--json"])).code, 0);

      for (const operation of ["check", "compile"]) {
        const found = await diagnostic(state.root, operation, state.corpus, "AUTH_FIELD_INVALID", `/${mutation.field}`);
        assert.match(found.reason, /one non-empty trimmed text line/);
      }
    });
  }
});

test("the admitted 41-case mutation table executes every formatter/compiler branch", async (t) => {
  assert.equal(manifest.cases.length, 41);
  assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, 41);

  for (const mutation of manifest.cases) {
    await t.test(mutation.id, async () => {
      const state = await tempCorpus("yaml");
      const file = paths(state.corpus);
      const ruleText = await readFile(file.rule, "utf8");
      const definitionText = await readFile(file.definition, "utf8");

      switch (mutation.id) {
        case "wrong_format":
          await replace(file.definition, "format: nimicoding.authority/v1", "format: nimicoding.authority/v0");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_INVALID", "/format");
          break;
        case "missing_format":
          await replace(file.definition, "format: nimicoding.authority/v1\n", "");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_REQUIRED", "/format");
          break;
        case "missing_id": {
          const document = YAML.parse(await readFile(file.definition, "utf8"));
          delete document.units.find((unit) => unit.id === "definition.session").id;
          await writeFile(file.definition, YAML.stringify(document, { indent: 2, lineWidth: 0 }), "utf8");
          assert.equal((await runCli(state.root, ["authority", "fmt", file.definition, "--check", "--json"])).code, 0);
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/id");
          break;
        }
        case "unknown_kind":
          await replace(file.definition, "kind: definition", "kind: concept");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_INVALID", "/kind");
          break;
        case "missing_kind":
          await replace(file.definition, "kind: definition\n", "");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_REQUIRED", "/kind");
          break;
        case "invalid_owner":
          await replace(file.definition, "owner: team.identity", "owner: Team Identity");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_INVALID", "/owner");
          break;
        case "unknown_lifecycle":
          await replace(file.definition, "lifecycle: active", "lifecycle: draft");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_INVALID", "/lifecycle");
          break;
        case "missing_lifecycle":
          await replace(file.definition, "lifecycle: active\n", "");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_REQUIRED", "/lifecycle");
          break;
        case "missing_title":
          await replace(file.definition, "title: Session\n", "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/title");
          break;
        case "missing_meaning":
          await replace(file.definition, "meaning: A server-issued identity context presented with a protected request.\n", "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/meaning");
          break;
        case "missing_modality":
          await replace(file.rule, "modality: must\n", "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/modality");
          break;
        case "empty_scope":
          await replace(file.rule, "scope:\n  - api.checkout", "scope: []");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_INVALID", "/scope");
          break;
        case "missing_statement":
        case "missing_condition":
        case "missing_failure": {
          const field = mutation.id.replace("missing_", "");
          const line = ruleText.split("\n").find((entry) => entry.trimStart().startsWith(`${field}:`)).trimStart();
          await replace(file.rule, `${line}\n`, "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", `/${field}`);
          break;
        }
        case "missing_reason":
          await replace(file.removedDefinition, "reason: Replaced by definition.session.\n", "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/reason");
          break;
        case "missing_relations":
          await replace(file.definition, "relations:\n  - type: supersedes\n    target: definition.session-v0\n", "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/relations");
          break;
        case "missing_relation_type":
          await replace(file.definition, "  - type: supersedes\n", "  - ");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_REQUIRED", "/relations/0/type");
          break;
        case "missing_relation_target":
          await replace(file.definition, "    target: definition.session-v0\n", "");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_FIELD_REQUIRED", "/relations/0/target");
          break;
        case "unknown_relation_type":
          await replace(file.definition, "type: supersedes", "type: resembles");
          assert.equal((await runCli(state.root, ["authority", "fmt", file.definition, "--check", "--json"])).code, 0);
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_UNKNOWN");
          break;
        case "dangling_relation_target":
          await replace(file.rule, "target: definition.session", "target: definition.unknown");
          await diagnostic(state.root, "compile", state.corpus, "AUTH_RELATION_DANGLING");
          break;
        case "duplicate_yaml_key":
          await replace(file.definition, "owner: team.identity", "owner: team.identity\nowner: team.checkout");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_DUPLICATE_KEY");
          break;
        case "duplicate_markdown_frontmatter_key": {
          const markdown = await tempCorpus("markdown");
          const target = paths(markdown.corpus, "markdown").definition;
          await replace(target, "owner: team.identity", "owner: team.identity\nowner: team.checkout");
          await diagnostic(markdown.root, "fmt", target, "AUTH_DUPLICATE_KEY");
          break;
        }
        case "ambiguous_markdown_heading": {
          const markdown = await tempCorpus("markdown");
          const target = paths(markdown.corpus, "markdown").rule;
          await writeFile(target, `${await readFile(target, "utf8")}\n## Failure\n\nDuplicate failure.\n`, "utf8");
          await diagnostic(markdown.root, "fmt", target, "AUTH_MARKDOWN_AMBIGUOUS");
          break;
        }
        case "unknown_field":
          await replace(file.definition, "owner: team.identity", "owner: team.identity\ndefault_owner: team.fallback");
          await diagnostic(state.root, "fmt", file.definition, "AUTH_UNKNOWN_FIELD");
          break;
        case "forbidden_branch_field":
          await replace(file.definition, "meaning: A server-issued identity context presented with a protected request.", "meaning: A server-issued identity context presented with a protected request.\nmodality: must");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_FORBIDDEN", "/modality");
          break;
        case "duplicate_identity":
          await writeFile(path.join(state.corpus, "session-copy.authority.yaml"), definitionText, "utf8");
          await diagnostic(state.root, "check", state.corpus, "AUTH_ID_DUPLICATE");
          break;
        case "owner_conflict":
          await writeFile(path.join(state.corpus, "session-copy.authority.yaml"), definitionText.replace("owner: team.identity", "owner: team.checkout"), "utf8");
          await diagnostic(state.root, "check", state.corpus, "AUTH_OWNER_CONFLICT");
          break;
        case "removed_identity_reuse":
          await writeFile(path.join(state.corpus, "reuse.authority.yaml"), ruleText.replace("id: rule.checkout-session", "id: rule.checkout-session-v00"), "utf8");
          await diagnostic(state.root, "check", state.corpus, "AUTH_ID_DUPLICATE");
          break;
        case "relation_kind_mismatch":
          await replace(file.rule, "target: definition.session", "target: definition.session-v0");
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_TYPE");
          break;
        case "relation_outgoing_cardinality":
          await addRemovedRule(state.corpus, "rule.unused-old");
          await replace(file.rule, "    target: rule.checkout-session-v0", "    target: rule.checkout-session-v0\n  - type: supersedes\n    target: rule.unused-old");
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_CARDINALITY");
          break;
        case "zero_applies_to":
          await replace(file.rule, "  - type: applies_to\n    target: definition.session\n", "");
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_CARDINALITY");
          break;
        case "self_relation":
          await replace(file.removedRule, "target: rule.checkout-session-v00", "target: rule.checkout-session-v0");
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_CYCLE");
          break;
        case "duplicate_relation":
          await replace(file.rule, "  - type: applies_to\n    target: definition.session", "  - type: applies_to\n    target: definition.session\n  - type: applies_to\n    target: definition.session");
          assert.equal((await runCli(state.root, ["authority", "fmt", file.rule, "--check", "--json"])).code, 0);
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_CARDINALITY");
          break;
        case "relation_incoming_cardinality":
          await writeFile(path.join(state.corpus, "alternate.authority.yaml"), definitionText.replace("id: definition.session", "id: definition.session-alternate"), "utf8");
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_CARDINALITY");
          break;
        case "supersedes_cycle":
          await addRemovedRule(state.corpus, "rule.cycle-a", "rule.cycle-b");
          await addRemovedRule(state.corpus, "rule.cycle-b", "rule.cycle-a");
          await diagnostic(state.root, "check", state.corpus, "AUTH_RELATION_CYCLE");
          break;
        case "noncanonical_yaml_flow":
          await replace(file.rule, "scope:\n  - api.checkout", "scope: [api.checkout]");
          await diagnostic(state.root, "check", state.corpus, "AUTH_FORMAT_DRIFT");
          assert.equal((await runCli(state.root, ["authority", "fmt", file.rule, "--json"])).code, 0);
          break;
        case "noncanonical_markdown_order": {
          const markdown = await tempCorpus("markdown");
          const target = paths(markdown.corpus, "markdown").rule;
          const source = await readFile(target, "utf8");
          const condition = "## Condition\n\nAlways.\n\n";
          const failure = "## Failure\n\nReject the request before creating an order.\n";
          await writeFile(target, source.replace(`${condition}${failure}`, `${failure}\n${condition.trimEnd()}\n`), "utf8");
          await diagnostic(markdown.root, "check", markdown.corpus, "AUTH_FORMAT_DRIFT");
          assert.equal((await runCli(markdown.root, ["authority", "fmt", target, "--json"])).code, 0);
          assert.equal((await runCli(markdown.root, ["authority", "fmt", target, "--check", "--json"])).code, 0);
          break;
        }
        case "fmt_incomplete_exit":
          await replace(file.rule, "failure: Reject the request before creating an order.\n", "");
          assert.equal((await runCli(state.root, ["authority", "fmt", file.rule, "--check", "--json"])).code, 0);
          await diagnostic(state.root, "check", state.corpus, "AUTH_FIELD_REQUIRED", "/failure");
          break;
        case "fmt_directory_refusal": {
          const result = await runCli(state.root, ["authority", "fmt", state.corpus]);
          assert.equal(result.code, 2);
          break;
        }
        case "source_map_gap": {
          const compiled = await compileAuthorityPath(state.corpus);
          assert.equal(compiled.ok, true);
          const parsed = await parseAuthorityPath(state.corpus);
          parsed.sources.find((source) => source.data.id === "definition.session").locations.delete("/title");
          const mapped = buildSourceMap(parsed.sources, compiled.ir);
          assert.equal(mapped.ok, false);
          assert(mapped.diagnostics.some((entry) => entry.code === "AUTH_SOURCE_MAP_MISSING"));
          break;
        }
        default:
          assert.fail(`unimplemented mutation: ${mutation.id}`);
      }
    });
  }
});
