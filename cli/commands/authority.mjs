import { VERSION } from "../constants.mjs";
import { anchorsAuthorityRepository, AUTHORITY_ANCHOR_GRAMMAR_HELP } from "../lib/authority/anchors.mjs";
import { auditAuthorityPath } from "../lib/authority/audit.mjs";
import { checkAuthorityPath, compileAuthorityPath } from "../lib/authority/compile.mjs";
import { diffAuthorityPaths } from "../lib/authority/diff.mjs";
import { discoverAuthorityPath } from "../lib/authority/discover.mjs";
import { evidenceAuthorityRepository } from "../lib/authority/evidence.mjs";
import { AuthorityInputError, formatAuthorityFile } from "../lib/authority/format.mjs";
import { pathAuthorityPath, refsAuthorityPath, subgraphAuthorityPath } from "../lib/authority/graph.mjs";
import { impactAuthorityPaths } from "../lib/authority/impact.mjs";
import { contextAuthorityPath, queryAuthorityPath } from "../lib/authority/query.mjs";
import { reviewAuthorityRepository } from "../lib/authority/review.mjs";
import { authorityAuditResultToSarif } from "../lib/authority/sarif.mjs";

const USAGE = [
  "nimicoding authority fmt <file> [--check] [--json]",
  "nimicoding authority check <path> [--scope-bindings <file>] [--json]",
  "nimicoding authority compile <path> [--json]",
  "nimicoding authority anchors <repository-path> --spec <corpus-path> [--scope-bindings <file>] --max-units <positive-safe-integer> --max-anchors <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority discover <path> <query> [--kind <definition|rule>] [--owner <exact-owner>] [--scope <exact-scope>] [--lifecycle <active|removed>] --max-candidates <positive-safe-integer> --max-snippet-terms <positive-safe-integer> --max-bytes <positive-safe-integer> [--preview-direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-edges <positive-safe-integer>] [--json]",
  "nimicoding authority query <path> <id> --max-bytes <positive-integer> [--json]",
  "nimicoding authority context <path> <id> --max-units <positive-integer> --max-bytes <positive-integer> [--json]",
  "nimicoding authority refs <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority path <path> <from-id> <to-id> --traversal <directed|incidence> --relations <comma-separated-relation-types> --max-hops <positive-safe-integer> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority subgraph <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --depth <positive-safe-integer> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority audit <path> --bindings <file> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json|--sarif]",
  "nimicoding authority diff <before-path> <after-path> --max-bytes <positive-integer> [--json]",
  "nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <positive-integer> [--json]",
  "nimicoding authority review <repository-path> --base <git-ref> --bindings <file> --dispositions <file> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "nimicoding authority evidence <repository-path> --bindings <tracked-.nimi/config-path> [--probe-results <.nimi/local-path>] --max-units <positive-safe-integer> --max-bindings <positive-safe-integer> --max-locators <positive-safe-integer> --max-edges <positive-safe-integer> --max-input-bytes <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
  "",
  AUTHORITY_ANCHOR_GRAMMAR_HELP,
].join("\n");

const AUTHORITY_IDENTIFIER = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)+$/;

function parseOptions(subcommand, args) {
  const options = { json: false, sarif: false, check: false, path: null, repositoryPath: null, spec: null, base: null, id: null, fromId: null, toId: null, query: null, beforePath: null, afterPath: null, dispositions: null, bindings: null, scopeBindings: null, probeResults: null, kind: null, owner: null, scope: null, lifecycle: null, direction: null, previewDirection: null, traversal: null, relations: null, depth: null, maxHops: null, maxCandidates: null, maxSnippetTerms: null, maxUnits: null, maxAnchors: null, maxBindings: null, maxLocators: null, maxEdges: null, maxInputBytes: null, maxBytes: null };
  const graphCommands = ["refs", "path", "subgraph"];
  const integerOptions = {
    "--max-candidates": ["maxCandidates", ["discover"]],
    "--max-snippet-terms": ["maxSnippetTerms", ["discover"]],
    "--max-units": ["maxUnits", ["context", "audit", "review", "evidence", "anchors", ...graphCommands]],
    "--max-anchors": ["maxAnchors", ["anchors"]],
    "--max-bindings": ["maxBindings", ["evidence"]],
    "--max-locators": ["maxLocators", ["evidence"]],
    "--max-edges": ["maxEdges", ["audit", "review", "evidence", "discover", ...graphCommands]],
    "--max-input-bytes": ["maxInputBytes", ["evidence"]],
    "--max-bytes": ["maxBytes", ["discover", "query", "context", "audit", "diff", "impact", "review", "evidence", "anchors", ...graphCommands]],
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
      if (arg === "--json" && !options.json) {
        if (options.sarif) return { ok: false, error: "authority audit requires --json and --sarif to be mutually exclusive" };
        options.json = true;
      } else if (arg === "--sarif" && subcommand === "audit" && !options.sarif) {
        if (options.json) return { ok: false, error: "authority audit requires --json and --sarif to be mutually exclusive" };
        options.sarif = true;
      } else if (arg === "--check" && subcommand === "fmt" && !options.check) options.check = true;
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
      } else if (arg === "--preview-direction" && subcommand === "discover" && options.previewDirection === null) {
        const value = args[index + 1];
        if (!["incoming", "outgoing", "both"].includes(value)) return { ok: false, error: "authority discover requires --preview-direction incoming, outgoing, or both" };
        options.previewDirection = value;
        index += 1;
      } else if (arg === "--kind" && subcommand === "discover" && options.kind === null) {
        const value = args[index + 1];
        if (!["definition", "rule"].includes(value)) return { ok: false, error: "authority discover requires --kind definition or rule" };
        options.kind = value;
        index += 1;
      } else if (["--owner", "--scope"].includes(arg) && subcommand === "discover" && options[arg.slice(2)] === null) {
        const value = args[index + 1];
        if (!value || !AUTHORITY_IDENTIFIER.test(value)) return { ok: false, error: `authority discover requires ${arg} followed by one exact dotted lowercase identifier` };
        options[arg.slice(2)] = value;
        index += 1;
      } else if (arg === "--lifecycle" && subcommand === "discover" && options.lifecycle === null) {
        const value = args[index + 1];
        if (!["active", "removed"].includes(value)) return { ok: false, error: "authority discover requires --lifecycle active or removed" };
        options.lifecycle = value;
        index += 1;
      } else if (arg === "--traversal" && subcommand === "path" && options.traversal === null) {
        const value = args[index + 1];
        if (!["directed", "incidence"].includes(value)) return { ok: false, error: "authority path requires --traversal directed or incidence" };
        options.traversal = value;
        index += 1;
      } else if (arg === "--relations" && [...graphCommands, "discover"].includes(subcommand) && options.relations === null) {
        const value = args[index + 1];
        const relations = value?.split(",") ?? [];
        if (relations.length === 0 || relations.some((entry) => entry.length === 0 || !["applies_to", "supersedes"].includes(entry)) || new Set(relations).size !== relations.length) {
          return { ok: false, error: `authority ${subcommand} requires a non-empty unique closed --relations set containing only applies_to or supersedes` };
        }
        options.relations = relations.sort();
        index += 1;
      } else if (arg === "--dispositions" && ["impact", "review"].includes(subcommand) && options.dispositions === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: `authority ${subcommand} requires --dispositions followed by one file` };
        options.dispositions = value;
        index += 1;
      } else if (arg === "--bindings" && ["audit", "review", "evidence"].includes(subcommand) && options.bindings === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: `authority ${subcommand} requires --bindings followed by one file` };
        options.bindings = value;
        index += 1;
      } else if (arg === "--scope-bindings" && ["check", "anchors"].includes(subcommand) && options.scopeBindings === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: `authority ${subcommand} requires --scope-bindings followed by one file` };
        options.scopeBindings = value;
        index += 1;
      } else if (arg === "--spec" && subcommand === "anchors" && options.spec === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: "authority anchors requires --spec followed by one corpus path" };
        options.spec = value;
        index += 1;
      } else if (arg === "--probe-results" && subcommand === "evidence" && options.probeResults === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: "authority evidence requires --probe-results followed by one repository-relative file" };
        options.probeResults = value;
        index += 1;
      } else if (arg === "--base" && subcommand === "review" && options.base === null) {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) return { ok: false, error: "authority review requires --base followed by one non-option Git ref" };
        options.base = value;
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
        : subcommand === "path" ? "one path, one exact from ID, and one exact to ID" : ["review", "evidence", "anchors"].includes(subcommand) ? "one repository path" : expected === 1 ? "one path" : "one path and one exact ID";
    return { ok: false, error: `authority ${subcommand} requires exactly ${requirement}` };
  }
  if (["diff", "impact"].includes(subcommand)) [options.beforePath, options.afterPath] = positionals;
  else if (["review", "evidence", "anchors"].includes(subcommand)) [options.repositoryPath] = positionals;
  else if (subcommand === "path") [options.path, options.fromId, options.toId] = positionals;
  else [options.path, options.id] = positionals;
  if (subcommand === "discover") {
    options.query = options.id;
    options.id = null;
  }
  if (subcommand === "discover" && options.maxCandidates === null) return { ok: false, error: "authority discover requires --max-candidates followed by a positive integer" };
  if (subcommand === "discover" && options.maxSnippetTerms === null) return { ok: false, error: "authority discover requires --max-snippet-terms followed by a positive integer" };
  if (subcommand === "discover") {
    const previewOptions = [options.previewDirection, options.relations, options.maxEdges];
    const provided = previewOptions.filter((value) => value !== null).length;
    if (provided !== 0 && provided !== previewOptions.length) return { ok: false, error: "authority discover requires --preview-direction, --relations, and --max-edges together" };
  }
  if (["context", "anchors", ...graphCommands].includes(subcommand) && options.maxUnits === null) return { ok: false, error: `authority ${subcommand} requires --max-units followed by a positive integer` };
  if (graphCommands.includes(subcommand) && options.maxEdges === null) return { ok: false, error: `authority ${subcommand} requires --max-edges followed by a positive integer` };
  if (["discover", "query", "context", "audit", "diff", "impact", "review", "evidence", "anchors", ...graphCommands].includes(subcommand) && options.maxBytes === null) return { ok: false, error: `authority ${subcommand} requires --max-bytes followed by a positive integer` };
  if (["refs", "subgraph"].includes(subcommand) && options.direction === null) return { ok: false, error: `authority ${subcommand} requires --direction` };
  if (subcommand === "path" && options.traversal === null) return { ok: false, error: "authority path requires --traversal" };
  if (graphCommands.includes(subcommand) && options.relations === null) return { ok: false, error: `authority ${subcommand} requires --relations` };
  if (subcommand === "path" && options.maxHops === null) return { ok: false, error: "authority path requires --max-hops followed by a positive integer" };
  if (subcommand === "subgraph" && options.depth === null) return { ok: false, error: "authority subgraph requires --depth followed by a positive integer" };
  if (subcommand === "impact" && options.dispositions === null) return { ok: false, error: "authority impact requires --dispositions followed by one file" };
  if (subcommand === "audit" && options.bindings === null) return { ok: false, error: "authority audit requires --bindings followed by one file" };
  if (subcommand === "audit" && options.maxUnits === null) return { ok: false, error: "authority audit requires --max-units followed by a positive integer" };
  if (subcommand === "audit" && options.maxEdges === null) return { ok: false, error: "authority audit requires --max-edges followed by a positive integer" };
  if (subcommand === "review" && options.base === null) return { ok: false, error: "authority review requires --base followed by one Git ref" };
  if (subcommand === "review" && options.bindings === null) return { ok: false, error: "authority review requires --bindings followed by one file" };
  if (subcommand === "review" && options.dispositions === null) return { ok: false, error: "authority review requires --dispositions followed by one file" };
  if (subcommand === "review" && options.maxUnits === null) return { ok: false, error: "authority review requires --max-units followed by a positive integer" };
  if (subcommand === "review" && options.maxEdges === null) return { ok: false, error: "authority review requires --max-edges followed by a positive integer" };
  if (subcommand === "evidence" && options.bindings === null) return { ok: false, error: "authority evidence requires --bindings followed by one repository-relative file" };
  if (subcommand === "evidence" && options.maxUnits === null) return { ok: false, error: "authority evidence requires --max-units followed by a positive integer" };
  if (subcommand === "evidence" && options.maxBindings === null) return { ok: false, error: "authority evidence requires --max-bindings followed by a positive integer" };
  if (subcommand === "evidence" && options.maxLocators === null) return { ok: false, error: "authority evidence requires --max-locators followed by a positive integer" };
  if (subcommand === "evidence" && options.maxEdges === null) return { ok: false, error: "authority evidence requires --max-edges followed by a positive integer" };
  if (subcommand === "evidence" && options.maxInputBytes === null) return { ok: false, error: "authority evidence requires --max-input-bytes followed by a positive integer" };
  if (subcommand === "anchors" && options.spec === null) return { ok: false, error: "authority anchors requires --spec followed by one corpus path" };
  if (subcommand === "anchors" && options.maxAnchors === null) return { ok: false, error: "authority anchors requires --max-anchors followed by a positive integer" };
  return { ok: true, options };
}

function humanDiagnostic(diagnostic) {
  const { line, column } = diagnostic.range.start;
  return `${diagnostic.path}:${line}:${column} [${diagnostic.code}] ${diagnostic.reason}\n  repair: ${diagnostic.repair}`;
}

function humanAuditLocation(location) {
  const { line, column } = location.range.start;
  return `${location.file}:${line}:${column}`;
}

function formatAuditHuman(report) {
  const audit = report.audit;
  const operationStatus = audit?.operationStatus ?? report.semantic_status;
  const policyStatus = audit?.policyStatus ?? "indeterminate";
  const complete = audit?.complete ?? false;
  const lines = [
    `nimicoding authority audit: operation=${operationStatus}; policy=${policyStatus}; complete=${complete}`,
    `files: ${report.summary.files}; units: ${report.summary.units}; diagnostics: ${report.summary.diagnostics}`,
    `audit bytes: ${report.audit_bytes}`,
  ];
  if (audit) {
    lines.push(`bindings: required=${audit.counts.bindings.required}; configured=${audit.counts.bindings.configured}; evaluated=${audit.counts.bindings.evaluated}`);
    lines.push(`returned: observations=${audit.counts.returned.observations}; findings=${audit.counts.returned.findings}; gaps=${audit.counts.returned.gaps}`);
    lines.push(`traversal: units=${audit.counts.traversal.units}; edges=${audit.counts.traversal.edges}`);
    for (const finding of audit.findings) lines.push(`finding ${finding.code} ${finding.fingerprint} at ${humanAuditLocation(finding.primaryLocation)}: ${finding.message}`);
    for (const gap of audit.gaps) lines.push(`gap ${gap.code} ${gap.fingerprint} at ${humanAuditLocation(gap.primaryLocation)}: ${gap.message}`);
  } else lines.push("counts: unavailable (audit refused before evaluation)");
  for (const diagnostic of report.diagnostics) lines.push(humanDiagnostic(diagnostic));
  return `${lines.join("\n")}\n`;
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
    if (report.discovery) {
      process.stdout.write(`eligible units: ${report.discovery.counts.eligibleUnits}; lexical matches: ${report.discovery.counts.matchedUnits}; returned candidates: ${report.discovery.counts.returnedCandidates}\n`);
      process.stdout.write(`candidates: ${report.discovery.candidates.map((candidate) => candidate.id).join(", ")}\n`);
      if (report.discovery.relationPreview) process.stdout.write(`relation preview: units=${report.discovery.relationPreview.counts.units}; edges=${report.discovery.relationPreview.counts.edges}; complete=${report.discovery.relationPreview.complete}\n`);
    }
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

function outputAuditReport(report, output) {
  if (output === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatAuditHuman(report));
}

function formatReviewHuman(report) {
  const review = report.review;
  const lines = [
    `nimicoding authority review: operation=${review?.operationStatus ?? "refused"}; policy=${review?.policyStatus ?? "indeterminate"}; complete=${review?.complete ?? false}`,
  ];
  if (review) {
    const base = review.snapshots.base;
    const worktree = review.snapshots.worktree;
    const unresolved = review.impact.obligations.filter((obligation) => obligation.disposition === null).length;
    lines.push(`base: commit=${base.commitOid}; identity=${base.contentIdentity}; files=${base.counts.files}; units=${base.counts.units}`);
    lines.push(`worktree: identity=${worktree.contentIdentity}; files=${worktree.counts.files}; units=${worktree.counts.units}`);
    lines.push(`semantic changes: ${review.diff.summary.changes}; impacted units: ${review.impact.impactedUnits.length}; unresolved obligations: ${unresolved}`);
    lines.push(`current audit: policy=${review.audit.policyStatus}; findings=${review.audit.findings.length}; gaps=${review.audit.gaps.length}`);
    lines.push(`review bytes: ${report.review_bytes}`);
    for (const finding of review.audit.findings) lines.push(`finding ${finding.code} ${finding.fingerprint} at ${humanAuditLocation(finding.primaryLocation)}: ${finding.message}`);
    for (const gap of review.audit.gaps) lines.push(`gap ${gap.code} ${gap.fingerprint} at ${humanAuditLocation(gap.primaryLocation)}: ${gap.message}`);
  } else {
    lines.push("review unavailable; partial=false");
  }
  for (const diagnostic of report.diagnostics) lines.push(humanDiagnostic(diagnostic));
  return `${lines.join("\n")}\n`;
}

function outputReviewReport(report, json) {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatReviewHuman(report));
}

function formatEvidenceHuman(report) {
  const evidence = report.evidence;
  const lines = [
    `nimicoding authority evidence: operation=${evidence?.operationStatus ?? "refused"}; evidence=${evidence?.evidenceStatus ?? "indeterminate"}; complete=${evidence?.complete ?? false}; conformance=${evidence?.conformanceStatus ?? "not_evaluated"}`,
  ];
  if (evidence) {
    lines.push(`snapshot: head=${evidence.identities.headCommitOid}; authority=${evidence.identities.authorityContentIdentity}; repository-input=${evidence.identities.repositoryInputIdentity}`);
    lines.push(`bindings: required=${evidence.counts.bindings.required}; configured=${evidence.counts.bindings.configured}; evaluated=${evidence.counts.bindings.evaluated}`);
    lines.push(`returned: observations=${evidence.counts.returned.observations}; findings=${evidence.counts.returned.findings}; gaps=${evidence.counts.returned.gaps}`);
    lines.push(`evidence bytes: ${report.evidence_bytes}`);
    for (const binding of evidence.bindings) {
      lines.push(`binding ${binding.id}: required=${binding.required}; reachability=${binding.packageProbe.reachability}; execution=${binding.packageProbe.execution}; conformance=${binding.packageProbe.conformance}`);
      if (binding.externalProbe) lines.push(`  external ${binding.externalProbe.id}@${binding.externalProbe.version}: ${binding.externalProbe.status}${binding.externalProbe.reportedOutcome ? `/${binding.externalProbe.reportedOutcome}` : ""}; package-attestation=false`);
    }
    for (const finding of evidence.findings) lines.push(`finding ${finding.code} ${finding.fingerprint} at ${humanAuditLocation(finding.primaryLocation)}: ${finding.message}`);
    for (const gap of evidence.gaps) lines.push(`gap ${gap.code} ${gap.fingerprint} at ${humanAuditLocation(gap.primaryLocation)}: ${gap.message}`);
  } else lines.push("evidence unavailable; partial=false");
  for (const diagnostic of report.diagnostics) lines.push(humanDiagnostic(diagnostic));
  return `${lines.join("\n")}\n`;
}

function outputEvidenceReport(report, json) {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatEvidenceHuman(report));
}

function outputAnchorsReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`nimicoding authority anchors: ${report.semantic_status}; complete=${report.complete}\n`);
  process.stdout.write(`units: ${report.summary.units}; anchors checked: ${report.summary.anchorsChecked}; diagnostics: ${report.summary.diagnostics}\n`);
  process.stdout.write(`anchor bytes: ${report.anchors_bytes}\n`);
  for (const diagnostic of report.diagnostics) process.stdout.write(`${humanDiagnostic(diagnostic)}\n`);
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
  if (!["fmt", "check", "compile", "anchors", "discover", "query", "context", "refs", "path", "subgraph", "audit", "diff", "impact", "review", "evidence"].includes(subcommand)) {
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
      const result = await checkAuthorityPath(parsed.options.path, { scopeBindings: parsed.options.scopeBindings });
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
      const result = await discoverAuthorityPath(parsed.options.path, parsed.options.query, {
        maxCandidates: parsed.options.maxCandidates,
        maxSnippetTerms: parsed.options.maxSnippetTerms,
        maxBytes: parsed.options.maxBytes,
        kind: parsed.options.kind,
        owner: parsed.options.owner,
        scope: parsed.options.scope,
        lifecycle: parsed.options.lifecycle,
        previewDirection: parsed.options.previewDirection,
        relations: parsed.options.relations,
        maxEdges: parsed.options.maxEdges,
      });
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
    if (subcommand === "audit") {
      const result = await auditAuthorityPath(parsed.options.path, parsed.options.bindings, {
        maxUnits: parsed.options.maxUnits,
        maxEdges: parsed.options.maxEdges,
        maxBytes: parsed.options.maxBytes,
      });
      if (parsed.options.sarif) process.stdout.write(`${JSON.stringify(authorityAuditResultToSarif(result, { toolVersion: VERSION }), null, 2)}\n`);
      else {
        const report = makeReport("audit", result, result.audit?.operationStatus ?? "refused", {
          audit_bytes: result.auditBytes,
          audit: result.audit,
          partial: result.partial,
        });
        outputAuditReport(report, parsed.options.json ? "json" : "human");
      }
      return result.audit?.operationStatus === "completed" && result.audit.policyStatus === "passed" ? 0 : 1;
    }
    if (subcommand === "diff") {
      const result = await diffAuthorityPaths(parsed.options.beforePath, parsed.options.afterPath, { maxBytes: parsed.options.maxBytes });
      const report = makeReport("diff", result, result.ok ? "valid" : "invalid", { payload_bytes: result.payloadBytes, diff: result.diff });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "impact") {
      const result = await impactAuthorityPaths(parsed.options.beforePath, parsed.options.afterPath, parsed.options.dispositions, { maxBytes: parsed.options.maxBytes });
      const report = makeReport("impact", result, result.ok ? "valid" : "invalid", { payload_bytes: result.payloadBytes, diff: result.diff, impact: result.impact });
      outputReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "anchors") {
      const result = await anchorsAuthorityRepository(
        parsed.options.repositoryPath,
        parsed.options.spec,
        parsed.options.scopeBindings,
        {
          maxUnits: parsed.options.maxUnits,
          maxAnchors: parsed.options.maxAnchors,
          maxBytes: parsed.options.maxBytes,
        },
      );
      const report = {
        operation: "anchors",
        ok: result.ok,
        semantic_status: result.complete ? result.ok ? "valid" : "invalid" : "refused",
        complete: result.complete,
        partial: result.partial,
        anchors_bytes: result.anchorsBytes,
        summary: {
          units: result.unitCount,
          anchorsChecked: result.anchorsChecked,
          diagnostics: result.diagnostics.length,
        },
        diagnostics: result.diagnostics,
      };
      outputAnchorsReport(report, parsed.options.json);
      return result.ok ? 0 : 1;
    }
    if (subcommand === "evidence") {
      const result = await evidenceAuthorityRepository(
        parsed.options.repositoryPath,
        parsed.options.bindings,
        parsed.options.probeResults,
        {
          maxUnits: parsed.options.maxUnits,
          maxBindings: parsed.options.maxBindings,
          maxLocators: parsed.options.maxLocators,
          maxEdges: parsed.options.maxEdges,
          maxInputBytes: parsed.options.maxInputBytes,
          maxBytes: parsed.options.maxBytes,
        },
      );
      const report = makeReport("evidence", result, result.evidence?.operationStatus ?? "refused", {
        evidence_bytes: result.evidenceBytes,
        evidence: result.evidence,
        partial: result.partial,
      });
      outputEvidenceReport(report, parsed.options.json);
      return result.evidence?.complete && result.evidence.evidenceStatus === "available" ? 0 : 1;
    }
    const result = await reviewAuthorityRepository(
      parsed.options.repositoryPath,
      parsed.options.base,
      parsed.options.bindings,
      parsed.options.dispositions,
      { maxUnits: parsed.options.maxUnits, maxEdges: parsed.options.maxEdges, maxBytes: parsed.options.maxBytes },
    );
    const report = makeReport("review", result, result.review?.operationStatus ?? "refused", {
      review_bytes: result.reviewBytes,
      review: result.review,
      partial: result.partial,
    });
    outputReviewReport(report, parsed.options.json);
    return result.review?.complete && result.review.policyStatus === "passed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof AuthorityInputError ? error.message : `authority ${subcommand} could not evaluate input: ${error.message}`;
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

export { parseOptions };
