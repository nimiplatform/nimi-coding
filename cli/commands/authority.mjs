import { checkAuthorityPath, compileAuthorityPath } from "../lib/authority/compile.mjs";
import { diffAuthorityPaths } from "../lib/authority/diff.mjs";
import { discoverAuthorityPath } from "../lib/authority/discover.mjs";
import { AuthorityInputError, formatAuthorityFile } from "../lib/authority/format.mjs";
import { pathAuthorityPath, refsAuthorityPath, subgraphAuthorityPath } from "../lib/authority/graph.mjs";
import { impactAuthorityPaths } from "../lib/authority/impact.mjs";
import { contextAuthorityPath, queryAuthorityPath } from "../lib/authority/query.mjs";

const USAGE = [
  "nimicoding authority fmt <file> [--check] [--json]",
  "nimicoding authority check <path> [--json]",
  "nimicoding authority compile <path> [--json]",
  "nimicoding authority discover <path> <query> --max-candidates <positive-integer> --max-bytes <positive-integer> [--json]",
  "nimicoding authority query <path> <id> --max-bytes <positive-integer> [--json]",
  "nimicoding authority context <path> <id> --max-units <positive-integer> --max-bytes <positive-integer> [--json]",
  "nimicoding authority refs <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority path <path> <from-id> <to-id> --traversal <directed|incidence> --relations <comma-separated-relation-types> --max-hops <positive-safe-integer> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority subgraph <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --depth <positive-safe-integer> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority diff <before-path> <after-path> --max-bytes <positive-integer> [--json]",
  "nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <positive-integer> [--json]",
].join("\n");

function parseOptions(subcommand, args) {
  const options = { json: false, check: false, path: null, id: null, fromId: null, toId: null, query: null, beforePath: null, afterPath: null, dispositions: null, direction: null, traversal: null, relations: null, depth: null, maxHops: null, maxCandidates: null, maxUnits: null, maxEdges: null, maxBytes: null };
  const graphCommands = ["refs", "path", "subgraph"];
  const integerOptions = {
    "--max-candidates": ["maxCandidates", ["discover"]],
    "--max-units": ["maxUnits", ["context", ...graphCommands]],
    "--max-edges": ["maxEdges", graphCommands],
    "--max-bytes": ["maxBytes", ["discover", "query", "context", "diff", "impact", ...graphCommands]],
    "--max-hops": ["maxHops", ["path"]],
    "--depth": ["depth", ["subgraph"]],
  };
  const positionals = [];
  let terminated = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!terminated && arg === "--") {
      terminated = true;
      continue;
    }
    if (!terminated && arg.startsWith("--")) {
      if (arg === "--json" && !options.json) options.json = true;
      else if (arg === "--check" && subcommand === "fmt" && !options.check) options.check = true;
      else if (Object.hasOwn(integerOptions, arg)) {
        const [key, admitted] = integerOptions[arg];
        if (!admitted.includes(subcommand) || options[key] !== null) return { ok: false, error: `authority ${subcommand} refused unknown or repeated option: ${arg}` };
        const value = args[index + 1];
        if (!value || !/^[1-9][0-9]*$/.test(value)) return { ok: false, error: `authority ${subcommand} requires ${arg} followed by a positive integer` };
        options[key] = Number(value);
        if (!Number.isSafeInteger(options[key])) return { ok: false, error: `authority ${subcommand} ${arg.slice(2)} exceeds the supported integer range` };
        index += 1;
      } else if (arg === "--direction" && ["refs", "subgraph"].includes(subcommand) && options.direction === null) {
        const value = args[index + 1];
        if (!["incoming", "outgoing", "both"].includes(value)) return { ok: false, error: `authority ${subcommand} requires --direction incoming, outgoing, or both` };
        options.direction = value;
        index += 1;
      } else if (arg === "--traversal" && subcommand === "path" && options.traversal === null) {
        const value = args[index + 1];
        if (!["directed", "incidence"].includes(value)) return { ok: false, error: "authority path requires --traversal directed or incidence" };
        options.traversal = value;
        index += 1;
      } else if (arg === "--relations" && graphCommands.includes(subcommand) && options.relations === null) {
        const value = args[index + 1];
        const relations = value?.split(",") ?? [];
        if (relations.length === 0 || relations.some((entry) => entry.length === 0 || !["applies_to", "supersedes"].includes(entry)) || new Set(relations).size !== relations.length) {
          return { ok: false, error: `authority ${subcommand} requires a non-empty unique closed --relations set containing only applies_to or supersedes` };
        }
        options.relations = relations.sort();
        index += 1;
      } else if (arg === "--dispositions" && subcommand === "impact" && options.dispositions === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: "authority impact requires --dispositions followed by one file" };
        options.dispositions = value;
        index += 1;
      } else return { ok: false, error: `authority ${subcommand} refused unknown or repeated option: ${arg}` };
      continue;
    }
    positionals.push(arg);
  }
  const expected = subcommand === "path" ? 3 : ["discover", "query", "context", "refs", "subgraph", "diff", "impact"].includes(subcommand) ? 2 : 1;
  if (positionals.length !== expected) {
    const requirement = subcommand === "discover"
      ? "one path and one query"
      : ["diff", "impact"].includes(subcommand)
        ? "one before path and one after path"
        : subcommand === "path" ? "one path, one exact from ID, and one exact to ID" : expected === 1 ? "one path" : "one path and one exact ID";
    return { ok: false, error: `authority ${subcommand} requires exactly ${requirement}` };
  }
  if (["diff", "impact"].includes(subcommand)) [options.beforePath, options.afterPath] = positionals;
  else if (subcommand === "path") [options.path, options.fromId, options.toId] = positionals;
  else [options.path, options.id] = positionals;
  if (subcommand === "discover") {
    options.query = options.id;
    options.id = null;
  }
  if (subcommand === "discover" && options.maxCandidates === null) return { ok: false, error: "authority discover requires --max-candidates followed by a positive integer" };
  if (["context", ...graphCommands].includes(subcommand) && options.maxUnits === null) return { ok: false, error: `authority ${subcommand} requires --max-units followed by a positive integer` };
  if (graphCommands.includes(subcommand) && options.maxEdges === null) return { ok: false, error: `authority ${subcommand} requires --max-edges followed by a positive integer` };
  if (["discover", "query", "context", "diff", "impact", ...graphCommands].includes(subcommand) && options.maxBytes === null) return { ok: false, error: `authority ${subcommand} requires --max-bytes followed by a positive integer` };
  if (["refs", "subgraph"].includes(subcommand) && options.direction === null) return { ok: false, error: `authority ${subcommand} requires --direction` };
  if (subcommand === "path" && options.traversal === null) return { ok: false, error: "authority path requires --traversal" };
  if (graphCommands.includes(subcommand) && options.relations === null) return { ok: false, error: `authority ${subcommand} requires --relations` };
  if (subcommand === "path" && options.maxHops === null) return { ok: false, error: "authority path requires --max-hops followed by a positive integer" };
  if (subcommand === "subgraph" && options.depth === null) return { ok: false, error: "authority subgraph requires --depth followed by a positive integer" };
  if (subcommand === "impact" && options.dispositions === null) return { ok: false, error: "authority impact requires --dispositions followed by one file" };
  return { ok: true, options };
}

function humanDiagnostic(diagnostic) {
  const { line, column } = diagnostic.range.start;
  return `${diagnostic.path}:${line}:${column} [${diagnostic.code}] ${diagnostic.reason}\n  repair: ${diagnostic.repair}`;
}

function outputReport(report, json) {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`nimicoding authority ${report.operation}: ${report.ok ? "ok" : "failed"}\n`);
    process.stdout.write(`files: ${report.summary.files}; units: ${report.summary.units}; diagnostics: ${report.summary.diagnostics}\n`);
    if (report.changed !== undefined) process.stdout.write(`changed: ${report.changed}\n`);
    if (report.packet_bytes !== undefined) process.stdout.write(`packet bytes: ${report.packet_bytes}\n`);
    if (report.discovery_bytes !== undefined) process.stdout.write(`discovery bytes: ${report.discovery_bytes}\n`);
    if (report.payload_bytes !== undefined) process.stdout.write(`semantic payload bytes: ${report.payload_bytes}\n`);
    if (report.graph_bytes !== undefined) process.stdout.write(`graph bytes: ${report.graph_bytes}\n`);
    if (report.packet) {
      process.stdout.write(`root: ${report.packet.root}\n`);
      process.stdout.write(`context units: ${report.packet.units.map((unit) => unit.id).join(", ")}\n`);
    }
    if (report.discovery) process.stdout.write(`candidates: ${report.discovery.candidates.map((candidate) => candidate.id).join(", ")}\n`);
    if (report.diff) process.stdout.write(`semantic changes: ${report.diff.summary.changes}\n`);
    if (report.impact) process.stdout.write(`impacted units: ${report.impact.impactedUnits.map((unit) => unit.id).join(", ")}\n`);
    if (report.graph) {
      process.stdout.write(`graph complete: ${report.graph.complete}\n`);
      process.stdout.write(`graph nodes: ${report.graph.nodes.map((node) => node.id).join(", ")}\n`);
      process.stdout.write(`graph edges: ${report.graph.edges.length}\n`);
      for (const edge of report.graph.edges) process.stdout.write(`  ${edge.source} -[${edge.type}]-> ${edge.target}\n`);
      if (report.graph.operation === "path") {
        process.stdout.write(`path found: ${report.graph.found}\n`);
        process.stdout.write(`path steps: ${report.graph.steps.length}\n`);
        report.graph.steps.forEach((step, index) => {
          process.stdout.write(`  ${index + 1}. ${step.traversal} authored ${step.source} -[${step.type}]-> ${step.target}\n`);
        });
      }
    }
    for (const diagnostic of report.diagnostics) process.stdout.write(`${humanDiagnostic(diagnostic)}\n`);
  }
}

function makeReport(operation, result, semanticStatus, extra = {}) {
  return {
    operation,
    ok: result.ok,
    semantic_status: semanticStatus,
    ...extra,
    summary: {
      files: result.fileCount ?? 0,
      units: result.unitCount ?? 0,
      diagnostics: result.diagnostics.length,
    },
    diagnostics: result.diagnostics,
  };
}

export async function runAuthority(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    if (rest.length > 0) {
      process.stderr.write(`nimicoding authority help refused unexpected arguments\n`);
      return 2;
    }
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!["fmt", "check", "compile", "discover", "query", "context", "refs", "path", "subgraph", "diff", "impact"].includes(subcommand)) {
    process.stderr.write(`nimicoding authority refused unknown subcommand: ${subcommand}\n${USAGE}\n`);
    return 2;
  }
  const parsed = parseOptions(subcommand, rest);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  try {
    if (subcommand === "fmt") {
      const result = await formatAuthorityFile(parsed.options.path, { check: parsed.options.check });
      const report = makeReport("fmt", result, "not_evaluated", { changed: result.changed, check: parsed.options.check });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "check") {
      const result = await checkAuthorityPath(parsed.options.path);
      const report = makeReport("check", result, result.ok ? "valid" : "invalid");
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "compile") {
      const result = await compileAuthorityPath(parsed.options.path);
      const report = makeReport("compile", result, result.ok ? "valid" : "invalid");
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "discover") {
      const result = await discoverAuthorityPath(parsed.options.path, parsed.options.query, { maxCandidates: parsed.options.maxCandidates, maxBytes: parsed.options.maxBytes });
      const report = makeReport("discover", result, result.ok ? "valid" : "invalid", { discovery_bytes: result.discoveryBytes, discovery: result.discovery });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "query") {
      const result = await queryAuthorityPath(parsed.options.path, parsed.options.id, { maxBytes: parsed.options.maxBytes });
      const report = makeReport("query", result, result.ok ? "valid" : "invalid", { packet_bytes: result.packetBytes, packet: result.packet });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "context") {
      const result = await contextAuthorityPath(parsed.options.path, parsed.options.id, { maxUnits: parsed.options.maxUnits, maxBytes: parsed.options.maxBytes });
      const report = makeReport("context", result, result.ok ? "valid" : "invalid", { packet_bytes: result.packetBytes, packet: result.packet });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (["refs", "path", "subgraph"].includes(subcommand)) {
      const common = {
        relations: parsed.options.relations,
        maxUnits: parsed.options.maxUnits,
        maxEdges: parsed.options.maxEdges,
        maxBytes: parsed.options.maxBytes,
      };
      const result = subcommand === "refs"
        ? await refsAuthorityPath(parsed.options.path, parsed.options.id, { ...common, direction: parsed.options.direction })
        : subcommand === "path"
          ? await pathAuthorityPath(parsed.options.path, parsed.options.fromId, parsed.options.toId, { ...common, traversal: parsed.options.traversal, maxHops: parsed.options.maxHops })
          : await subgraphAuthorityPath(parsed.options.path, parsed.options.id, { ...common, direction: parsed.options.direction, depth: parsed.options.depth });
      const report = makeReport(subcommand, result, result.ok ? "completed" : "refused", { graph_bytes: result.graphBytes, graph: result.graph, partial: result.partial });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "diff") {
      const result = await diffAuthorityPaths(parsed.options.beforePath, parsed.options.afterPath, { maxBytes: parsed.options.maxBytes });
      const report = makeReport("diff", result, result.ok ? "valid" : "invalid", { payload_bytes: result.payloadBytes, diff: result.diff });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    const result = await impactAuthorityPaths(parsed.options.beforePath, parsed.options.afterPath, parsed.options.dispositions, { maxBytes: parsed.options.maxBytes });
    const report = makeReport("impact", result, result.ok ? "valid" : "invalid", { payload_bytes: result.payloadBytes, diff: result.diff, impact: result.impact });
    outputReport(report, parsed.options.json);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof AuthorityInputError ? error.message : `authority ${subcommand} could not evaluate input: ${error.message}`;
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

export { parseOptions };
