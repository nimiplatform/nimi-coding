import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseOptions } from "../cli/commands/authority.mjs";
import { helpText } from "../cli/help.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const auditFixtures = path.join(packageRoot, "test", "fixtures", "authority", "audit");
const auditCorpus = path.join(auditFixtures, "corpus");
const requiredArguments = [
  "authority",
  "audit",
  "spec",
  "--bindings",
  "bindings.yaml",
  "--max-units",
  "8",
  "--max-edges",
  "16",
  "--max-bytes",
  "65536",
];

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("audit CLI requires explicit positive-safe budgets and one bindings file", async () => {
  const valid = parseOptions("audit", requiredArguments.slice(2));
  assert.equal(valid.ok, true);
  assert.deepEqual(
    {
      path: valid.options.path,
      bindings: valid.options.bindings,
      maxUnits: valid.options.maxUnits,
      maxEdges: valid.options.maxEdges,
      maxBytes: valid.options.maxBytes,
    },
    {
      path: "spec",
      bindings: "bindings.yaml",
      maxUnits: 8,
      maxEdges: 16,
      maxBytes: 65536,
    },
  );

  for (const option of ["--bindings", "--max-units", "--max-edges", "--max-bytes"]) {
    const index = requiredArguments.indexOf(option);
    const missing = requiredArguments.slice(2);
    missing.splice(index - 2, 2);
    const parsed = parseOptions("audit", missing);
    assert.equal(parsed.ok, false, option);
    assert.match(parsed.error, new RegExp(option.slice(2)));
  }

  for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
    const args = requiredArguments.slice(2);
    args[args.indexOf("--max-units") + 1] = value;
    const parsed = parseOptions("audit", args);
    assert.equal(parsed.ok, false, value);
  }

  const usageFailure = await runCli([...requiredArguments, "--json", "--sarif"]);
  assert.equal(usageFailure.code, 2);
  assert.equal(usageFailure.stdout, "");
  assert.match(
    usageFailure.stderr,
    /^authority audit requires --json and --sarif to be mutually exclusive\n/,
  );
});

test("audit CLI keeps JSON and SARIF mutually exclusive in either order", () => {
  for (const outputOptions of [
    ["--json", "--sarif"],
    ["--sarif", "--json"],
  ]) {
    const parsed = parseOptions("audit", [...requiredArguments.slice(2), ...outputOptions]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /mutually exclusive/);
  }
  assert.match(helpText(), /authority audit <path> --bindings <file>.*\[--json\|--sarif\]/);
});

test("public audit outputs preserve status and distinguish real findings from gaps", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "nimicoding-audit-cli-"));
  try {
    const validBindings = path.join(auditFixtures, "bindings.valid.yaml");
    const blockedBindings = path.join(temporaryRoot, "bindings.blocked.yaml");
    const source = await readFile(validBindings, "utf8");
    assert(source.includes("minimum: 1"));
    await writeFile(blockedBindings, source.replace("minimum: 1", "minimum: 2"), "utf8");
    const command = (bindings, output = []) => [
      "authority",
      "audit",
      auditCorpus,
      "--bindings",
      bindings,
      "--max-units",
      "64",
      "--max-edges",
      "128",
      "--max-bytes",
      "262144",
      ...output,
    ];

    const blocked = await runCli(command(blockedBindings));
    assert.equal(blocked.code, 1, blocked.stderr || blocked.stdout);
    assert.equal(blocked.stderr, "");
    assert.match(
      blocked.stdout,
      /^nimicoding authority audit: operation=completed; policy=blocked; complete=true$/m,
    );
    assert.match(blocked.stdout, /^returned: observations=1; findings=2; gaps=0$/m);
    assert.match(
      blocked.stdout,
      /^finding AUTH_AUDIT_MINIMUM_INDEPENDENT_INCOMING_REFERENCE sha256:[0-9a-f]{64} at .+:\d+:\d+:/m,
    );
    assert.doesNotMatch(blocked.stdout, /^gap /m);

    const gap = await runCli(command(path.join(auditFixtures, "bindings.gap.yaml")));
    assert.equal(gap.code, 1, gap.stderr || gap.stdout);
    assert.equal(gap.stderr, "");
    assert.match(
      gap.stdout,
      /^nimicoding authority audit: operation=completed; policy=indeterminate; complete=false$/m,
    );
    assert.match(gap.stdout, /^returned: observations=0; findings=0; gaps=1$/m);
    assert.match(
      gap.stdout,
      /^gap AUTH_AUDIT_REQUIRED_BINDING_MISSING sha256:[0-9a-f]{64} at .+:\d+:\d+:/m,
    );
    assert.doesNotMatch(gap.stdout, /^finding /m);

    const primary = await runCli(command(validBindings, ["--json"]));
    assert.equal(primary.code, 0, primary.stderr || primary.stdout);
    assert.equal(primary.stderr, "");
    const report = JSON.parse(primary.stdout);
    assert.equal(report.operation, "audit");
    assert.equal(report.audit_bytes > 0, true);
    assert.equal(report.audit.policyStatus, "passed");
    assert.equal(report.partial, false);

    const sarifOutput = await runCli(command(validBindings, ["--sarif"]));
    assert.equal(sarifOutput.code, 0, sarifOutput.stderr || sarifOutput.stdout);
    assert.equal(sarifOutput.stderr, "");
    const sarif = JSON.parse(sarifOutput.stdout);
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);

    const refusedArguments = command(validBindings, ["--sarif"]);
    refusedArguments[refusedArguments.indexOf("--max-bytes") + 1] = "1";
    const refusedSarif = await runCli(refusedArguments);
    assert.equal(refusedSarif.code, 1, refusedSarif.stderr || refusedSarif.stdout);
    assert.equal(refusedSarif.stderr, "");
    const refused = JSON.parse(refusedSarif.stdout);
    assert.equal(refused.runs[0].invocations[0].executionSuccessful, false);
    assert.equal(refused.runs[0].invocations[0].properties.operationStatus, "refused");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
