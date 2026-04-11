import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENTS_BEGIN,
  AGENTS_END,
  CLAUDE_BEGIN,
  CLAUDE_END,
} from "../constants.mjs";
import { pathExists } from "./fs-helpers.mjs";

function managedAgentsBlock() {
  return `${AGENTS_BEGIN}
# Nimi Coding Managed Block

- Read .nimi/methodology, .nimi/spec, and .nimi/contracts before high-risk changes.
- Treat .nimi as the primary AI truth surface for this project.
- If .nimi/spec remains bootstrap-only, use .nimi/methodology/spec-reconstruction.yaml and .nimi/config/skills.yaml to drive AI-side truth reconstruction.
- Treat .nimi/methodology/spec-target-truth-profile.yaml as package-owned guidance for reconstruction target outputs; do not bootstrap empty authority files under .nimi/spec.
- Treat .nimi/contracts/spec-reconstruction-result.yaml, .nimi/contracts/doc-spec-audit-result.yaml, .nimi/contracts/high-risk-execution-result.yaml, and .nimi/contracts/high-risk-admission.schema.yaml as machine contracts for reconstruction, audit, local-only high-risk closeout summaries, and canonical high-risk admission truth.
- Treat .nimi/config/skill-manifest.yaml, .nimi/config/host-profile.yaml, .nimi/config/host-adapter.yaml, .nimi/config/external-execution-artifacts.yaml, .nimi/config/skill-installer.yaml, .nimi/methodology/skill-runtime.yaml, .nimi/methodology/skill-installer-result.yaml, .nimi/methodology/skill-handoff.yaml, and admitted package-owned adapter profiles under adapters/**/profile.yaml as the canonical bridge to any external AI/skill execution.
- Treat standalone nimicoding as boundary-complete for bootstrap, handoff, validation, projection, and explicit admission only; do not assume packaged run-kernel, provider, scheduler, notification, or automation ownership.
- Treat .nimi/config/installer-evidence.yaml and .nimi/methodology/skill-installer-summary-projection.yaml as the operational-to-semantic installer projection boundary; do not promote concrete evidence artifacts into semantic truth.
- Treat high-risk external execution closeout, decision, ingest, and review payloads under .nimi/local/** as local-only operational projections; they do not promote semantic truth automatically, even when manager-owned.
- Use high-risk packetized execution only when authority, ownership, or cross-layer risk justifies it.
- Keep inline manager-worker as the default methodology posture; do not assume a separate worker runtime is mandatory.
- Keep the methodology continuity-agnostic; do not assume daemon, heartbeat, or persistent manager ownership.
- Do not treat this managed block as a replacement for project-specific rules outside .nimi.
${AGENTS_END}`;
}

function managedClaudeBlock() {
  return `${CLAUDE_BEGIN}
# Nimi Coding Managed Block

Use the project's .nimi layer as the primary AI truth surface.

Priority:
1. .nimi/methodology
2. .nimi/spec
3. .nimi/contracts
4. .nimi/config
5. repository-local AI entrypoint files

If the project still exposes only bootstrap seed files, use the reconstruction guidance, reconstruction target-truth profile, result contracts, manifest, host-profile, host-adapter, admitted package-owned adapter profiles, installer, runtime contract, installer result contract, collapsed installer summary projection lifecycle contract, operational evidence guidance, and handoff truth under .nimi rather than assuming skills are already installed.

Default posture:
- use risk-shaped methodology only for authority-bearing or high-risk work
- prefer inline manager-worker unless a later admitted packet expands runtime ownership
- keep continuity-agnostic semantics; do not assume persistent automation or self-hosting
- treat handoff --json as the authoritative machine contract and handoff --prompt as a human-readable projection only
${CLAUDE_END}`;
}

function upsertManagedBlock(existing, begin, end, block) {
  const pattern = new RegExp(
    `${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );

  if (pattern.test(existing)) {
    return existing.replace(pattern, block);
  }

  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${prefix}${block}\n`;
}

async function upsertTextFile(filePath, block, begin, end, header) {
  const existing = (await pathExists(filePath)) ? await readFile(filePath, "utf8") : header;
  const next = upsertManagedBlock(existing, begin, end, block);

  if (next === existing) {
    return false;
  }

  await writeFile(filePath, next, "utf8");
  return true;
}

export async function integrateEntrypoints(projectRoot) {
  const updated = [];

  if (
    await upsertTextFile(
      path.join(projectRoot, "AGENTS.md"),
      managedAgentsBlock(),
      AGENTS_BEGIN,
      AGENTS_END,
      "# AGENTS.md\n",
    )
  ) {
    updated.push("AGENTS.md");
  }

  if (
    await upsertTextFile(
      path.join(projectRoot, "CLAUDE.md"),
      managedClaudeBlock(),
      CLAUDE_BEGIN,
      CLAUDE_END,
      "# CLAUDE.md\n",
    )
  ) {
    updated.push("CLAUDE.md");
  }

  return updated;
}
