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
import { refsAuthorityPath } from "../cli/lib/authority/graph.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixtures = path.join(packageRoot, "test", "fixtures", "authority");
const temporaryRoots = [];
const discoveryBudgets = { maxCandidates: 10, maxSnippetTerms: 12, maxBytes: 65536 };

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

async function exactByteBudget(inputPath, query, options) {
  let maxBytes = options.maxBytes ?? 65536;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await discoverAuthorityPath(inputPath, query, { ...options, maxBytes });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    if (result.discoveryBytes === maxBytes) return { result, maxBytes };
    maxBytes = result.discoveryBytes;
  }
  assert.fail("discovery byte budget did not converge to its canonical payload size");
}

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test("fixed Unicode lexical normalization, exact matching, ranking, tie order, and traceable fields are deterministic", async () => {
  assert.deepEqual(normalizeDiscoveryTerms("checkoutSession ＡＰＩ api naïve-42"), ["checkout", "session", "api", "naïve", "42"]);
  assert.deepEqual(normalizeDiscoveryTerms("a\u0301B fooⒶ"), ["á", "b", "foo", "a"]);
  assert.deepEqual(normalizeDiscoveryTerms("a\u0301B fooⒶ"), normalizeDiscoveryTerms("áB fooA"));
  const state = await corpus();
  const first = await discoverAuthorityPath(state.target, "checkout session", discoveryBudgets);
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
    assert.deepEqual(Object.keys(match), ["field", "terms", "location", "snippet"]);
    assert.match(match.location.file, /\.authority\.yaml$/);
    assert(!path.isAbsolute(match.location.file));
    assert(match.location.sourcePointer.startsWith("/units/"));
    assert(match.location.range.start.line > 0);
    assert.deepEqual(Object.keys(match.snippet), ["normalization", "terms", "anchor", "matchedTerms", "omittedBeforeTerms", "omittedAfterTerms", "complete"]);
    assert(match.snippet.terms.length <= discoveryBudgets.maxSnippetTerms);
    assert(match.snippet.matchedTerms.every((term) => match.snippet.terms.includes(term)));
    assert(match.snippet.terms.includes(match.snippet.anchor.term));
  }
  assert.equal(candidate.primaryIdLocation.sourcePointer.endsWith("/id"), true);
  assert.deepEqual(Object.keys(candidate), ["rank", "id", "kind", "lifecycle", "owner", "title", "scope", "matchedTerms", "matches", "primaryIdLocation"]);
  assert.equal(first.discovery.format, "nimicoding.authority-discovery/v2");
  assert.deepEqual(first.discovery.filters, { kind: null, owner: null, scope: null, lifecycle: null });
  assert.deepEqual(first.discovery.counts, { corpusUnits: 6, eligibleUnits: 6, matchedUnits: 6, returnedCandidates: 6 });
  assert.equal(first.discovery.absenceProven, false);
  assert.equal(first.discovery.relationPreview, null);
  assert.doesNotMatch(JSON.stringify(first.discovery), /"semantic"|"metadata"|"context"/);
  assert.equal(first.discoveryBytes, canonicalDiscoveryBytes(first.discovery));
  assert.equal((await discoverAuthorityPath(state.target, "sess", discoveryBudgets)).diagnostics[0].code, "AUTH_DISCOVERY_NOT_FOUND");
  assert.equal((await discoverAuthorityPath(state.target, "supersedes", discoveryBudgets)).diagnostics[0].code, "AUTH_DISCOVERY_NOT_FOUND");

  const repeated = await discoverAuthorityPath(state.target, "checkout session", discoveryBudgets);
  const relocated = await corpus();
  const moved = await discoverAuthorityPath(relocated.target, "checkout session", discoveryBudgets);
  assert.equal(JSON.stringify(repeated.discovery), JSON.stringify(first.discovery));
  assert.equal(JSON.stringify(moved.discovery), JSON.stringify(first.discovery));
});

test("top-k reports totals and truncation without silently reducing candidates for byte budget", async () => {
  const state = await corpus();
  const bounded = await discoverAuthorityPath(state.target, "session", { ...discoveryBudgets, maxCandidates: 2 });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.discovery.counts.matchedUnits, 6);
  assert.equal(bounded.discovery.counts.returnedCandidates, 2);
  assert.equal(bounded.discovery.truncated, true);
  assert.equal(bounded.discovery.candidates.length, 2);

  const exact = await exactByteBudget(state.target, "session", { ...discoveryBudgets, maxCandidates: 2 });
  const oneUnder = await discoverAuthorityPath(state.target, "session", { ...discoveryBudgets, maxCandidates: 2, maxBytes: exact.maxBytes - 1 });
  assert.equal(oneUnder.ok, false);
  assert.equal(oneUnder.discovery, null);
  assert.equal(oneUnder.discoveryBytes, 0);
  assert.equal(oneUnder.diagnostics[0].code, "AUTH_DISCOVERY_BUDGET");
  assert.match(oneUnder.diagnostics[0].reason, new RegExp(`requires ${exact.maxBytes} UTF-8 bytes`));
});

test("singular exact filters narrow eligibility without changing lexical ranking truth", async () => {
  const state = await corpus();
  const unfiltered = await discoverAuthorityPath(state.target, "checkout session", discoveryBudgets);
  assert.equal(unfiltered.ok, true, JSON.stringify(unfiltered.diagnostics));

  const cases = [
    [{ kind: "definition" }, ["definition.session", "definition.session-v0"]],
    [{ owner: "team.identity" }, ["definition.session", "definition.session-v0"]],
    [{ scope: "api.checkout" }, ["rule.checkout-session", "rule.checkout-no-anonymous"]],
    [{ lifecycle: "removed" }, ["rule.checkout-session-v0", "rule.checkout-session-v00", "definition.session-v0"]],
    [{ kind: "rule", owner: "team.checkout", scope: "api.checkout", lifecycle: "active" }, ["rule.checkout-session", "rule.checkout-no-anonymous"]],
  ];
  for (const [filters, expected] of cases) {
    const result = await discoverAuthorityPath(state.target, "checkout session", { ...discoveryBudgets, ...filters });
    assert.equal(result.ok, true, `${JSON.stringify(filters)}: ${JSON.stringify(result.diagnostics)}`);
    assert.deepEqual(result.discovery.filters, { kind: null, owner: null, scope: null, lifecycle: null, ...filters });
    assert.deepEqual(new Set(result.discovery.candidates.map(({ id }) => id)), new Set(expected));
    assert.equal(result.discovery.counts.corpusUnits, 6);
    assert.equal(result.discovery.counts.eligibleUnits, expected.length);
    assert.equal(result.discovery.counts.matchedUnits, expected.length);
    assert.equal(result.discovery.absenceProven, false);
    const unfilteredOrder = unfiltered.discovery.candidates.map(({ id }) => id).filter((id) => expected.includes(id));
    assert.deepEqual(result.discovery.candidates.map(({ id }) => id), unfilteredOrder);
  }
});

test("unknown and contradictory exact filters refuse with null discovery", async () => {
  const state = await corpus();
  for (const [filters, code] of [
    [{ kind: "policy" }, "AUTH_DISCOVERY_FILTER_INVALID"],
    [{ lifecycle: "draft" }, "AUTH_DISCOVERY_FILTER_INVALID"],
    [{ owner: "team.unknown\u001b[2J" }, "AUTH_DISCOVERY_FILTER_INVALID"],
    [{ owner: "--team.checkout" }, "AUTH_DISCOVERY_FILTER_INVALID"],
    [{ scope: "api/checkout" }, "AUTH_DISCOVERY_FILTER_INVALID"],
    [{ owner: "team.unknown" }, "AUTH_DISCOVERY_FILTER_UNKNOWN"],
    [{ scope: "api.unknown" }, "AUTH_DISCOVERY_FILTER_UNKNOWN"],
    [{ kind: "definition", scope: "api.checkout" }, "AUTH_DISCOVERY_FILTER_CONTRADICTORY"],
    [{ owner: "team.identity", scope: "api.checkout" }, "AUTH_DISCOVERY_FILTER_CONTRADICTORY"],
  ]) {
    const result = await discoverAuthorityPath(state.target, "session", { ...discoveryBudgets, ...filters });
    assert.equal(result.ok, false, JSON.stringify(filters));
    assert.equal(result.discovery, null);
    assert.equal(result.discoveryBytes, 0);
    assert.equal(result.diagnostics[0].code, code);
  }
});

test("runtime requires explicit positive safe-integer candidate, snippet, and byte budgets", async () => {
  const state = await corpus();
  for (const override of [
    { maxCandidates: undefined },
    { maxCandidates: 0 },
    { maxSnippetTerms: undefined },
    { maxSnippetTerms: 0 },
    { maxSnippetTerms: Number.MAX_SAFE_INTEGER + 1 },
    { maxBytes: undefined },
    { maxBytes: 0 },
  ]) {
    const result = await discoverAuthorityPath(state.target, "session", { ...discoveryBudgets, ...override });
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.equal(result.discovery, null);
    assert.equal(result.discoveryBytes, 0);
    assert.equal(result.diagnostics[0].code, "AUTH_DISCOVERY_BUDGET");
  }
});

test("field-aware normalized term windows are bounded, stable, and do not affect rank", async () => {
  const state = await corpus();
  const threeTerms = await discoverAuthorityPath(state.target, "checkout request", { ...discoveryBudgets, maxSnippetTerms: 3 });
  const oneTerm = await discoverAuthorityPath(state.target, "checkout request", { ...discoveryBudgets, maxSnippetTerms: 1 });
  assert.equal(threeTerms.ok, true, JSON.stringify(threeTerms.diagnostics));
  assert.equal(oneTerm.ok, true, JSON.stringify(oneTerm.diagnostics));
  assert.deepEqual(oneTerm.discovery.candidates.map(({ id }) => id), threeTerms.discovery.candidates.map(({ id }) => id));

  const statement = threeTerms.discovery.candidates[0].matches.find(({ field }) => field === "statement");
  assert(statement);
  assert.equal(typeof statement.snippet.normalization, "string");
  assert.deepEqual(statement.snippet.terms, ["a", "checkout", "request"]);
  assert.deepEqual(statement.snippet.anchor, { term: "checkout", fieldTermIndex: 1 });
  assert.deepEqual(statement.snippet.matchedTerms, ["checkout", "request"]);
  assert.equal(statement.snippet.omittedBeforeTerms, 0);
  assert.equal(statement.snippet.omittedAfterTerms, 4);
  assert.equal(statement.snippet.complete, false);
  assert.equal(statement.location.sourcePointer, "/units/0/statement");

  for (const candidate of oneTerm.discovery.candidates) {
    for (const match of candidate.matches) {
      assert.equal(match.snippet.terms.length, 1);
      assert.equal(match.snippet.terms[0], match.snippet.anchor.term);
      assert(match.snippet.matchedTerms.every((term) => match.snippet.terms.includes(term)));
    }
  }
  assert.equal(threeTerms.discovery.budgets.maxSnippetTerms, 3);
  assert.equal(oneTerm.discovery.budgets.maxSnippetTerms, 1);
});

test("optional relation preview is all-or-none, reuses direct authored edges, and cannot affect rank", async () => {
  const state = await corpus();
  const baseOptions = { ...discoveryBudgets, maxCandidates: 1 };
  const unpreviewed = await discoverAuthorityPath(state.target, "checkout session", baseOptions);
  const previewOptions = {
    ...baseOptions,
    previewDirection: "outgoing",
    relations: ["applies_to", "supersedes"],
    maxEdges: 2,
  };
  const previewed = await discoverAuthorityPath(state.target, "checkout session", previewOptions);
  assert.equal(previewed.ok, true, JSON.stringify(previewed.diagnostics));
  assert.deepEqual(previewed.discovery.candidates.map(({ id, rank }) => ({ id, rank })), unpreviewed.discovery.candidates.map(({ id, rank }) => ({ id, rank })));
  assert.deepEqual(previewed.discovery.relationPreview.direction, "outgoing");
  assert.deepEqual(previewed.discovery.relationPreview.relations, ["applies_to", "supersedes"]);
  assert.equal(previewed.discovery.relationPreview.complete, true);
  assert.deepEqual(previewed.discovery.relationPreview.roots, ["rule.checkout-session"]);
  assert.equal(previewed.discovery.relationPreview.counts.edges, 2);
  assert.equal(previewed.discovery.relationPreview.budgets.maxEdges, 2);

  const refs = await refsAuthorityPath(state.target, "rule.checkout-session", {
    direction: "outgoing",
    relations: ["applies_to", "supersedes"],
    maxUnits: 3,
    maxEdges: 2,
    maxBytes: 65536,
  });
  assert.equal(refs.ok, true, JSON.stringify(refs.diagnostics));
  assert.deepEqual(previewed.discovery.relationPreview.nodes, refs.graph.nodes);
  assert.deepEqual(previewed.discovery.relationPreview.edges, refs.graph.edges);
  const reorderedRelations = await discoverAuthorityPath(state.target, "checkout session", {
    ...previewOptions,
    relations: ["supersedes", "applies_to"],
  });
  assert.equal(reorderedRelations.ok, true, JSON.stringify(reorderedRelations.diagnostics));
  assert.deepEqual(reorderedRelations.discovery, previewed.discovery);

  for (const [direction, maxEdges] of [["incoming", 2], ["both", 3]]) {
    const directed = await discoverAuthorityPath(state.target, "server issued identity context", {
      ...baseOptions,
      previewDirection: direction,
      relations: ["applies_to", "supersedes"],
      maxEdges,
    });
    assert.equal(directed.ok, true, `${direction}: ${JSON.stringify(directed.diagnostics)}`);
    assert.deepEqual(directed.discovery.relationPreview.roots, ["definition.session"]);
    const directRefs = await refsAuthorityPath(state.target, "definition.session", {
      direction,
      relations: ["applies_to", "supersedes"],
      maxUnits: 4,
      maxEdges,
      maxBytes: 65536,
    });
    assert.equal(directRefs.ok, true, `${direction}: ${JSON.stringify(directRefs.diagnostics)}`);
    assert.deepEqual(directed.discovery.relationPreview.nodes, directRefs.graph.nodes);
    assert.deepEqual(directed.discovery.relationPreview.edges, directRefs.graph.edges);
  }

  const exactBytes = await exactByteBudget(state.target, "checkout session", previewOptions);
  const byteOverflow = await discoverAuthorityPath(state.target, "checkout session", { ...previewOptions, maxBytes: exactBytes.maxBytes - 1 });
  assert.equal(byteOverflow.ok, false);
  assert.equal(byteOverflow.discovery, null);
  assert.equal(byteOverflow.diagnostics[0].code, "AUTH_DISCOVERY_BUDGET");

  const edgeOverflow = await discoverAuthorityPath(state.target, "checkout session", { ...previewOptions, maxEdges: 1 });
  assert.equal(edgeOverflow.ok, false);
  assert.equal(edgeOverflow.discovery, null);
  assert.equal(edgeOverflow.diagnostics[0].code, "AUTH_DISCOVERY_PREVIEW_BUDGET");
  for (const incomplete of [
    { previewDirection: "outgoing" },
    { relations: ["applies_to"] },
    { maxEdges: 2 },
    { previewDirection: "sideways", relations: ["applies_to"], maxEdges: 2 },
    { previewDirection: "outgoing", relations: ["unknown"], maxEdges: 2 },
    { previewDirection: "outgoing", relations: ["applies_to", "applies_to"], maxEdges: 2 },
  ]) {
    const result = await discoverAuthorityPath(state.target, "checkout session", { ...baseOptions, ...incomplete });
    assert.equal(result.ok, false, JSON.stringify(incomplete));
    assert.equal(result.discovery, null);
    assert.equal(result.diagnostics[0].code, "AUTH_DISCOVERY_PREVIEW_INVALID");
  }

  const source = path.join(state.target, "session.authority.yaml");
  await writeFile(source, (await readFile(source, "utf8")).replace(
    "      - type: supersedes\n        target: rule.checkout-session-v0\n",
    "",
  ), "utf8");
  const mutatedWithoutPreview = await discoverAuthorityPath(state.target, "checkout session", baseOptions);
  const mutatedPreview = await discoverAuthorityPath(state.target, "checkout session", { ...previewOptions, maxEdges: 1 });
  assert.equal(mutatedWithoutPreview.ok, true, JSON.stringify(mutatedWithoutPreview.diagnostics));
  assert.equal(mutatedPreview.ok, true, JSON.stringify(mutatedPreview.diagnostics));
  assert.deepEqual(mutatedWithoutPreview.discovery.candidates, unpreviewed.discovery.candidates);
  assert.deepEqual(mutatedPreview.discovery.candidates, previewed.discovery.candidates);
  assert.equal(mutatedPreview.discovery.relationPreview.counts.edges, 1);
  assert.notDeepEqual(mutatedPreview.discovery.relationPreview.edges, previewed.discovery.relationPreview.edges);
});

test("active and removed rules and definitions are candidates, and YAML/Markdown preserve candidate identity", async () => {
  const yaml = await corpus("yaml");
  const markdown = await corpus("markdown");
  const fromYaml = await discoverAuthorityPath(yaml.target, "legacy session checkout", discoveryBudgets);
  const fromMarkdown = await discoverAuthorityPath(markdown.target, "legacy session checkout", discoveryBudgets);
  assert.equal(fromYaml.ok, true);
  assert.equal(fromMarkdown.ok, true);
  const identity = (result) => result.discovery.candidates.map(({ id, kind, lifecycle }) => ({ id, kind, lifecycle }));
  assert.deepEqual(identity(fromMarkdown), identity(fromYaml));
  const observed = new Set(fromYaml.discovery.candidates.map(({ kind, lifecycle }) => `${kind}:${lifecycle}`));
  assert.deepEqual(observed, new Set(["definition:active", "definition:removed", "rule:active", "rule:removed"]));
});

test("CLI exposes exact filters and all-or-none relation preview with domain failures on stdout", async () => {
  const state = await corpus();
  const required = ["--max-candidates", "3", "--max-snippet-terms", "5", "--max-bytes", "65536", "--json"];
  const valid = await runCli([
    "authority", "discover", state.target, "checkout session",
    "--kind", "rule", "--owner", "team.checkout", "--scope", "api.checkout", "--lifecycle", "active",
    "--preview-direction", "outgoing", "--relations", "applies_to,supersedes", "--max-edges", "4",
    ...required,
  ]);
  assert.equal(valid.code, 0, valid.stderr || valid.stdout);
  const report = JSON.parse(valid.stdout);
  assert.equal(report.discovery.format, "nimicoding.authority-discovery/v2");
  assert.deepEqual(report.discovery.filters, { kind: "rule", owner: "team.checkout", scope: "api.checkout", lifecycle: "active" });
  assert.deepEqual(report.discovery.candidates.map(({ id }) => id), ["rule.checkout-session", "rule.checkout-no-anonymous"]);
  assert.equal(report.discovery.relationPreview.direction, "outgoing");
  assert.equal(report.discovery.relationPreview.complete, true);

  for (const [filterArgs, code] of [
    [["--owner", "team.unknown"], "AUTH_DISCOVERY_FILTER_UNKNOWN"],
    [["--kind", "definition", "--scope", "api.checkout"], "AUTH_DISCOVERY_FILTER_CONTRADICTORY"],
  ]) {
    const refused = await runCli(["authority", "discover", state.target, "session", ...filterArgs, ...required]);
    assert.equal(refused.code, 1, refused.stderr || refused.stdout);
    const refusedReport = JSON.parse(refused.stdout);
    assert.equal(refusedReport.discovery, null);
    assert.equal(refusedReport.diagnostics[0].code, code);
  }

  const controlRefused = await runCli([
    "authority", "discover", state.target, "session", "--owner", "team.unknown\u001b[2J",
    "--max-candidates", "3", "--max-snippet-terms", "5", "--max-bytes", "65536",
  ]);
  assert.equal(controlRefused.code, 2, controlRefused.stdout || controlRefused.stderr);
  assert.equal(controlRefused.stdout, "");
  assert.doesNotMatch(controlRefused.stderr, /\u001b/u);

  const optionLike = await runCli([
    "authority", "discover", state.target, "session", "--owner", "--team.checkout",
    "--max-candidates", "3", "--max-snippet-terms", "5", "--max-bytes", "65536",
  ]);
  assert.equal(optionLike.code, 2, optionLike.stdout || optionLike.stderr);
  assert.equal(optionLike.stdout, "");

  for (const previewArgs of [
    ["--preview-direction", "outgoing"],
    ["--relations", "applies_to"],
    ["--max-edges", "2"],
    ["--preview-direction", "outgoing", "--relations", "applies_to"],
    ["--preview-direction", "sideways", "--relations", "applies_to", "--max-edges", "2"],
    ["--preview-direction", "outgoing", "--relations", "applies_to,applies_to", "--max-edges", "2"],
  ]) {
    const usage = await runCli(["authority", "discover", state.target, "session", ...previewArgs, ...required]);
    assert.equal(usage.code, 2, `${previewArgs.join(" ")}: ${usage.stdout || usage.stderr}`);
    assert.equal(usage.stdout, "");
  }
});

test("invalid corpus, invalid query, zero match, UTF-8 budget, and CLI bounds fail closed", async () => {
  const state = await corpus();
  const source = path.join(state.target, "session.authority.yaml");
  await writeFile(source, (await readFile(source, "utf8")).replace("title: Session", "title: 多字节界 a\u0301B Session"), "utf8");
  const unicode = await discoverAuthorityPath(state.target, "多字节界", discoveryBudgets);
  assert.equal(unicode.ok, true, JSON.stringify(unicode.diagnostics));
  assert.equal((await discoverAuthorityPath(state.target, "áB", discoveryBudgets)).ok, true);
  assert.notEqual(JSON.stringify(unicode.discovery).length, Buffer.byteLength(JSON.stringify(unicode.discovery), "utf8"));
  const exactUnicode = await exactByteBudget(state.target, "多字节界", discoveryBudgets);
  assert.equal((await discoverAuthorityPath(state.target, "多字节界", { ...discoveryBudgets, maxBytes: exactUnicode.maxBytes - 1 })).diagnostics[0].code, "AUTH_DISCOVERY_BUDGET");

  const invalidQuery = await discoverAuthorityPath(state.target, "--- 😀", discoveryBudgets);
  assert.equal(invalidQuery.ok, false);
  assert.equal(invalidQuery.discovery, null);
  assert.equal(invalidQuery.diagnostics[0].code, "AUTH_DISCOVERY_QUERY_INVALID");
  const missing = await discoverAuthorityPath(state.target, "vat retail invoice", discoveryBudgets);
  assert.equal(missing.ok, false);
  assert.equal(missing.discovery, null);
  assert.equal(missing.diagnostics[0].code, "AUTH_DISCOVERY_NOT_FOUND");
  assert.match(missing.diagnostics[0].reason, /does not prove that authority does not exist/);

  await writeFile(source, (await readFile(source, "utf8")).replace("target: definition.session", "target: definition.unknown"), "utf8");
  const invalidCorpus = await discoverAuthorityPath(state.target, "session", discoveryBudgets);
  assert.equal(invalidCorpus.ok, false);
  assert.equal(invalidCorpus.discovery, null);
  assert(invalidCorpus.diagnostics.some(({ code }) => code === "AUTH_RELATION_DANGLING"));

  for (const positionals of [
    [state.target],
    [state.target, "session", "extra"],
  ]) {
    const positionalFailure = await runCli(["authority", "discover", ...positionals, "--max-candidates", "10", "--max-snippet-terms", "12", "--max-bytes", "65536", "--json"]);
    assert.equal(positionalFailure.code, 2);
    assert.match(positionalFailure.stderr, /^authority discover requires exactly one path and one query\n/);
  }

  for (const args of [
    ["authority", "discover", state.target, "session", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "10", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "0", "--max-snippet-terms", "12", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "9007199254740992", "--max-snippet-terms", "12", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "10", "--max-snippet-terms", "0", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "10", "--max-snippet-terms", "9007199254740992", "--max-bytes", "65536", "--json"],
    ["authority", "discover", state.target, "session", "--max-candidates", "10", "--max-snippet-terms", "12", "--max-bytes", "0", "--json"],
  ]) assert.equal((await runCli(args)).code, 2);
});
