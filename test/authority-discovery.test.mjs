import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalDiscoveryBytes, discoverAuthorityPath, normalizeDiscoveryTerms } from "../cli/lib/authority/discover.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixtures = path.join(packageRoot, "test", "fixtures", "authority");
const temporaryRoots = [];

async function corpus(profile = "yaml") {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-discovery-"));
  temporaryRoots.push(root);
  const target = path.join(root, "authority");
  await cp(path.join(fixtures, "valid", profile), target, { recursive: true });
  return { root, target };
}

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("fixed Unicode lexical normalization, exact matching, ranking, tie order, and traceable fields are deterministic", async () => {
  assert.deepEqual(normalizeDiscoveryTerms("checkoutSession ＡＰＩ api naïve-42"), ["checkout", "session", "api", "naïve", "42"]);
  const state = await corpus();
  const first = await discoverAuthorityPath(state.target, "checkout session", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.deepEqual(first.discovery.candidates.slice(0, 3).map(({ id }) => id), [
    "rule.checkout-session",
    "rule.checkout-session-v0",
    "rule.checkout-session-v00",
  ]);
  assert.deepEqual(first.discovery.candidates.map(({ rank }) => rank), [1, 2, 3, 4, 5, 6]);
  const candidate = first.discovery.candidates[0];
  assert.deepEqual(candidate.matchedTerms, ["checkout", "session"]);
  assert(candidate.matches.some((match) => match.field === "id" && match.terms.includes("checkout")));
  assert(candidate.matches.some((match) => match.field === "statement" && match.terms.includes("checkout")));
  for (const match of candidate.matches) {
    assert.match(match.location.file, /\.authority\.yaml$/);
    assert(!path.isAbsolute(match.location.file));
    assert(match.location.sourcePointer.startsWith("/units/"));
    assert(match.location.range.start.line > 0);
  }
  assert.equal(candidate.primaryIdLocation.sourcePointer.endsWith("/id"), true);
  assert.deepEqual(Object.keys(candidate), ["rank", "id", "kind", "lifecycle", "owner", "title", "scope", "matchedTerms", "matches", "primaryIdLocation"]);
  assert.doesNotMatch(JSON.stringify(first.discovery), /"relations"|"semantic"|"metadata"|"context"/);
  assert.equal(first.discoveryBytes, canonicalDiscoveryBytes(first.discovery));
  assert.equal((await discoverAuthorityPath(state.target, "sess", { maxCandidates: 10, maxBytes: 65536 })).diagnostics[0].code, "AUTH_DISCOVERY_NOT_FOUND");
  assert.equal((await discoverAuthorityPath(state.target, "supersedes", { maxCandidates: 10, maxBytes: 65536 })).diagnostics[0].code, "AUTH_DISCOVERY_NOT_FOUND");

  const repeated = await discoverAuthorityPath(state.target, "checkout session", { maxCandidates: 10, maxBytes: 65536 });
  const relocated = await corpus();
  const moved = await discoverAuthorityPath(relocated.target, "checkout session", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(JSON.stringify(repeated.discovery), JSON.stringify(first.discovery));
  assert.equal(JSON.stringify(moved.discovery), JSON.stringify(first.discovery));
});

test("top-k reports totals and truncation without silently reducing candidates for byte budget", async () => {
  const state = await corpus();
  const bounded = await discoverAuthorityPath(state.target, "session", { maxCandidates: 2, maxBytes: 65536 });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.discovery.matchedTotal, 6);
  assert.equal(bounded.discovery.returned, 2);
  assert.equal(bounded.discovery.truncated, true);
  assert.equal(bounded.discovery.candidates.length, 2);

  const exact = await discoverAuthorityPath(state.target, "session", { maxCandidates: 2, maxBytes: bounded.discoveryBytes });
  assert.equal(exact.ok, true);
  const oneUnder = await discoverAuthorityPath(state.target, "session", { maxCandidates: 2, maxBytes: bounded.discoveryBytes - 1 });
  assert.equal(oneUnder.ok, false);
  assert.equal(oneUnder.discovery, null);
  assert.equal(oneUnder.discoveryBytes, 0);
  assert.equal(oneUnder.diagnostics[0].code, "AUTH_DISCOVERY_BUDGET");
  assert.match(oneUnder.diagnostics[0].reason, new RegExp(`requires ${bounded.discoveryBytes} UTF-8 bytes`));
});

test("active and removed rules and definitions are candidates, and YAML/Markdown preserve candidate identity", async () => {
  const yaml = await corpus("yaml");
  const markdown = await corpus("markdown");
  const fromYaml = await discoverAuthorityPath(yaml.target, "legacy session checkout", { maxCandidates: 10, maxBytes: 65536 });
  const fromMarkdown = await discoverAuthorityPath(markdown.target, "legacy session checkout", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(fromYaml.ok, true);
  assert.equal(fromMarkdown.ok, true);
  const identity = (result) => result.discovery.candidates.map(({ id, kind, lifecycle }) => ({ id, kind, lifecycle }));
  assert.deepEqual(identity(fromMarkdown), identity(fromYaml));
  const observed = new Set(fromYaml.discovery.candidates.map(({ kind, lifecycle }) => `${kind}:${lifecycle}`));
  assert.deepEqual(observed, new Set(["definition:active", "definition:removed", "rule:active", "rule:removed"]));
});

test("invalid corpus, invalid query, zero match, UTF-8 budget, and CLI bounds fail closed", async () => {
  const state = await corpus();
  const source = path.join(state.target, "session.authority.yaml");
  await writeFile(source, (await readFile(source, "utf8")).replace("title: Session", "title: 多字节界 Session"), "utf8");
  const unicode = await discoverAuthorityPath(state.target, "多字节界", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(unicode.ok, true, JSON.stringify(unicode.diagnostics));
  assert.notEqual(JSON.stringify(unicode.discovery).length, Buffer.byteLength(JSON.stringify(unicode.discovery), "utf8"));
  assert.equal((await discoverAuthorityPath(state.target, "多字节界", { maxCandidates: 10, maxBytes: unicode.discoveryBytes })).ok, true);
  assert.equal((await discoverAuthorityPath(state.target, "多字节界", { maxCandidates: 10, maxBytes: unicode.discoveryBytes - 1 })).diagnostics[0].code, "AUTH_DISCOVERY_BUDGET");

  const invalidQuery = await discoverAuthorityPath(state.target, "--- 😀", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(invalidQuery.ok, false);
  assert.equal(invalidQuery.discovery, null);
  assert.equal(invalidQuery.diagnostics[0].code, "AUTH_DISCOVERY_QUERY_INVALID");
  const missing = await discoverAuthorityPath(state.target, "vat retail invoice", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(missing.ok, false);
  assert.equal(missing.discovery, null);
  assert.equal(missing.diagnostics[0].code, "AUTH_DISCOVERY_NOT_FOUND");
  assert.match(missing.diagnostics[0].reason, /does not prove that authority does not exist/);

  await writeFile(source, (await readFile(source, "utf8")).replace("target: definition.session", "target: definition.unknown"), "utf8");
  const invalidCorpus = await discoverAuthorityPath(state.target, "session", { maxCandidates: 10, maxBytes: 65536 });
  assert.equal(invalidCorpus.ok, false);
  assert.equal(invalidCorpus.discovery, null);
  assert(invalidCorpus.diagnostics.some(({ code }) => code === "AUTH_RELATION_DANGLING"));

  for (const positionals of [
    [state.target],
    [state.target, "session", "extra"],
  ]) {
    const positionalFailure = await runCli(["authority", "discover", ...positionals, "--max-candidates", "10", "--max-bytes", "65536", "--json"]);
    assert.equal(positionalFailure.code, 2);
    assert.match(positionalFailure.stderr, /^authority discover requires exactly one path and one query\n/);
  }

  for (const args of [
    ["authority", "discover", state.target, "session", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "0", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "9007199254740992", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "10", "--max-bytes", "0", "--json"],
  ]) assert.equal((await runCli(args)).code, 2);
});
