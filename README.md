# @nimiplatform/nimi-coding

`@nimiplatform/nimi-coding` is the standalone host-agnostic boundary package
for the Nimi Coding methodology.

The product goal is to let arbitrary projects install a reusable AI coding
governance toolkit, bootstrap a project-local `.nimi/**` layer, and then use
AI-native authority, packet, and acceptance discipline for high-risk work.

## Current Status

This repository is boundary-complete for its intended standalone scope.

Its completed standalone scope is:

- package identity
- repository foundation
- initial AI-native methodology seed
- package-owned reconstruction target-truth profile seed
- machine-readable reconstruction, doc-spec-audit, and high-risk execution result contracts
- package-owned canonical high-risk admission schema contract
- seed-only high-risk execution schemas for packet, orchestration-state, prompt, worker-output, and acceptance
- vendor-neutral external host-profile seed
- package-owned external host compatibility contract seed
- host-adapter seed for constrained external execution-host interop
- package-owned admitted host-profile overlay seed for `oh_my_codex`
- package-owned external execution artifact landing-path contract seed
- vendor-neutral external delegated skill runtime contract seed
- vendor-neutral delegated skill installer seed
- fail-closed delegated skill installer result-contract seed
- local-only installer operational evidence-home seed
- fail-closed collapsed installer summary projection lifecycle-contract seed
- package-owned bootstrap templates under `templates/bootstrap/**`
- a bounded standalone CLI with repair, validation, handoff, local closeout projection, explicit admission, and mechanical execution-artifact validation
- repository-local reconstructed `.nimi/spec/**` truth for this package itself
- a host-agnostic semantic + interop boundary for external AI hosts such as OMX, Codex, Claude, Gemini, or another contract-observing host

It intentionally defers:

- topic lifecycle workspace
- packet-bound run kernel
- provider-backed execution
- scheduler, notification, and automation backend surfaces
- self-hosted methodology execution

## CLI Status

This repository now carries a boundary-complete standalone `nimicoding` CLI.

At the current stage it provides:

- executable package bin wiring
- help and version output
- a minimal real `nimicoding init`
- a bounded `nimicoding repair`
- a bounded `nimicoding doctor`
- an explicit `nimicoding handoff` export
- an explicit `nimicoding admit-high-risk-decision` semantic admission surface
- a local-only `nimicoding closeout` projection
- a bounded local-only `nimicoding ingest-high-risk-execution` projection
- a bounded local-only `nimicoding review-high-risk-execution` projection
- a bounded local-only `nimicoding decide-high-risk-execution` projection
- mechanical validators for execution-packet, orchestration-state, prompt, worker-output, and acceptance
- skill-specific result contract seeding for reconstruction, doc/spec audit, and local-only high-risk execution closeout
- seed-only execution contract extraction under `.nimi/contracts/**`
- package-owned bootstrap templates under `templates/bootstrap/**`

Current `nimicoding init` behavior is intentionally narrow:

- create a minimal `.nimi/**` seed from package templates
- seed AI-native spec-reconstruction guidance inside `.nimi/**`
- seed package-owned machine contracts inside `.nimi/contracts/**`
- seed package-owned execution schemas for future high-risk methodology artifacts without admitting runtime ownership
- seed package-owned target-truth guidance for reconstruction outputs without creating empty `.nimi/spec/*.yaml` authority files
- seed canonical skill-manifest, host-profile, installer, delegated runtime contract, installer result contract, installer operational evidence home, and external handoff truth inside `.nimi/**`
- seed canonical host-adapter truth inside `.nimi/**` so external execution hosts can be admitted without becoming semantic owners
- seed canonical collapsed installer summary projection lifecycle truth inside `.nimi/**`
- update `.gitignore` for local runtime state
- fail closed on re-init
- fail closed on unknown CLI options
- optionally integrate `AGENTS.md` and `CLAUDE.md` with `--with-entrypoints`
- validate bootstrap integrity and delegated-runtime posture with `doctor`

Current `nimicoding repair` behavior is intentionally narrow:

- create only missing bootstrap seed files under `.nimi/**`
- recreate missing `.nimi/local/` and `.nimi/cache/`
- optionally integrate `AGENTS.md` and `CLAUDE.md` with `--with-entrypoints`
- preserve existing truth files rather than overwriting them
- refuse unsupported bootstrap contract versions

Current `nimicoding doctor` behavior is intentionally narrow:

- validate that `.nimi/**` bootstrap seed files are present
- validate that `.nimi/local/` and `.nimi/cache/` exist and remain ignored
- validate bootstrap contract compatibility metadata
- validate bootstrap-only and reconstruction-seeded lifecycle markers
- validate cross-contract reference alignment across manifest, handoff, runtime, installer, and host-profile truth
- validate host-adapter boundary truth and adapter selection posture
- validate admitted package-owned adapter profile overlays for named external hosts
- validate the packaged external host compatibility contract
- expose the supported external host posture, examples, and required/forbidden host behavior
- validate skill result-contract alignment
- validate the packaged high-risk execution result contract
- validate the packaged canonical high-risk admission schema contract
- validate the external execution artifact landing-path contract
- validate seed-only high-risk execution schemas under `.nimi/contracts/**`
- validate handoff context-order readiness for an external AI host
- expose the standalone completion profile, status, completed surfaces, deferred execution surfaces, and promoted parity gaps
- expose the generic external-host compatibility posture, admitted named overlay posture, and future-only host-specific surfaces
- validate reconstructed `.nimi/spec/*.yaml` top-level section shape when files exist
- validate canonical `.nimi/spec/high-risk-admissions.yaml` record shape against the packaged admission schema contract when present
- fail closed when lifecycle state and target-truth completeness drift apart
- report local `doc_spec_audit` closeout artifact status without promoting it to semantic truth
- emit either human-readable output or machine-readable JSON with `--json`

Current `nimicoding handoff` behavior is intentionally narrow:

- require explicit `--skill <skill-id>`
- export an authoritative machine-readable external handoff payload with `--json`
- optionally project a human-readable host briefing with `--prompt`
- remain host-agnostic: Claude, Codex, Gemini, OMX, or another external host may consume the same contract if it respects the declared boundaries
- export the package-owned host compatibility contract ref, supported host posture, supported host examples, and required/forbidden host behavior
- expose whether a generic external host is compatible, whether a named admitted overlay is merely available or currently selected, and which host-specific surfaces remain future-only
- reuse `doctor` validation and fail closed when bootstrap or delegated handoff posture is invalid
- allow `spec_reconstruction` handoff during bootstrap-only mode
- expose selected named adapter overlay metadata when an admitted host profile is selected
- export `resultContractRef` plus skill-specific closeout summary expectations
- export execution schema refs, expected artifact kinds, expected local artifact roots, and external execution summary status for `high_risk_execution`
- refuse `doc_spec_audit` and `high_risk_execution` handoff until target truth is reconstructed

Current `nimicoding closeout` behavior is intentionally narrow:

- require explicit `--skill`, `--outcome`, and `--verified-at`
- optionally import those fields plus an optional contract-validated `summary` from an external JSON payload with `--from`
- project external skill results into a local-only closeout payload
- optionally write the payload under `.nimi/local/handoff-results/` with `--write-local`
- fail closed if a `completed` outcome contradicts the current target-truth state
- support contract-validated local-only summary import for `high_risk_execution`
- fail closed if imported high-risk execution refs escape the declared local artifact roots
- fail closed if imported high-risk execution summaries omit refs, drift in shape, or claim an illegal external execution status
- fail closed if imported `summary` content violates the declared skill result contract
- fail closed if an imported JSON summary does not match the current project or required shape
- never promote local closeout artifacts to project semantic truth

Current `nimicoding admit-high-risk-decision` behavior is intentionally narrow:

- require explicit `--from <json>` and `--admitted-at <iso8601>`
- accept only `nimicoding.high-risk-decision.v1` payloads with `decisionStatus: manager_decision_recorded`
- derive `topic_id` and `packet_id` from the mechanically valid attached packet
- project canonical admission preview for `.nimi/spec/high-risk-admissions.yaml`
- write tracked semantic truth only when `--write-spec` is given explicitly
- fail closed on malformed decision payloads, malformed admissions truth, or missing packet identity

Current `nimicoding ingest-high-risk-execution` behavior is intentionally narrow:

- require explicit `--from <json>` pointing at a local high-risk closeout artifact
- accept only `high_risk_execution` closeout artifacts with `outcome: completed` and `summary.status: candidate_ready`
- mechanically validate the referenced packet, orchestration-state, prompt, and worker-output artifacts using the packaged validators
- require all evidence refs to exist under the declared local artifact roots
- project a local-only ingest payload and optionally write it under `.nimi/local/handoff-results/`
- fail closed on contract drift, root escape, missing artifacts, or invalid worker-output/prompt/schema shape
- never decide semantic acceptance, disposition, or finding judgment

Current `nimicoding review-high-risk-execution` behavior is intentionally narrow:

- require explicit `--from <json>` pointing at a local high-risk ingest artifact
- accept only `nimicoding.high-risk-ingest.v1` payloads with `ok: true`
- project a local-only review-ready attachment payload for manager-owned review
- carry attachment refs, ingest validation evidence, and the declared semantic review owner
- fail closed if the ingest payload is malformed, not local-only, or mechanically invalid
- never decide semantic acceptance, disposition, or finding judgment

Current `nimicoding decide-high-risk-execution` behavior is intentionally narrow:

- require explicit `--from <json>`, `--acceptance <path>`, and `--verified-at <iso8601>`
- accept only `nimicoding.high-risk-review.v1` payloads with `ok: true`
- require `reviewStatus: ready_for_manager_review`
- mechanically validate the provided acceptance artifact and require an explicit `Disposition:` line
- project a local-only manager decision payload and optionally write it under `.nimi/local/handoff-results/`
- fail closed if the review payload is malformed, not local-only, or points at another project
- never auto-promote the manager decision into canonical semantic truth without explicit admission

Current mechanical validator behavior is intentionally narrow:

- require an explicit artifact path for each validator command
- emit machine-readable `validator-cli-result.v1` JSON on both success and refusal
- validate only the package-owned seed contract shape for execution-packet, orchestration-state, prompt, worker-output, and acceptance
- fail closed on missing required sections, malformed YAML, or seed-contract drift
- avoid semantic acceptance, topic orchestration, scheduler ownership, or provider execution claims

The package now carries package-owned bootstrap templates at
`templates/bootstrap/**`, a package-owned exchange projection contract at
`.nimi/methodology/skill-exchange-projection.yaml`, package-owned machine
result contracts at `.nimi/contracts/spec-reconstruction-result.yaml` and
`.nimi/contracts/doc-spec-audit-result.yaml`,
`.nimi/contracts/high-risk-execution-result.yaml`, and
`.nimi/contracts/high-risk-admission.schema.yaml`,
`.nimi/contracts/external-host-compatibility.yaml`, a package-owned external
execution artifact landing-path contract at
`.nimi/config/external-execution-artifacts.yaml`, plus seed-only extracted
schemas for execution packet, orchestration-state, prompt, worker-output, and
acceptance under `.nimi/contracts/**`. It also now seeds package-owned
`host-adapter` truth plus package-owned adapter overlays under
`adapters/**/profile.yaml` so external execution hosts such as `oh-my-codex`
can be admitted as constrained bridges instead of semantic owners while
keeping external execution closeout local-only, root-bounded, and
non-semantic until an explicit manager-owned admission writes canonical
summary truth into `.nimi/spec/high-risk-admissions.yaml`.

Boundary-complete in this package does not mean promoted-runtime parity. The
promoted execution system under
[`/Users/snwozy/nimi-realm/nimi/nimi-coding`](/Users/snwozy/nimi-realm/nimi/nimi-coding)
still owns topic lifecycle runtime, packet-bound run commands, provider-backed
execution, scheduler, notification, and automation surfaces. Standalone does
not add `run-*` commands, provider invocation, scheduler logic, or transport
adapters in this cut.

## Intended Direction

The expected future experience is roughly:

1. install `@nimiplatform/nimi-coding`
2. initialize project-local methodology structure
3. connect AI entrypoints
4. let an external AI host use seeded `.nimi/**` reconstruction guidance, reconstruction target-truth profile, manifest, host-profile, installer, delegated runtime contract, installer result contract, collapsed installer summary projection lifecycle contract, installer operational evidence guidance, and the authoritative handoff JSON contract to
   reconstruct project truth
5. use the methodology for later high-risk work

## Development Posture

This repository is the standalone boundary package. The promoted execution
system authority for packet-bound runtime, provider-backed execution,
scheduler, notification, and automation surfaces remains
[`/Users/snwozy/nimi-realm/nimi/nimi-coding`](/Users/snwozy/nimi-realm/nimi/nimi-coding).
