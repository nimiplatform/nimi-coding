import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  appendRunEvent,
  artifactPath,
  artifactRef,
  chunkRef,
  ensureIsoTimestamp,
  inputError,
  loadChunk,
  loadPlan,
  packetRef,
  resolveInsideProject,
  safeSweepId,
  withAuditSweepMutationLock,
  writeYamlRef,
} from "./common.mjs";
import { buildAuditorPacket, reviewAuditSweepChunk, updatePlanChunk } from "./chunks.mjs";
import { extractCodexAuditorEvidenceFile, P0P1_RULE_CHECK_IDS } from "./codex-auditor-evidence.mjs";
import { ingestAuditSweepChunk } from "./ingest.mjs";
import { budgetBlockForChunk } from "./risk-budget.mjs";
import { validateAuditSweepArtifacts } from "./validators.mjs";

const CLAUDE_AUDITOR_DEFAULT = "claude_semantic_auditor";
const DEFAULT_CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_TIMEOUT_KILL_GRACE_MS = 3000;
const CLAUDE_RAW_SUFFIX = ".claude-raw.json";
const CLAUDE_EVIDENCE_SUFFIX = ".claude-evidence.json";
const CLAUDE_READONLY_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

function claudeOutputRef(sweepId, chunkId, suffix) {
  return artifactRef("evidence_refs", sweepId, "claude-output", `${chunkId}${suffix}`);
}

function claudeRunToken(timestamp) {
  return timestamp.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

function projectRefForPath(projectRoot, absolutePath) {
  return path.relative(projectRoot, absolutePath).replace(/\\/g, "/");
}

function claudePrompt({ packet, auditorPacketRef, rawRef, sessionRef }) {
  return [
    "OUTPUT FORMAT (HARD REQUIREMENT, READ FIRST):",
    "Your reply MUST be exactly one JSON object. The first character of your reply MUST be `{` and the last character MUST be `}`. No prose, no apology, no markdown fences, no \"Audit complete\" summary, no commentary. Even when no findings are emitted, you MUST still emit the full JSON object (with findings: [] and the required negative_reasoning fields). A reply that is not a single JSON object will be rejected and the chunk will be marked failed.",
    "",
    "You are the Claude semantic auditor for a nimicoding sweep audit chunk.",
    "Run in read-only, audit-only mode. Do not edit files. Do not implement product fixes.",
    `Read the auditor packet from ${auditorPacketRef} and inspect the chunk authority refs and implementation evidence semantically.`,
    "Do not rely on this prompt as the chunk inventory; the packet file is the source for files, authority_refs, selected_implementation_refs, audit_depth, retrieval_prepass, and the raw semantic output contract.",
    "Scripts may not generate findings or no-findings; your conclusions must come from your own inspection.",
    "The packet is compact: evidence_inventory/selected_implementation_refs is the manager-selected implementation slice, not the full manager-owned inventory.",
    "Do not ask for, reconstruct, or echo the omitted full evidence_inventory. audit-claude will mechanically fill coverage.files, coverage.authority_refs, and full coverage.evidence_files from manager-owned chunk state.",
    "You only author semantic audit content: authority_outcomes reasoning/status, inspected_implementation_refs, P0/P1 rule checks, p0p1_negative_reasoning when applicable, and findings.",
    "For each authority outcome, set authority_ref to the packet authority_ref and put inspected implementation refs in inspected_implementation_refs or implementation_evidence_refs.",
    "Every implementation ref you cite must be an exact file ref from packet.selected_implementation_refs / packet.evidence_inventory.",
    "Never put AGENTS.md, README.md, spec files, authority refs, methodology docs, or governance docs in inspected_implementation_refs, implementation_evidence_refs, coverage.p0p1_evidence_refs, findings[].implementation_refs, or coverage.p0p1_rule_checks[].implementation_refs; even if packet.selected_implementation_refs includes them, treat them as context only.",
    "If only context/governance/authority documents are available after that exclusion, use status=\"not_applicable\" for P0/P1 rule checks and explain the lack of implementation surface in negative_reasoning.",
    "If a governance or authority document influenced reasoning, mention it only in negative_reasoning/description text, not in any implementation_refs array.",
    "Use packet.audit_depth to size your inspection: deep means inspect the selected slice thoroughly, normal means focused semantic inspection, shallow means audit generated/table/index invariants from the selected slice without expanding the omitted inventory.",
    "Return exactly one JSON object and nothing else. Do not wrap it in markdown.",
    "The JSON object must have exactly these top-level fields: chunk_id, auditor, coverage, findings.",
    `Set auditor.id to ${JSON.stringify(packet.auditor)}.`,
    `Set auditor.mode to "claude_semantic_audit".`,
    `Set auditor.methodology_ref to "package://@nimiplatform/nimi-coding/methodology/audit-sweep-p0p1-recall.yaml".`,
    "Put P0/P1 rule checks only at coverage.p0p1_rule_checks.",
    `Set auditor.provenance.kind to "semantic_audit".`,
    `Set auditor.provenance.packet_ref to ${JSON.stringify(packetRef(packet.sweep_id, packet.chunk_id))}.`,
    `Set auditor.provenance.session_ref to ${JSON.stringify(sessionRef)}.`,
    `Set auditor.provenance.transcript_ref to ${JSON.stringify(rawRef)}.`,
    "coverage.authority_outcomes must contain one outcome per authority_ref.",
    `coverage.p0p1_rule_checks must contain exactly these ids and no aliases: ${P0P1_RULE_CHECK_IDS.join(", ")}.`,
    "Each coverage.authority_outcomes[] object must include negative_reasoning when no critical/high finding is emitted for the chunk.",
    "Each coverage.p0p1_rule_checks[] object must include id, status, implementation_refs, and negative_reasoning.",
    "Use status=\"checked\" when implementation evidence was inspected; checked rules must cite at least one in-scope implementation ref.",
    "Use status=\"not_applicable\" only when the rule truly has no implementation surface, and explain that in negative_reasoning.",
    "When the packet evidence_inventory is empty and no critical/high finding is emitted, include coverage.p0p1_implementation_not_applicable_reason with the chunk-specific reason implementation refs are not applicable.",
    "When findings is an empty array, you MUST include coverage.p0p1_negative_reasoning (string) explaining why no critical/high finding was emitted across all priority defect classes. Omitting this field will reject the audit.",
    "Output MUST be exactly one JSON object. Do not prepend prose. Do not wrap in ```json fences. Do not append commentary. The first character MUST be `{` and the last character MUST be `}`.",
    "Do not use priority defect class aliases such as authority_boundary_bypass, security_or_permission_bypass, destructive_action_without_gate, package_boundary_violation, or unadmitted_truth_or_evidence_source as rule check ids.",
    "Do not emit coverage.files, coverage.authority_refs, or coverage.evidence_files; those fields are manager-owned and will be populated from the packet.",
    "Do not emit authority_outcomes[].evidence_refs; it is manager-owned and will be built from authority_ref plus inspected implementation refs.",
    "Every finding must include severity, category, impact, title, description, and location.file. Set severity to critical or high for P0/P1 findings. Set finding.category to one of the exact P0/P1 rule ids when the finding maps to a P0/P1 rule; do not use rule_id as the primary finding category field.",
    "Set findings[].location.file to an exact packet.selected_implementation_refs file for implementation findings. For authority-only findings with no implementation surface, set findings[].location.file to the in-scope authority_ref that contains the defect.",
    "authority_outcomes[].status is an audit-process enum only: audited, blocked, or not_applicable.",
    "Use status=audited when the authority/evidence was inspected, even if you discovered violations.",
    "When an authority outcome uses status=blocked or status=not_applicable, include reason with the chunk-specific blocker or not-applicable explanation.",
    "Do not use compliance verdicts such as violated, pass, fail, compliant, or non_compliant in authority_outcomes[].status; put violations in findings.",
    "For no-finding chunks, include chunk-specific inspected implementation refs, P0/P1 rule checks, and negative reasoning.",
  ].join("\n");
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return text;
  }
  const fenceEnd = trimmed.indexOf("\n");
  if (fenceEnd < 0) {
    return text;
  }
  const inside = trimmed.slice(fenceEnd + 1);
  const closing = inside.lastIndexOf("```");
  if (closing < 0) {
    return inside;
  }
  return inside.slice(0, closing);
}

function extractFirstJsonObject(rawText) {
  const candidate = stripCodeFence(rawText);
  const start = candidate.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, index + 1);
      }
    }
  }
  return null;
}

function normalizeClaudeRawOutput(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.type === "result" && parsed?.structured_output && typeof parsed.structured_output === "object") {
      return `${JSON.stringify(parsed.structured_output, null, 2)}\n`;
    }
    if (parsed?.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
      return normalizeClaudeRawOutput(parsed.result);
    }
    return trimmed;
  } catch {
    // Fall through to extraction below.
  }
  const extracted = extractFirstJsonObject(trimmed);
  if (extracted) {
    try {
      JSON.parse(extracted);
      return extracted;
    } catch {
      return extracted;
    }
  }
  return trimmed;
}

function terminateProcess(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child termination.
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already have exited.
  }
}

function executableInvocation(executable, args) {
  if (
    process.platform === "win32" &&
    [".cjs", ".js", ".mjs"].includes(path.extname(executable).toLowerCase())
  ) {
    return { command: process.execPath, args: [executable, ...args] };
  }
  return { command: executable, args };
}

const CLAUDE_AUDIT_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    chunk_id: { type: "string" },
    auditor: { type: "object" },
    coverage: { type: "object" },
    findings: { type: "array" },
  },
  required: ["chunk_id", "auditor", "coverage", "findings"],
  additionalProperties: false,
});

function runClaudeExec({ projectRoot, claudeBin, rawOutputPath, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const boundedTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CLAUDE_TIMEOUT_MS;
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const invocation = executableInvocation(claudeBin, [
      "-p",
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--allowedTools", CLAUDE_READONLY_ALLOWED_TOOLS.join(","),
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit",
      "--no-session-persistence",
      "--add-dir", projectRoot,
      "--json-schema", CLAUDE_AUDIT_OUTPUT_SCHEMA,
    ]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcess(child, "SIGKILL"), CLAUDE_TIMEOUT_KILL_GRACE_MS);
    }, boundedTimeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", async (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ ok: false, exitCode: 1, timedOut, timeoutMs: boundedTimeoutMs, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", async (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      try {
        await writeFile(rawOutputPath, normalizeClaudeRawOutput(stdout));
      } catch {
        // best effort; downstream extraction will report missing file.
      }
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, timeoutMs: boundedTimeoutMs, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

async function prepareClaudeAuditPacket(projectRoot, options) {
  return withAuditSweepMutationLock(projectRoot, options.sweepId, "chunk claude audit prepare", async () => {
    const planResult = await loadPlan(projectRoot, options.sweepId);
    if (!planResult.ok) {
      return inputError(planResult.error);
    }
    const chunkResult = await loadChunk(projectRoot, options.sweepId, options.chunkId);
    if (!chunkResult.ok) {
      return inputError(chunkResult.error);
    }
    if (chunkResult.chunk.state === "skipped") {
      return inputError("nimicoding sweep audit refused: skipped chunks cannot be audited through Claude.\n");
    }
    const budgetBlock = budgetBlockForChunk(planResult.plan, chunkResult.chunk);
    if (budgetBlock && chunkResult.chunk.state !== "frozen") {
      return inputError(`nimicoding sweep audit refused: ${budgetBlock}; build or admit remediation bundles before continuing discovery.\n`);
    }

    const dispatch = {
      auditor: options.auditor ?? CLAUDE_AUDITOR_DEFAULT,
      criteria: chunkResult.chunk.criteria,
      files: chunkResult.chunk.files,
      authority_refs: chunkResult.chunk.authority_refs ?? chunkResult.chunk.files,
      host_authority_projection_refs: chunkResult.chunk.host_authority_projection_refs ?? [],
      evidence_roots: chunkResult.chunk.evidence_roots ?? [],
      admitted_evidence_roots: chunkResult.chunk.admitted_evidence_roots ?? [],
      evidence_inventory: chunkResult.chunk.evidence_inventory ?? [],
      evidence_inventory_status: chunkResult.chunk.evidence_inventory_status ?? null,
      evidence_inventory_empty_reason: chunkResult.chunk.evidence_inventory_empty_reason ?? null,
      execution_owner: "nimicoding_claude_auditor_path",
    };
    const packet = buildAuditorPacket(options.sweepId, chunkResult.chunk, dispatch.auditor, options.dispatchedAt, planResult.plan, { projectRoot });
    packet.execution_owner = "nimicoding_claude_auditor_path";
    packet.raw_output_contract = {
      raw_output_is_transcript_ref: true,
      raw_output_must_be_exact_json: true,
      schema_drift_rejected_fail_closed: true,
      scripts_may_only_extract_schema_conformant_evidence: true,
    };

    const auditorPacketRef = packetRef(options.sweepId, options.chunkId);
    const updatedChunk = {
      ...chunkResult.chunk,
      state: "dispatched",
      lifecycle: {
        ...chunkResult.chunk.lifecycle,
        dispatched_at: options.dispatchedAt,
        ingested_at: null,
        reviewed_at: null,
        frozen_at: null,
        failed_at: null,
        skipped_at: null,
      },
      dispatch,
      evidence_ref: null,
      finding_count: 0,
      audit_validity: null,
      review: null,
      failure: null,
      updated_at: options.dispatchedAt,
    };

    await writeYamlRef(projectRoot, auditorPacketRef, packet);
    await writeYamlRef(projectRoot, chunkResult.chunkRef, updatedChunk);
    await writeYamlRef(projectRoot, planResult.planRef, {
      ...updatePlanChunk(planResult.plan, options.chunkId, {
        state: "dispatched",
        evidence_ref: null,
        finding_count: 0,
        audit_validity: null,
        failure: null,
      }),
      updated_at: options.dispatchedAt,
    });
    const runLedgerRef = await appendRunEvent(projectRoot, options.sweepId, {
      event_type: "chunk_claude_audit_prepared",
      chunk_id: options.chunkId,
      chunk_ref: chunkRef(options.sweepId, options.chunkId),
      packet_ref: auditorPacketRef,
      auditor: dispatch.auditor,
    });
    return {
      ok: true,
      chunk: updatedChunk,
      packet,
      packetRef: auditorPacketRef,
      chunkRef: chunkResult.chunkRef,
      runLedgerRef,
    };
  });
}

async function markClaudeAuditFailed(projectRoot, options) {
  return withAuditSweepMutationLock(projectRoot, options.sweepId, "chunk claude audit fail", async () => {
    const planResult = await loadPlan(projectRoot, options.sweepId);
    if (!planResult.ok) {
      return inputError(planResult.error);
    }
    const chunkResult = await loadChunk(projectRoot, options.sweepId, options.chunkId);
    if (!chunkResult.ok) {
      return inputError(chunkResult.error);
    }
    const failure = {
      reason: options.reason,
      failed_at: options.failedAt,
      packet_ref: options.packetRef,
      transcript_ref: options.transcriptRef,
      phase: options.phase,
    };
    const updatedChunk = {
      ...chunkResult.chunk,
      state: "failed",
      lifecycle: {
        ...chunkResult.chunk.lifecycle,
        failed_at: options.failedAt,
        skipped_at: null,
      },
      failure,
      updated_at: options.failedAt,
    };
    await writeYamlRef(projectRoot, chunkResult.chunkRef, updatedChunk);
    await writeYamlRef(projectRoot, planResult.planRef, {
      ...updatePlanChunk(planResult.plan, options.chunkId, {
        state: "failed",
        failure,
      }),
      updated_at: options.failedAt,
    });
    const runLedgerRef = await appendRunEvent(projectRoot, options.sweepId, {
      event_type: "chunk_failed",
      chunk_id: options.chunkId,
      chunk_ref: chunkResult.chunkRef,
      packet_ref: options.packetRef,
      transcript_ref: options.transcriptRef,
      summary: options.reason,
      phase: options.phase,
    });
    return {
      ok: true,
      state: "failed",
      chunkRef: chunkResult.chunkRef,
      runLedgerRef,
    };
  });
}

export async function runClaudeAuditSweepChunk(projectRoot, options) {
  const sweepId = safeSweepId(options.sweepId);
  if (!sweepId || typeof options.chunkId !== "string") {
    return inputError("nimicoding sweep audit refused: --sweep-id and --chunk-id are required.\n");
  }
  const dispatchedAtError = ensureIsoTimestamp(options.dispatchedAt, "--dispatched-at");
  if (dispatchedAtError) {
    return dispatchedAtError;
  }
  const verifiedAtError = ensureIsoTimestamp(options.verifiedAt, "--verified-at");
  if (verifiedAtError) {
    return verifiedAtError;
  }
  const reviewedAtError = ensureIsoTimestamp(options.reviewedAt, "--reviewed-at");
  if (reviewedAtError) {
    return reviewedAtError;
  }

  const prepare = await prepareClaudeAuditPacket(projectRoot, {
    ...options,
    sweepId,
  });
  if (!prepare.ok) {
    return prepare;
  }

  const outputSuffix = `.${claudeRunToken(options.dispatchedAt)}`;
  let rawRef = claudeOutputRef(sweepId, options.chunkId, `${outputSuffix}${CLAUDE_RAW_SUFFIX}`);
  const evidenceCandidateRef = claudeOutputRef(sweepId, options.chunkId, `${outputSuffix}${CLAUDE_EVIDENCE_SUFFIX}`);
  let rawOutputPath = artifactPath(projectRoot, rawRef);
  let sessionRef = `claude-exec:${sweepId}:${options.chunkId}:${options.dispatchedAt}`;
  if (options.fromRawOutput) {
    const replaySource = resolveInsideProject(projectRoot, options.fromRawOutput, "--from-raw-output");
    if (!replaySource.ok) {
      await markClaudeAuditFailed(projectRoot, {
        sweepId,
        chunkId: options.chunkId,
        failedAt: options.verifiedAt,
        packetRef: prepare.packetRef,
        transcriptRef: rawRef,
        phase: "raw_output_replay",
        reason: replaySource.error.trim(),
      });
      return inputError(replaySource.error);
    }
    try {
      const replayText = await readFile(replaySource.absolutePath, "utf8");
      await mkdir(path.dirname(rawOutputPath), { recursive: true });
      await writeFile(rawOutputPath, normalizeClaudeRawOutput(replayText));
      sessionRef = `claude-replay:${sweepId}:${options.chunkId}:${options.dispatchedAt}:${projectRefForPath(projectRoot, replaySource.absolutePath)}`;
    } catch (error) {
      const reason = `Claude replay raw output could not be read or normalized: ${error.message}`;
      await markClaudeAuditFailed(projectRoot, {
        sweepId,
        chunkId: options.chunkId,
        failedAt: options.verifiedAt,
        packetRef: prepare.packetRef,
        transcriptRef: rawRef,
        phase: "raw_output_replay",
        reason,
      });
      return inputError(`nimicoding sweep audit refused: ${reason}\n`);
    }
  } else {
    await mkdir(path.dirname(rawOutputPath), { recursive: true });
    const runResult = await runClaudeExec({
      projectRoot,
      claudeBin: options.claudeBin ?? "claude",
      rawOutputPath,
      prompt: claudePrompt({
        packet: prepare.packet,
        auditorPacketRef: prepare.packetRef,
        rawRef,
        sessionRef,
      }),
      timeoutMs: options.timeoutMs,
    });
    if (!runResult.ok) {
      const failureReason = runResult.timedOut
        ? `Claude auditor execution timed out after ${runResult.timeoutMs}ms.`
        : `Claude auditor execution failed with exit code ${runResult.exitCode ?? "unknown"}.`;
      await markClaudeAuditFailed(projectRoot, {
        sweepId,
        chunkId: options.chunkId,
        failedAt: options.verifiedAt,
        packetRef: prepare.packetRef,
        transcriptRef: rawRef,
        phase: "claude_execution",
        reason: failureReason,
      });
      await appendRunEvent(projectRoot, sweepId, {
        event_type: "chunk_claude_audit_failed",
        chunk_id: options.chunkId,
        chunk_ref: prepare.chunkRef,
        packet_ref: prepare.packetRef,
        transcript_ref: rawRef,
        exit_code: runResult.exitCode,
        timed_out: runResult.timedOut,
        timeout_ms: runResult.timeoutMs,
        stderr_tail: runResult.stderr.slice(-2000),
      });
      return inputError(`nimicoding sweep audit refused: ${failureReason}\n`);
    }
  }

  const extracted = await extractCodexAuditorEvidenceFile(projectRoot, {
    rawOutputPath,
    evidenceRef: evidenceCandidateRef,
    chunk: prepare.chunk,
    packetRef: prepare.packetRef,
    sessionRef,
    transcriptRef: rawRef,
    auditorId: options.auditor ?? CLAUDE_AUDITOR_DEFAULT,
    auditorMode: "claude_semantic_audit",
  });
  if (!extracted.ok) {
    await markClaudeAuditFailed(projectRoot, {
      sweepId,
      chunkId: options.chunkId,
      failedAt: options.verifiedAt,
      packetRef: prepare.packetRef,
      transcriptRef: rawRef,
      phase: "auditor_output_validation",
      reason: `Claude auditor output rejected: ${extracted.error}.`,
    });
    await appendRunEvent(projectRoot, sweepId, {
      event_type: "chunk_claude_auditor_output_rejected",
      chunk_id: options.chunkId,
      chunk_ref: prepare.chunkRef,
      packet_ref: prepare.packetRef,
      transcript_ref: rawRef,
      reason: extracted.error,
    });
    return inputError(`nimicoding sweep audit refused: Claude auditor output rejected for ${options.chunkId}: ${extracted.error}.\n`);
  }

  await appendRunEvent(projectRoot, sweepId, {
    event_type: "chunk_claude_auditor_output_accepted",
    chunk_id: options.chunkId,
    chunk_ref: prepare.chunkRef,
    packet_ref: prepare.packetRef,
    transcript_ref: rawRef,
    evidence_candidate_ref: evidenceCandidateRef,
    audit_validity: extracted.auditValidity,
  });

  const ingest = await ingestAuditSweepChunk(projectRoot, {
    sweepId,
    chunkId: options.chunkId,
    fromPath: evidenceCandidateRef,
    verifiedAt: options.verifiedAt,
  });
  if (!ingest.ok) {
    await markClaudeAuditFailed(projectRoot, {
      sweepId,
      chunkId: options.chunkId,
      failedAt: options.verifiedAt,
      packetRef: prepare.packetRef,
      transcriptRef: rawRef,
      phase: "chunk_ingest",
      reason: `Claude auditor evidence ingest rejected: ${ingest.error ?? "unknown ingest failure"}.`,
    });
    return inputError(`nimicoding sweep audit refused: Claude auditor evidence ingest rejected for ${options.chunkId}: ${ingest.error ?? "unknown ingest failure"}.\n`);
  }

  const review = await reviewAuditSweepChunk(projectRoot, {
    sweepId,
    chunkId: options.chunkId,
    verdict: "pass",
    reviewedAt: options.reviewedAt,
    reviewer: options.reviewer ?? "nimicoding_claude_auditor_path",
    summary: options.summary ?? `Claude semantic audit accepted from ${rawRef}.`,
  });
  if (!review.ok) {
    await markClaudeAuditFailed(projectRoot, {
      sweepId,
      chunkId: options.chunkId,
      failedAt: options.reviewedAt,
      packetRef: prepare.packetRef,
      transcriptRef: rawRef,
      phase: "chunk_review",
      reason: `Claude auditor evidence review rejected: ${review.error ?? "unknown review failure"}.`,
    });
    return inputError(`nimicoding sweep audit refused: Claude auditor evidence review rejected for ${options.chunkId}: ${review.error ?? "unknown review failure"}.\n`);
  }

  const validation = await validateAuditSweepArtifacts(projectRoot, {
    sweepId,
    scope: "chunks",
  });
  const chunkScopedFailures = (validation.checks ?? []).filter((entry) => {
    if (entry.ok) {
      return false;
    }
    const id = entry.id ?? "";
    return id.includes(options.chunkId);
  });
  if (chunkScopedFailures.length > 0) {
    const failureSummary = chunkScopedFailures.map((entry) => `${entry.id}: ${entry.reason}`).join("; ");
    await markClaudeAuditFailed(projectRoot, {
      sweepId,
      chunkId: options.chunkId,
      failedAt: options.reviewedAt,
      packetRef: prepare.packetRef,
      transcriptRef: rawRef,
      phase: "post_chunk_validation",
      reason: `Post-Claude chunk validation failed: ${failureSummary}`,
    });
    return inputError(`nimicoding sweep audit refused: post-Claude chunk validation failed for ${options.chunkId}: ${failureSummary}.\n`);
  }

  return {
    ok: true,
    exitCode: 0,
    sweepId,
    chunkId: options.chunkId,
    state: "frozen",
    packetRef: prepare.packetRef,
    transcriptRef: rawRef,
    extractedEvidenceRef: evidenceCandidateRef,
    evidenceRef: ingest.evidenceRef,
    findingsRef: ingest.findingsRef,
    findingCount: ingest.findingCount,
    addedCount: ingest.addedCount,
    duplicateCount: ingest.duplicateCount,
    reviewRef: review.runLedgerRef,
    validationScope: "chunks",
  };
}
