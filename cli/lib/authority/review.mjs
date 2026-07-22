import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { auditAuthorityPath } from "./audit.mjs";
import { compileAuthorityPath } from "./compile.mjs";
import { makeDiagnostic, portablePath, sortDiagnostics } from "./diagnostics.mjs";
import { diffAuthorityPaths } from "./diff.mjs";
import { AuthorityInputError } from "./format.mjs";
import {
  AuthorityReviewRefusal,
  authorityReviewRefusalDiagnostic,
  captureStableRegularFile,
  withGitAuthoritySnapshots,
} from "./git-snapshot.mjs";
import { impactAuthorityPaths } from "./impact.mjs";

const REVIEW_FORMAT = "nimicoding.authority-review/v1";

function validBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function refused(diagnostics, reviewBytes = 0) {
  return {
    ok: false,
    diagnostics: sortDiagnostics(diagnostics),
    fileCount: 0,
    unitCount: 0,
    reviewBytes,
    review: null,
    partial: false,
  };
}

function reviewBudgetDiagnostic(requiredBytes, maxBytes) {
  return makeDiagnostic({
    code: "AUTH_REVIEW_BUDGET",
    file: ".",
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason: `complete authority review requires ${requiredBytes} UTF-8 bytes but max-bytes is ${maxBytes}`,
    repair: "increase the explicit review byte budget; partial change review is forbidden",
  });
}

function normalizePath(file, root, side) {
  const relative = portablePath(file, root);
  const safe = path.isAbsolute(relative) ? path.basename(relative) : relative;
  return path.posix.join(side, safe || ".");
}

function normalizeCompilerDiagnostics(diagnostics, root, side) {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: normalizePath(diagnostic.path, root, side),
    related: diagnostic.related.map((related) => ({
      ...related,
      path: normalizePath(related.path, root, side),
    })),
  }));
}

function corpusInputDiagnostic(error, root, side) {
  const portableRoot = root.split(path.sep).join(path.posix.sep);
  const reason = error.message
    .split(root).join(side)
    .split(portableRoot).join(side)
    .split(path.sep).join(path.posix.sep);
  return makeDiagnostic({
    code: "AUTH_REVIEW_CORPUS_INVALID",
    file: side,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    pointer: "",
    reason,
    repair: "provide one complete canonical authority corpus; unsupported or partial inputs are refused",
  });
}

async function compileSnapshot(root, side) {
  try {
    const result = await compileAuthorityPath(root);
    if (result.ok) return { result, diagnostics: [] };
    return { result: null, diagnostics: normalizeCompilerDiagnostics(result.diagnostics, root, side) };
  } catch (error) {
    if (error instanceof AuthorityInputError) return { result: null, diagnostics: [corpusInputDiagnostic(error, root, side)] };
    throw error;
  }
}

function inputLabel(file, repository, fallback) {
  const absolute = path.resolve(process.cwd(), file);
  const relative = path.relative(repository, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join(path.posix.sep);
  return path.basename(absolute) || fallback;
}

async function captureReviewInput(file, temporaryRoot, name, label) {
  let bytes;
  try {
    bytes = await captureStableRegularFile(file, label);
  } catch (error) {
    if (error instanceof AuthorityReviewRefusal) {
      if (error.code === "AUTH_REVIEW_CAPTURE_CHANGED") throw error;
      throw new AuthorityReviewRefusal("AUTH_REVIEW_INPUT_INVALID", `${name} must be one readable regular non-symlink file`, label);
    }
    throw error;
  }
  const directory = path.join(temporaryRoot, "inputs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${name}.yaml`);
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  return target;
}

function invalidDisposition(result) {
  return result.diagnostics.some((diagnostic) => diagnostic.code === "AUTH_IMPACT_DISPOSITION_INVALID");
}

export function canonicalReviewBytes(review) {
  return Buffer.byteLength(JSON.stringify(review), "utf8");
}

function component(operationStatus, complete) {
  return { operationStatus, complete };
}

async function composeReview(snapshot, bindingsPath, dispositionsPath, budgets) {
  const bindingsLabel = inputLabel(bindingsPath, snapshot.repository, "bindings.yaml");
  const dispositionsLabel = inputLabel(dispositionsPath, snapshot.repository, "dispositions.yaml");
  const capturedBindings = await captureReviewInput(bindingsPath, snapshot.temporaryRoot, "bindings", bindingsLabel);
  const capturedDispositions = await captureReviewInput(dispositionsPath, snapshot.temporaryRoot, "dispositions", dispositionsLabel);
  const [baseCompiled, worktreeCompiled] = await Promise.all([
    compileSnapshot(snapshot.base.root, "base"),
    compileSnapshot(snapshot.worktree.root, "worktree"),
  ]);
  const compilerDiagnostics = [...baseCompiled.diagnostics, ...worktreeCompiled.diagnostics];
  if (compilerDiagnostics.length > 0) return refused(compilerDiagnostics);
  if (baseCompiled.result.fileCount !== snapshot.base.fileCount || worktreeCompiled.result.fileCount !== snapshot.worktree.fileCount) {
    throw new Error("captured authority file counts do not match complete compiler admission");
  }

  const [diffResult, impactResult, auditResult] = await Promise.all([
    diffAuthorityPaths(snapshot.base.root, snapshot.worktree.root, { maxBytes: budgets.maxBytes }),
    impactAuthorityPaths(snapshot.base.root, snapshot.worktree.root, capturedDispositions, { maxBytes: budgets.maxBytes, dispositionLabel: dispositionsLabel }),
    auditAuthorityPath(snapshot.worktree.root, capturedBindings, { ...budgets, bindingLabel: bindingsLabel }),
  ]);
  if (!diffResult.ok || diffResult.diff === null) return refused(diffResult.diagnostics);
  if (impactResult.impact === null || invalidDisposition(impactResult)) return refused(impactResult.diagnostics);
  if (auditResult.audit === null) return refused(auditResult.diagnostics);
  if (JSON.stringify(diffResult.diff) !== JSON.stringify(impactResult.diff)) throw new Error("diff and impact oracles returned different semantic diffs for immutable snapshots");

  const complete = impactResult.impact.complete && auditResult.audit.complete;
  const policyStatus = auditResult.audit.policyStatus === "blocked"
    ? "blocked"
    : complete ? "passed" : "indeterminate";
  const review = {
    format: REVIEW_FORMAT,
    operationStatus: "completed",
    policyStatus,
    complete,
    partial: false,
    snapshots: {
      base: {
        commitOid: snapshot.baseOid,
        contentIdentity: snapshot.base.contentIdentity,
        counts: {
          files: snapshot.base.fileCount,
          units: baseCompiled.result.unitCount,
          bytes: snapshot.base.byteCount,
        },
      },
      worktree: {
        contentIdentity: snapshot.worktree.contentIdentity,
        counts: {
          files: snapshot.worktree.fileCount,
          units: worktreeCompiled.result.unitCount,
          bytes: snapshot.worktree.byteCount,
        },
      },
    },
    components: {
      snapshots: component("completed", true),
      diff: component("completed", true),
      impact: component("completed", impactResult.impact.complete),
      audit: component(auditResult.audit.operationStatus, auditResult.audit.complete),
    },
    diff: diffResult.diff,
    impact: impactResult.impact,
    audit: auditResult.audit,
    budgets,
  };
  const reviewBytes = canonicalReviewBytes(review);
  if (reviewBytes > budgets.maxBytes) return refused([reviewBudgetDiagnostic(reviewBytes, budgets.maxBytes)], reviewBytes);
  return {
    ok: true,
    diagnostics: sortDiagnostics(impactResult.diagnostics),
    fileCount: snapshot.base.fileCount + snapshot.worktree.fileCount,
    unitCount: worktreeCompiled.result.unitCount,
    reviewBytes,
    review,
    partial: false,
  };
}

export async function reviewAuthorityRepository(repositoryPath, baseRef, bindingsPath, dispositionsPath, budgets, options = {}) {
  if (![budgets?.maxUnits, budgets?.maxEdges, budgets?.maxBytes].every(validBudget)) {
    return refused([reviewBudgetDiagnostic(1, budgets?.maxBytes ?? 0)]);
  }
  try {
    return await withGitAuthoritySnapshots({
      repositoryPath,
      baseRef,
      hooks: options.snapshotHooks ?? null,
    }, (snapshot) => composeReview(snapshot, bindingsPath, dispositionsPath, budgets));
  } catch (error) {
    if (error instanceof AuthorityReviewRefusal) return refused([authorityReviewRefusalDiagnostic(error)]);
    throw error;
  }
}

export { REVIEW_FORMAT };
