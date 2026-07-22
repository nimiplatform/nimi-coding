import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

import { compileAuthorityPath } from "../cli/lib/authority/compile.mjs";
import { pathAuthorityPath, refsAuthorityPath, subgraphAuthorityPath } from "../cli/lib/authority/graph.mjs";
import { stringifyCanonicalYaml } from "../cli/lib/authority/source-yaml.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "nimicoding.mjs");
const fixture = path.join(packageRoot, "test", "fixtures", "authority", "graph");
const roots = [];

async function corpus() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimicoding-graph-"));
  roots.push(root);
  const target = path.join(root, "authority");
  await cp(fixture, target, { recursive: true });
  return { root, target, file: path.join(target, "graph-多.authority.yaml") };
}

async function runCli(cwd, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" }, maxBuffer: 16 * 1024 * 1024, timeout: 5_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const budgets = { maxUnits: 100, maxEdges: 100, maxBytes: 1_000_000 };
const relations = ["applies_to", "supersedes"];

function topology(graph) {
  const clone = structuredClone(graph);
  for (const node of clone.nodes) delete node.location;
  for (const edge of clone.edges) {
    delete edge.sourceLocation;
    delete edge.relationLocation;
    delete edge.targetLocation;
  }
  return clone;
}

after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("refs returns exact direct authored edges, relation filters, stable order, and portable SourceMap locations", async () => {
  const state = await corpus();
  const incoming = await refsAuthorityPath(state.target, "definition.target", { direction: "incoming", relations, ...budgets });
  assert.equal(incoming.ok, true, JSON.stringify(incoming.diagnostics));
  assert.equal(incoming.graph.format, "nimicoding.authority-graph/v1");
  assert.equal(incoming.graph.operation, "refs");
  assert.equal(incoming.graph.complete, true);
  assert.deepEqual(Object.keys(incoming.graph).sort(), ["format", "operation", "query", "complete", "nodes", "edges", "policy", "counts", "budgets"].sort());
  assert.deepEqual(incoming.graph.edges.map((edge) => [edge.source, edge.type, edge.target]), [
    ["rule.alpha", "applies_to", "definition.target"],
    ["rule.beta", "applies_to", "definition.target"],
    ["rule.direct", "applies_to", "definition.target"],
  ]);
  assert.deepEqual(incoming.graph.nodes.map((node) => node.id), ["definition.target", "rule.alpha", "rule.beta", "rule.direct"]);
  assert.deepEqual(Object.keys(incoming.graph.nodes[0]), ["id", "kind", "owner", "lifecycle", "scope", "location"]);
  assert.deepEqual(Object.keys(incoming.graph.edges[0]), ["source", "type", "target", "sourceLocation", "relationLocation", "targetLocation"]);
  assert.deepEqual(Object.keys(incoming.graph.nodes[0].location), ["file", "range", "sourcePointer"]);
  assert.deepEqual(incoming.graph.nodes.find((node) => node.id === "definition.target").scope, []);
  assert.deepEqual(incoming.graph.nodes.find((node) => node.id === "rule.alpha").scope, ["graph.alpha"]);
  for (const edge of incoming.graph.edges) {
    assert.equal(path.isAbsolute(edge.sourceLocation.file), false);
    assert.match(edge.sourceLocation.file, /graph-多\.authority\.yaml$/);
    assert.match(edge.sourceLocation.sourcePointer, /^\/units\/\d+\/id$/);
    assert.match(edge.relationLocation.sourcePointer, /^\/units\/\d+\/relations\/\d+\/target$/);
    assert.match(edge.targetLocation.sourcePointer, /^\/units\/\d+\/id$/);
    assert(edge.relationLocation.range.start.line > edge.sourceLocation.range.start.line);
  }

  const outgoing = await refsAuthorityPath(state.target, "rule.alpha", { direction: "outgoing", relations: ["applies_to"], ...budgets });
  assert.deepEqual(outgoing.graph.edges.map((edge) => edge.target), ["definition.hub", "definition.target"]);
  const both = await refsAuthorityPath(state.target, "definition.lineage-v1", { direction: "both", relations: ["supersedes"], ...budgets });
  assert.deepEqual(both.graph.edges.map((edge) => [edge.source, edge.target]), [
    ["definition.lineage", "definition.lineage-v1"],
    ["definition.lineage-v1", "definition.lineage-v0"],
  ]);
  assert.equal(new Set(both.graph.edges.map((edge) => `${edge.source}:${edge.type}:${edge.target}`)).size, both.graph.edges.length);
  const filtered = await refsAuthorityPath(state.target, "definition.lineage-v1", { direction: "both", relations: ["applies_to"], ...budgets });
  assert.equal(filtered.graph.edges.length, 0);
  const repeated = await refsAuthorityPath(state.target, "definition.target", { direction: "incoming", relations, ...budgets });
  assert.deepEqual(repeated.graph, incoming.graph);
});

test("path distinguishes directed and incidence traversal, returns shortest lexical witness, and proves complete no-path", async () => {
  const state = await corpus();
  const direct = await pathAuthorityPath(state.target, "rule.direct", "definition.target", { traversal: "directed", relations: ["applies_to"], maxHops: 2, ...budgets });
  assert.equal(direct.ok, true);
  assert.equal(direct.graph.found, true);
  assert.deepEqual(Object.keys(direct.graph).sort(), ["format", "operation", "query", "complete", "found", "steps", "nodes", "edges", "policy", "counts", "budgets"].sort());
  assert.deepEqual(direct.graph.steps, [{ source: "rule.direct", type: "applies_to", target: "definition.target", traversal: "forward" }]);

  const lineage = await pathAuthorityPath(state.target, "definition.lineage", "definition.lineage-v0", { traversal: "directed", relations: ["supersedes"], maxHops: 3, ...budgets });
  assert.deepEqual(lineage.graph.steps.map((step) => [step.source, step.target]), [
    ["definition.lineage", "definition.lineage-v1"],
    ["definition.lineage-v1", "definition.lineage-v0"],
  ]);

  const incidence = await pathAuthorityPath(state.target, "definition.hub", "definition.target", { traversal: "incidence", relations: ["applies_to"], maxHops: 3, ...budgets });
  assert.equal(incidence.graph.found, true);
  assert.deepEqual(incidence.graph.steps, [
    { source: "rule.alpha", type: "applies_to", target: "definition.hub", traversal: "reverse" },
    { source: "rule.alpha", type: "applies_to", target: "definition.target", traversal: "forward" },
  ]);
  assert.deepEqual(incidence.graph.edges.map((edge) => edge.source), ["rule.alpha", "rule.alpha"]);
  assert.match(incidence.graph.policy.reverseStepClaim, /incidence_only_not_semantic_dependency/);

  const noPath = await pathAuthorityPath(state.target, "definition.target", "definition.unrelated", { traversal: "directed", relations, maxHops: 4, ...budgets });
  assert.equal(noPath.ok, true);
  assert.equal(noPath.graph.found, false);
  assert.equal(noPath.graph.complete, true);
  assert.deepEqual(noPath.graph.steps, []);
  assert.deepEqual(noPath.graph.nodes.map((node) => node.id), ["definition.target", "definition.unrelated"]);

  const cycleSafe = await pathAuthorityPath(state.target, "definition.target", "definition.hub", { traversal: "incidence", relations: ["applies_to"], maxHops: 5, ...budgets });
  assert.equal(cycleSafe.ok, true);
  assert.equal(cycleSafe.graph.found, true);
  assert.equal(cycleSafe.graph.steps.length, 2);
});

test("path max-hops and traversal unit/edge budgets refuse instead of returning incomplete no-path", async () => {
  const state = await corpus();
  const maxHops = await pathAuthorityPath(state.target, "definition.hub", "definition.target", { traversal: "incidence", relations: ["applies_to"], maxHops: 1, ...budgets });
  assert.equal(maxHops.ok, false);
  assert.equal(maxHops.graph, null);
  assert.equal(maxHops.partial, false);
  assert.equal(maxHops.diagnostics[0].code, "AUTH_GRAPH_BUDGET");
  assert.match(maxHops.diagnostics[0].reason, /beyond max-hops 1/);

  const seed = await pathAuthorityPath(state.target, "definition.hub", "definition.target", { traversal: "incidence", relations: ["applies_to"], maxHops: 3, ...budgets });
  assert(seed.graph.counts.traversal.units > seed.graph.counts.returned.units);
  for (const constrained of [
    { ...budgets, maxUnits: seed.graph.counts.traversal.units - 1 },
    { ...budgets, maxEdges: seed.graph.counts.traversal.edges - 1 },
  ]) {
    const failed = await pathAuthorityPath(state.target, "definition.hub", "definition.target", { traversal: "incidence", relations: ["applies_to"], maxHops: 3, ...constrained });
    assert.equal(failed.ok, false);
    assert.equal(failed.graph, null);
    assert.equal(failed.diagnostics[0].code, "AUTH_GRAPH_BUDGET");
  }

  const exhausted = await runCli(state.root, ["authority", "path", state.target, "definition.unrelated", "definition.target", "--traversal", "directed", "--relations", "applies_to", "--max-hops", String(Number.MAX_SAFE_INTEGER), "--max-units", "2", "--max-edges", "1", "--max-bytes", "100000", "--json"]);
  assert.equal(exhausted.code, 0, exhausted.stderr);
  assert.equal(JSON.parse(exhausted.stdout).graph.found, false);
});

test("subgraph performs complete deterministic directional BFS with depth, duplicate suppression, and unrelated exclusion", async () => {
  const state = await corpus();
  const outgoing = await subgraphAuthorityPath(state.target, "rule.alpha", { direction: "outgoing", relations: ["applies_to"], depth: 1, ...budgets });
  assert.deepEqual(outgoing.graph.nodes.map((node) => node.id), ["definition.hub", "definition.target", "rule.alpha"]);
  assert.equal(outgoing.graph.edges.length, 2);

  const incoming = await subgraphAuthorityPath(state.target, "definition.target", { direction: "incoming", relations: ["applies_to"], depth: 1, ...budgets });
  assert.deepEqual(incoming.graph.nodes.map((node) => node.id), ["definition.target", "rule.alpha", "rule.beta", "rule.direct"]);

  const both = await subgraphAuthorityPath(state.target, "definition.hub", { direction: "both", relations: ["applies_to"], depth: 2, ...budgets });
  assert.deepEqual(both.graph.nodes.map((node) => node.id), ["definition.hub", "definition.target", "rule.alpha", "rule.beta"]);
  assert.equal(both.graph.edges.length, 4);
  assert(!both.graph.nodes.some((node) => node.id === "definition.unrelated"));
  assert.equal(new Set(both.graph.nodes.map((node) => node.id)).size, both.graph.nodes.length);
  assert.equal(new Set(both.graph.edges.map((edge) => `${edge.source}:${edge.type}:${edge.target}`)).size, both.graph.edges.length);

  const lineage = await subgraphAuthorityPath(state.target, "definition.lineage", { direction: "outgoing", relations: ["supersedes"], depth: 2, ...budgets });
  assert.deepEqual(lineage.graph.nodes.map((node) => node.id), ["definition.lineage", "definition.lineage-v0", "definition.lineage-v1"]);
});

test("all graph operations fail closed on unknown IDs, invalid corpus, and exact unit/edge/UTF-8 byte N-1 budgets", async () => {
  const state = await corpus();
  for (const run of [
    () => refsAuthorityPath(state.target, "definition.missing", { direction: "both", relations, ...budgets }),
    () => pathAuthorityPath(state.target, "definition.hub", "definition.missing", { traversal: "incidence", relations, maxHops: 3, ...budgets }),
    () => pathAuthorityPath(state.target, "definition.missing", "definition.hub", { traversal: "incidence", relations, maxHops: 3, ...budgets }),
    () => subgraphAuthorityPath(state.target, "definition.missing", { direction: "both", relations, depth: 2, ...budgets }),
  ]) {
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(result.graph, null);
    assert.equal(result.partial, false);
    assert.equal(result.diagnostics[0].code, "AUTH_QUERY_NOT_FOUND");
  }

  const source = await readFile(state.file, "utf8");
  await writeFile(state.file, source.replace("    meaning: A graph target.\n", "    unknown-a: one\n    unknown-b: two\n    meaning: A graph target.\n"), "utf8");
  const compiled = await compileAuthorityPath(state.target);
  const invalid = await refsAuthorityPath(state.target, "definition.target", { direction: "incoming", relations, ...budgets });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.graph, null);
  assert.equal(invalid.partial, false);
  assert.deepEqual(invalid.diagnostics, compiled.diagnostics);
  assert.equal(invalid.diagnostics.filter((entry) => entry.code === "AUTH_UNKNOWN_FIELD").length, 2);
  await writeFile(state.file, source, "utf8");

  const refsSeed = await refsAuthorityPath(state.target, "definition.target", { direction: "incoming", relations: ["applies_to"], ...budgets });
  for (const limits of [
    { ...budgets, maxUnits: refsSeed.graph.counts.traversal.units - 1 },
    { ...budgets, maxEdges: refsSeed.graph.counts.traversal.edges - 1 },
  ]) {
    const failed = await refsAuthorityPath(state.target, "definition.target", { direction: "incoming", relations: ["applies_to"], ...limits });
    assert.equal(failed.ok, false);
    assert.equal(failed.graph, null);
    assert.equal(failed.diagnostics[0].code, "AUTH_GRAPH_BUDGET");
  }

  async function assertExactByteBoundary(run) {
    let exactBudget = (await run(1_000_000)).graphBytes;
    let exact;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      exact = await run(exactBudget);
      assert.equal(exact.ok, true, JSON.stringify(exact.diagnostics));
      if (exact.graphBytes === exactBudget) break;
      exactBudget = exact.graphBytes;
    }
    assert.equal(exact.graphBytes, exactBudget);
    const serialized = JSON.stringify(exact.graph);
    assert.equal(Buffer.byteLength(serialized, "utf8"), exactBudget);
    assert.notEqual(serialized.length, exactBudget);
    const oneUnder = await run(exactBudget - 1);
    assert.equal(oneUnder.ok, false);
    assert.equal(oneUnder.graph, null);
    assert.equal(oneUnder.graphBytes, 0);
    assert.equal(oneUnder.diagnostics[0].code, "AUTH_GRAPH_BUDGET");
  }
  await assertExactByteBoundary((maxBytes) => refsAuthorityPath(state.target, "definition.target", { direction: "incoming", relations: ["applies_to"], ...budgets, maxBytes }));
  await assertExactByteBoundary((maxBytes) => pathAuthorityPath(state.target, "definition.hub", "definition.target", { traversal: "incidence", relations: ["applies_to"], maxHops: 3, ...budgets, maxBytes }));

  const run = (limits) => subgraphAuthorityPath(state.target, "definition.hub", { direction: "both", relations: ["applies_to"], depth: 2, ...limits });
  const seed = await run(budgets);
  assert.equal(seed.ok, true);
  for (const limits of [
    { ...budgets, maxUnits: seed.graph.counts.traversal.units - 1 },
    { ...budgets, maxEdges: seed.graph.counts.traversal.edges - 1 },
  ]) {
    const failed = await run(limits);
    assert.equal(failed.ok, false);
    assert.equal(failed.graph, null);
    assert.equal(failed.diagnostics[0].code, "AUTH_GRAPH_BUDGET");
  }

  await assertExactByteBoundary((maxBytes) => run({ ...budgets, maxBytes }));
});

test("logical topology is invariant to YAML source order, regrouping, relocation, and repeated evaluation", async () => {
  const first = await corpus();
  const second = await corpus();
  const baseline = await subgraphAuthorityPath(first.target, "definition.hub", { direction: "both", relations: ["applies_to"], depth: 2, ...budgets });
  const relocated = await subgraphAuthorityPath(second.target, "definition.hub", { direction: "both", relations: ["applies_to"], depth: 2, ...budgets });
  assert.deepEqual(relocated.graph, baseline.graph);

  const document = YAML.parse(await readFile(second.file, "utf8"));
  document.units.reverse();
  const moved = document.units.splice(0, 3);
  await writeFile(second.file, stringifyCanonicalYaml(document, { container: true }), "utf8");
  await writeFile(path.join(second.target, "regrouped.authority.yaml"), stringifyCanonicalYaml({ format: document.format, units: moved }, { container: true }), "utf8");
  const regrouped = await subgraphAuthorityPath(second.target, "definition.hub", { direction: "both", relations: ["applies_to"], depth: 2, ...budgets });
  assert.equal(regrouped.ok, true, JSON.stringify(regrouped.diagnostics));
  assert.deepEqual(topology(regrouped.graph), topology(baseline.graph));
  const repeated = await subgraphAuthorityPath(second.target, "definition.hub", { direction: "both", relations: ["applies_to"], depth: 2, ...budgets });
  assert.deepEqual(repeated.graph, regrouped.graph);
});

test("public CLI enforces exact graph shape, closed relations, positive safe integers, and null failure payloads", async () => {
  const state = await corpus();
  const base = [state.target, "definition.target", "--direction", "incoming", "--relations", "applies_to", "--max-units", "10", "--max-edges", "10", "--max-bytes", "100000", "--json"];
  const success = await runCli(state.root, ["authority", "refs", ...base]);
  assert.equal(success.code, 0, success.stderr);
  const report = JSON.parse(success.stdout);
  assert.equal(report.semantic_status, "completed");
  assert.equal(report.partial, false);
  assert.equal(report.graph.operation, "refs");

  const humanPath = await runCli(state.root, ["authority", "path", state.target, "definition.hub", "definition.target", "--traversal", "incidence", "--relations", "applies_to", "--max-hops", "3", "--max-units", "20", "--max-edges", "20", "--max-bytes", "100000"]);
  assert.equal(humanPath.code, 0, humanPath.stderr);
  assert.match(humanPath.stdout, /path found: true/);
  assert.match(humanPath.stdout, /1\. reverse authored rule\.alpha -\[applies_to\]-> definition\.hub/);
  assert.match(humanPath.stdout, /2\. forward authored rule\.alpha -\[applies_to\]-> definition\.target/);

  const humanNoPath = await runCli(state.root, ["authority", "path", state.target, "definition.target", "definition.unrelated", "--traversal", "directed", "--relations", "applies_to", "--max-hops", "4", "--max-units", "20", "--max-edges", "20", "--max-bytes", "100000"]);
  assert.equal(humanNoPath.code, 0, humanNoPath.stderr);
  assert.match(humanNoPath.stdout, /path found: false/);
  assert.match(humanNoPath.stdout, /path steps: 0/);

  for (const args of [
    ["authority", "refs", state.target, "definition.target", "--direction", "incoming", "--relations", "", "--max-units", "10", "--max-edges", "10", "--max-bytes", "100000"],
    ["authority", "refs", ...base, "--relations", "supersedes"],
    ["authority", "refs", ...base.slice(0, 5), "applies_to,applies_to", ...base.slice(6)],
    ["authority", "refs", ...base.slice(0, 5), "unknown", ...base.slice(6)],
    ["authority", "refs", ...base.slice(0, -3), "--max-units", "0", "--max-bytes", "100000"],
    ["authority", "path", state.target, "definition.hub", "definition.target", "--traversal", "incidence", "--relations", "applies_to", "--max-hops", "1.5", "--max-units", "10", "--max-edges", "10", "--max-bytes", "100000"],
    ["authority", "subgraph", state.target, "definition.hub", "extra", "--direction", "both", "--relations", "applies_to", "--depth", "2", "--max-units", "10", "--max-edges", "10", "--max-bytes", "100000"],
  ]) assert.equal((await runCli(state.root, args)).code, 2, args.join(" "));

  const failed = await runCli(state.root, ["authority", "refs", state.target, "definition.target", "--direction", "incoming", "--relations", "applies_to", "--max-units", "1", "--max-edges", "10", "--max-bytes", "100000", "--json"]);
  assert.equal(failed.code, 1);
  const refused = JSON.parse(failed.stdout);
  assert.equal(refused.semantic_status, "refused");
  assert.equal(refused.graph, null);
  assert.equal(refused.partial, false);
  assert.equal(refused.diagnostics[0].code, "AUTH_GRAPH_BUDGET");
});
