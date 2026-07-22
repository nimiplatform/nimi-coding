import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AGENTS_BEGIN, AGENTS_END, CLAUDE_BEGIN, CLAUDE_END } from "../cli/constants.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const validFixture = path.join(packageRoot, "test/fixtures/authority/valid/yaml/session.authority.yaml");
const temporaryRoots = [];

async function temporaryProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-single-plane-"));
  temporaryRoots.push(root);
  return root;
}

async function runCli(projectRoot, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function exists(ref) {
  try { return await lstat(ref); } catch { return null; }
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

async function bootstrap(root) {
  const result = await runCli(root, ["start", "--yes"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function writeValidAuthority(root) {
  const target = path.join(root, ".nimi/spec/product/canonical.authority.yaml");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(validFixture, target);
  return target;
}

const managedCommands = [
  ["start", "--yes"],
  ["sync", "--check", "--json"],
  ["sync", "--apply", "--json"],
  ["clear", "--yes"],
  ["doctor", "--json"],
];

async function assertManagedCommandsRefuse(root, sentinels) {
  const expected = new Map();
  for (const sentinel of sentinels) expected.set(sentinel, await readFile(sentinel));
  for (const args of managedCommands) {
    const result = await runCli(root, args);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout || result.stderr}`);
    assert.match(result.stderr, /refused|拒绝/);
    for (const [sentinel, bytes] of expected) assert.deepEqual(await readFile(sentinel), bytes, `${args.join(" ")}: ${sentinel}`);
  }
}

async function managedBytes(root) {
  const refs = [".nimi/methodology/authority-authoring.yaml", "AGENTS.md", "CLAUDE.md", ".gitignore"];
  return new Map(await Promise.all(refs.map(async (ref) => [ref, await readFile(path.join(root, ref))])));
}

async function assertManagedBytes(root, expected, label) {
  for (const [ref, bytes] of expected) assert.deepEqual(await readFile(path.join(root, ref)), bytes, `${label}: ${ref}`);
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("public CLI exposes one authority plane and removed commands are unavailable", async () => {
  const root = await temporaryProject();
  const help = await runCli(root, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /optional L3 repository governance/);
  assert.doesNotMatch(help.stdout, /spec reconstruction|profile-specific validation/i);

  const retained = help.stdout
    .split("\n")
    .filter((line) => line.startsWith("  nimicoding "))
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((command) => !command.startsWith("--"));
  assert.deepEqual(retained, [
    "authority", "authority", "authority", "authority", "authority", "authority", "authority",
    "start", "sync", "clear", "doctor", "validate-ai-governance",
  ]);

  const removed = [
    "blueprint-audit",
    "classify-spec-tree",
    "generate-spec-migration-plan",
    "validate-spec-tree",
    "validate-spec-audit",
    "validate-placement",
    "validate-table-family",
    "validate-projection-edges",
    "validate-guidance-bodies",
    "validate-domain-admission",
    "validate-tracked-output-admission",
    "validate-spec-governance",
    "generate-spec-derived-docs",
  ];
  for (const command of removed) {
    const result = await runCli(root, [command]);
    assert.equal(result.code, 2, command);
    assert.match(result.stderr, new RegExp(`Unknown command: ${command}`));
    assert.doesNotMatch(result.stdout, /"ok"\s*:\s*true/);
  }
});

test("fresh start installs only the compact guide, managed instructions, and ignored local root", async () => {
  const root = await temporaryProject();
  const report = await bootstrap(root);
  assert.deepEqual(report.next, [
    "Author project-owned canonical authority under .nimi/spec using only *.authority.yaml or *.authority.md.",
    "Run nimicoding authority fmt on each changed authority file.",
    "Run nimicoding authority check .nimi/spec on the complete canonical root.",
  ]);
  assert.deepEqual(await listFiles(path.join(root, ".nimi")), ["methodology/authority-authoring.yaml"]);
  assert((await exists(path.join(root, ".nimi/local")))?.isDirectory());
  assert.equal(await exists(path.join(root, ".nimi/cache")), null);
  assert.equal(await exists(path.join(root, ".nimi/config")), null);
  assert.equal(await exists(path.join(root, ".nimi/contracts")), null);
  assert.equal(await exists(path.join(root, ".nimi/spec")), null);
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^\.nimi\/local\/$/m);

  for (const ref of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(path.join(root, ref), "utf8");
    assert.match(text, /complete declared outgoing interpretation closure/);
    assert.match(text, /does not prove implementation, consumers, or tests are synchronized/);
    assert.match(text, /historical document formats are unsupported/);
    assert.doesNotMatch(text, /`\/\.nimi\//);
    assert.match(text, /`\.nimi\/spec\/\*\*`/);
  }
  const guide = await readFile(path.join(root, ".nimi/methodology/authority-authoring.yaml"), "utf8");
  assert(Buffer.byteLength(guide, "utf8") < 32 * 1024);
  assert.match(guide, /not complete task context/);
  assert.match(guide, /does not prove implementation, consumers, or tests are synchronized/);
});

test("documented canonical gate rejects invalid authority and every non-canonical spec entry", async () => {
  const root = await temporaryProject();
  await bootstrap(root);
  const spec = path.join(root, ".nimi/spec");
  await mkdir(spec, { recursive: true });
  const bad = path.join(spec, "bad.authority.yaml");
  await writeFile(bad, [
    "format: nimicoding.authority/v1",
    "units:",
    "  - id: rule.bad",
    "    kind: rule",
    "    owner: team.bad",
    "    lifecycle: active",
    "    title: Bad",
    "    modality: must",
    "    scope: [api.bad]",
    "    statement: Bad input is rejected.",
    "    condition: Always.",
    "    relations: []",
    "",
  ].join("\n"), "utf8");
  assert.equal((await runCli(root, ["authority", "fmt", bad, "--json"])).code, 0);
  let result = await runCli(root, ["authority", "check", ".nimi/spec", "--json"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /AUTH_FIELD_REQUIRED|AUTH_RELATION_CARDINALITY/);

  await rm(bad);
  await cp(validFixture, path.join(spec, "valid.authority.yaml"));
  await writeFile(path.join(spec, "README.md"), "# Legacy kernel\n", "utf8");
  result = await runCli(root, ["authority", "check", ".nimi/spec", "--json"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unsupported file/);

  await rm(path.join(spec, "README.md"));
  await symlink(path.join(spec, "valid.authority.yaml"), path.join(spec, "alias.authority.yaml"));
  result = await runCli(root, ["authority", "check", ".nimi/spec"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /refuses symbolic link/);
  assert.match(await readFile(path.join(packageRoot, "README.md"), "utf8"), /sole \.nimi\/spec conformance gate/);
});

test("sync validates exact owned surfaces, ignores unrelated host files, and diagnoses exact deprecated paths", async () => {
  const root = await temporaryProject();
  await bootstrap(root);
  assert.equal((await runCli(root, ["sync", "--check", "--json"])).code, 0);

  await mkdir(path.join(root, ".nimi/config"), { recursive: true });
  await mkdir(path.join(root, ".nimi/contracts"), { recursive: true });
  await writeFile(path.join(root, ".nimi/config/project.yaml"), "project: true\n", "utf8");
  await writeFile(path.join(root, ".nimi/contracts/project.schema.yaml"), "version: 1\n", "utf8");
  await writeFile(path.join(root, ".nimi/methodology/project-notes.md"), "# Project notes\n", "utf8");
  assert.equal((await runCli(root, ["sync", "--check", "--json"])).code, 0);

  const deprecated = path.join(root, ".nimi/config/spec-generation-inputs.yaml");
  await writeFile(deprecated, "host: preserved\n", "utf8");
  const failed = await runCli(root, ["sync", "--check", "--json"]);
  assert.equal(failed.code, 1);
  const report = JSON.parse(failed.stdout);
  const diagnostic = report.checkFailures.find((entry) => entry.outputRelativePath === ".nimi/config/spec-generation-inputs.yaml");
  assert.equal(diagnostic.status, "deprecated_projection_path");
  assert.match(diagnostic.detail, /does not delete host files/);
  assert.equal(await readFile(deprecated, "utf8"), "host: preserved\n");

  await rm(deprecated);
  const guide = path.join(root, ".nimi/methodology/authority-authoring.yaml");
  await writeFile(guide, "version: drifted\n", "utf8");
  assert.equal((await runCli(root, ["sync", "--check"])).code, 1);
  assert.equal((await runCli(root, ["sync", "--apply"])).code, 0);
  assert.equal((await runCli(root, ["sync", "--check"])).code, 0);
  assert.equal(await readFile(guide, "utf8"), await readFile(path.join(packageRoot, "methodology/authority-authoring.yaml"), "utf8"));
});

test("all managed commands refuse final-component, parent, and broken symlinks without touching external sentinels", async () => {
  const external = await temporaryProject();
  const sentinels = {};
  for (const name of ["guide", "agents", "claude", "gitignore", "parent", "broken", "local-conflict"]) {
    const ref = path.join(external, `${name}.sentinel`);
    await writeFile(ref, Buffer.from(`${name}:\u0000unchanged\n`, "utf8"));
    sentinels[name] = ref;
  }

  for (const [name, relativePath] of [
    ["guide", ".nimi/methodology/authority-authoring.yaml"],
    ["agents", "AGENTS.md"],
    ["claude", "CLAUDE.md"],
    ["gitignore", ".gitignore"],
  ]) {
    const root = await temporaryProject();
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await symlink(sentinels[name], path.join(root, relativePath));
    await assertManagedCommandsRefuse(root, [sentinels[name]]);
  }

  const parentRoot = await temporaryProject();
  const externalNimi = path.join(external, "external-nimi");
  await mkdir(externalNimi);
  await writeFile(path.join(externalNimi, "sentinel.bin"), await readFile(sentinels.parent));
  await symlink(externalNimi, path.join(parentRoot, ".nimi"));
  await assertManagedCommandsRefuse(parentRoot, [path.join(externalNimi, "sentinel.bin")]);
  assert.deepEqual((await readdir(externalNimi)).sort(), ["sentinel.bin"]);

  const methodologyParentRoot = await temporaryProject();
  await mkdir(path.join(methodologyParentRoot, ".nimi"));
  const externalMethodology = path.join(external, "external-methodology");
  await mkdir(externalMethodology);
  await writeFile(path.join(externalMethodology, "sentinel.bin"), await readFile(sentinels.parent));
  await symlink(externalMethodology, path.join(methodologyParentRoot, ".nimi/methodology"));
  await assertManagedCommandsRefuse(methodologyParentRoot, [path.join(externalMethodology, "sentinel.bin")]);
  assert.deepEqual((await readdir(externalMethodology)).sort(), ["sentinel.bin"]);

  const brokenRoot = await temporaryProject();
  await mkdir(path.join(brokenRoot, ".nimi/config"), { recursive: true });
  await symlink(path.join(external, "does-not-exist"), path.join(brokenRoot, ".nimi/config/spec-generation-inputs.yaml"));
  await assertManagedCommandsRefuse(brokenRoot, [sentinels.broken]);

  const conflictRoot = await temporaryProject();
  await mkdir(path.join(conflictRoot, ".nimi"));
  await writeFile(path.join(conflictRoot, ".nimi/local"), "ordinary file\n", "utf8");
  await assertManagedCommandsRefuse(conflictRoot, [sentinels["local-conflict"]]);
  for (const ref of ["AGENTS.md", "CLAUDE.md", ".gitignore", ".nimi/methodology/authority-authoring.yaml"]) {
    assert.equal(await exists(path.join(conflictRoot, ref)), null, ref);
  }
});

test("duplicate, unbalanced, and nested managed markers fail every command before managed mutation", async () => {
  for (const [target, begin, end] of [
    ["AGENTS.md", AGENTS_BEGIN, AGENTS_END],
    ["CLAUDE.md", CLAUDE_BEGIN, CLAUDE_END],
  ]) {
    const malformedBodies = [
      `${begin}\none\n${end}\n${begin}\ntwo\n${end}\n`,
      `${begin}\nmissing end\n`,
      `${begin}\n${begin}\nnested\n${end}\n${end}\n`,
    ];
    for (const malformed of malformedBodies) {
      const root = await temporaryProject();
      await bootstrap(root);
      await writeFile(path.join(root, target), `# Host\n\n${malformed}`, "utf8");
      const expected = await managedBytes(root);
      const sentinelRoot = await temporaryProject();
      const sentinel = path.join(sentinelRoot, "external-sentinel.bin");
      await writeFile(sentinel, Buffer.from("external\u0000sentinel\n", "utf8"));
      for (const args of managedCommands) {
        const result = await runCli(root, args);
        assert.equal(result.code, 2, `${target} ${args.join(" ")}: ${result.stdout || result.stderr}`);
        assert.match(result.stderr, /exactly one ordered, non-nested begin\/end pair/);
        await assertManagedBytes(root, expected, `${target} ${args.join(" ")}`);
        assert.deepEqual(await readFile(sentinel), Buffer.from("external\u0000sentinel\n", "utf8"));
      }
    }
  }
});

test("clear removes only the exact managed span and preserves host prefix and suffix bytes", async () => {
  const root = await temporaryProject();
  await bootstrap(root);
  for (const [target, begin, end] of [
    ["AGENTS.md", AGENTS_BEGIN, AGENTS_END],
    ["CLAUDE.md", CLAUDE_BEGIN, CLAUDE_END],
  ]) {
    const installed = await readFile(path.join(root, target), "utf8");
    const beginIndex = installed.indexOf(begin);
    const endIndex = installed.indexOf(end) + end.length;
    const block = installed.slice(beginIndex, endIndex);
    const prefix = `\nHOST:${target}:prefix  \n\n`;
    const suffix = `\n\nHOST:${target}:suffix  \nTAIL`;
    await writeFile(path.join(root, target), `${prefix}${block}${suffix}`, "utf8");
  }

  const result = await runCli(root, ["clear", "--yes"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  for (const target of ["AGENTS.md", "CLAUDE.md"]) {
    const prefix = `\nHOST:${target}:prefix  \n\n`;
    const suffix = `\n\nHOST:${target}:suffix  \nTAIL`;
    assert.deepEqual(await readFile(path.join(root, target)), Buffer.from(`${prefix}${suffix}`, "utf8"));
  }
});

test("pre-existing header-only host entrypoints survive start then clear", async () => {
  const root = await temporaryProject();
  await writeFile(path.join(root, "AGENTS.md"), "# AGENTS.md\n", "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), "# CLAUDE.md\n", "utf8");
  await bootstrap(root);
  assert.equal((await runCli(root, ["clear", "--yes"])).code, 0);
  for (const [target, header] of [["AGENTS.md", "# AGENTS.md\n"], ["CLAUDE.md", "# CLAUDE.md\n"]]) {
    const info = await lstat(path.join(root, target));
    assert.equal(info.isFile(), true);
    assert.match(await readFile(path.join(root, target), "utf8"), new RegExp(`^${header.trim()}`));
  }
});

test("invalid UTF-8 in host-owned text fails every managed command without any mutation", async () => {
  for (const target of ["AGENTS.md", "CLAUDE.md", ".gitignore"]) {
    const root = await temporaryProject();
    await bootstrap(root);
    const invalidBytes = Buffer.from([0x68, 0x6f, 0x73, 0x74, 0xc3, 0x28, 0x0a]);
    await writeFile(path.join(root, target), invalidBytes);
    const expected = await managedBytes(root);
    const sentinelRoot = await temporaryProject();
    const sentinel = path.join(sentinelRoot, `${path.basename(target)}.sentinel`);
    const sentinelBytes = Buffer.from(`sentinel:${target}:\u0000unchanged\n`, "utf8");
    await writeFile(sentinel, sentinelBytes);
    for (const args of managedCommands) {
      const result = await runCli(root, args);
      assert.equal(result.code, 2, `${target} ${args.join(" ")}: ${result.stdout || result.stderr}`);
      assert.match(result.stderr, /managed host text is not valid UTF-8/);
      await assertManagedBytes(root, expected, `${target} ${args.join(" ")}`);
      assert.deepEqual(await readFile(sentinel), sentinelBytes);
    }
  }
});

test("hard-linked managed regular files are refused without changing the external inode", async () => {
  for (const target of [".nimi/methodology/authority-authoring.yaml", "AGENTS.md", "CLAUDE.md", ".gitignore"]) {
    const root = await temporaryProject();
    const external = await temporaryProject();
    const sentinel = path.join(external, `${path.basename(target)}.sentinel`);
    const sentinelBytes = Buffer.from(`hardlink:${target}:\u0000unchanged\n`, "utf8");
    await writeFile(sentinel, sentinelBytes);
    await mkdir(path.dirname(path.join(root, target)), { recursive: true });
    await link(sentinel, path.join(root, target));
    await assertManagedCommandsRefuse(root, [sentinel]);
    assert.deepEqual(await readFile(sentinel), sentinelBytes);
    assert.deepEqual(await readFile(path.join(root, target)), sentinelBytes);
  }
});

test("comment-only gitignore text is not an effective local-ignore rule", async () => {
  const root = await temporaryProject();
  const original = "# .nimi/local/\nhost-owned/**\n";
  await writeFile(path.join(root, ".gitignore"), original, "utf8");
  await bootstrap(root);
  const actual = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.equal(actual, `${original}.nimi/local/\n`);
  assert.equal(actual.split("\n").filter((line) => line === ".nimi/local/").length, 1);
});

test("start appends the local ignore rule after a later negation and git confirms it is effective", async () => {
  const root = await temporaryProject();
  const original = ".nimi/local/\n!.nimi/local/\nhost-owned/**\n";
  await writeFile(path.join(root, ".gitignore"), original, "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await bootstrap(root);
  const actual = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.equal(actual, `${original}.nimi/local/\n`);
  await writeFile(path.join(root, ".nimi/local/probe"), "probe\n", "utf8");
  await assert.doesNotReject(execFileAsync("git", ["check-ignore", "-q", ".nimi/local/probe"], { cwd: root }));
});

test("compiler semantics come only from installed package contracts", async () => {
  const root = await temporaryProject();
  await bootstrap(root);
  await writeValidAuthority(root);
  await mkdir(path.join(root, ".nimi/contracts"), { recursive: true });
  await writeFile(path.join(root, ".nimi/contracts/authority-source.schema.yaml"), "version: 999\nallow_anything: true\n", "utf8");
  assert.equal((await runCli(root, ["authority", "check", ".nimi/spec", "--json"])).code, 0);
  assert.equal((await runCli(root, ["authority", "compile", ".nimi/spec", "--json"])).code, 0);
});

test("optional L3 AI governance is separate from authority admission", async () => {
  const root = await temporaryProject();
  await bootstrap(root);
  await writeFile(path.join(root, "AGENTS.md"), [
    "# AGENTS.md", "", "## Scope", "Repository fixture.", "", "## Hard Boundaries", "Authority is explicit.", "",
    "## Retrieval Defaults", "Read bounded context.", "", "## Verification Commands", "Run deterministic checks.", "",
  ].join("\n"), "utf8");
  await mkdir(path.join(root, ".nimi/config"), { recursive: true });
  await writeFile(path.join(root, ".nimi/config/governance.yaml"), [
    "profile_id: fixture",
    "ai_governance:",
    "  agents_freshness:",
    "    targets:",
    "      - rel: AGENTS.md",
    "        max_lines: 40",
    "    required_sections: ['## Scope', '## Hard Boundaries', '## Retrieval Defaults', '## Verification Commands']",
    "    stale_tokens: []",
    "",
  ].join("\n"), "utf8");
  const result = await runCli(root, ["validate-ai-governance", "--profile", "fixture", "--scope", "agents-freshness", "--json"]);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(await exists(path.join(root, ".nimi/spec")), null);
});

test("clear removes only exact package surfaces and preserves host-owned files", async () => {
  const root = await temporaryProject();
  await bootstrap(root);
  await mkdir(path.join(root, ".nimi/config"), { recursive: true });
  await writeFile(path.join(root, ".nimi/config/project.yaml"), "project: true\n", "utf8");
  const result = await runCli(root, ["clear", "--yes"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(await exists(path.join(root, ".nimi/methodology/authority-authoring.yaml")), null);
  assert.equal(await readFile(path.join(root, ".nimi/config/project.yaml"), "utf8"), "project: true\n");
  assert((await exists(path.join(root, ".nimi/local")))?.isDirectory());
});
