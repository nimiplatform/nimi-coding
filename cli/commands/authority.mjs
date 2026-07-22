import { checkAuthorityPath, compileAuthorityPath } from "../lib/authority/compile.mjs";
import { diffAuthorityPaths } from "../lib/authority/diff.mjs";
import { discoverAuthorityPath } from "../lib/authority/discover.mjs";
import { AuthorityInputError, formatAuthorityFile } from "../lib/authority/format.mjs";
import { impactAuthorityPaths } from "../lib/authority/impact.mjs";
import { contextAuthorityPath, queryAuthorityPath } from "../lib/authority/query.mjs";

const USAGE = [
  "nimicoding authority fmt <file> [--check] [--json]",
  "nimicoding authority check <path> [--json]",
  "nimicoding authority compile <path> [--json]",
  "nimicoding authority discover <path> <query> --max-candidates <positive-integer> --max-bytes <positive-integer> [--json]",
  "nimicoding authority query <path> <id> --max-bytes <positive-integer> [--json]",
  "nimicoding authority context <path> <id> --max-units <positive-integer> --max-bytes <positive-integer> [--json]",
  "nimicoding authority diff <before-path> <after-path> --max-bytes <positive-integer> [--json]",
  "nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <positive-integer> [--json]",
].join("\n");

function parseOptions(subcommand, args) {
  const options = { json: false, check: false, path: null, id: null, query: null, beforePath: null, afterPath: null, dispositions: null, maxCandidates: null, maxUnits: null, maxBytes: null };
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
      else if (arg === "--max-candidates" && subcommand === "discover" && options.maxCandidates === null) {
        const value = args[index + 1];
        if (!value || !/^[1-9][0-9]*$/.test(value)) return { ok: false, error: "authority discover requires --max-candidates followed by a positive integer" };
        options.maxCandidates = Number(value);
        if (!Number.isSafeInteger(options.maxCandidates)) return { ok: false, error: "authority discover max-candidates exceeds the supported integer range" };
        index += 1;
      } else if (arg === "--max-units" && subcommand === "context" && options.maxUnits === null) {
        const value = args[index + 1];
        if (!value || !/^[1-9][0-9]*$/.test(value)) return { ok: false, error: "authority context requires --max-units followed by a positive integer" };
        options.maxUnits = Number(value);
        if (!Number.isSafeInteger(options.maxUnits)) return { ok: false, error: "authority context max-units exceeds the supported integer range" };
        index += 1;
      } else if (arg === "--max-bytes" && ["discover", "query", "context", "diff", "impact"].includes(subcommand) && options.maxBytes === null) {
        const value = args[index + 1];
        if (!value || !/^[1-9][0-9]*$/.test(value)) return { ok: false, error: `authority ${subcommand} requires --max-bytes followed by a positive integer` };
        options.maxBytes = Number(value);
        if (!Number.isSafeInteger(options.maxBytes)) return { ok: false, error: `authority ${subcommand} max-bytes exceeds the supported integer range` };
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
  const paired = ["discover", "query", "context", "diff", "impact"].includes(subcommand);
  const expected = paired ? 2 : 1;
  if (positionals.length !== expected) {
    const requirement = subcommand === "discover"
      ? "one path and one query"
      : ["diff", "impact"].includes(subcommand)
        ? "one before path and one after path"
        : expected === 1 ? "one path" : "one path and one exact ID";
    return { ok: false, error: `authority ${subcommand} requires exactly ${requirement}` };
  }
  if (["diff", "impact"].includes(subcommand)) [options.beforePath, options.afterPath] = positionals;
  else [options.path, options.id] = positionals;
  if (subcommand === "discover") {
    options.query = options.id;
    options.id = null;
  }
  if (subcommand === "discover" && options.maxCandidates === null) return { ok: false, error: "authority discover requires --max-candidates followed by a positive integer" };
  if (subcommand === "context" && options.maxUnits === null) return { ok: false, error: "authority context requires --max-units followed by a positive integer" };
  if (["discover", "query", "context", "diff", "impact"].includes(subcommand) && options.maxBytes === null) return { ok: false, error: `authority ${subcommand} requires --max-bytes followed by a positive integer` };
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
    if (report.packet) {
      process.stdout.write(`root: ${report.packet.root}\n`);
      process.stdout.write(`context units: ${report.packet.units.map((unit) => unit.id).join(", ")}\n`);
    }
    if (report.discovery) process.stdout.write(`candidates: ${report.discovery.candidates.map((candidate) => candidate.id).join(", ")}\n`);
    if (report.diff) process.stdout.write(`semantic changes: ${report.diff.summary.changes}\n`);
    if (report.impact) process.stdout.write(`impacted units: ${report.impact.impactedUnits.map((unit) => unit.id).join(", ")}\n`);
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
  if (!["fmt", "check", "compile", "discover", "query", "context", "diff", "impact"].includes(subcommand)) {
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
