# nimi-coding + oh-my-codex Integration Design

## 1. Purpose

This document defines how `@nimiplatform/nimi-coding` and
`oh-my-codex` (OMX) should work together for future Nimi project delivery.

The goal is not to merge the two systems.

The goal is to let:

- `nimi-coding` own semantic truth, governance, and fail-closed methodology
- `oh-my-codex` act as a constrained external execution host
- an adapter layer handle prompt/output/evidence handoff without promoting OMX
  runtime state into canonical project truth

This document targets the first real user flow: the repository owner using
`nimi-coding` plus OMX together for future Nimi project development.

## 2. Status

Current reality:

- promoted internal `nimi-coding` already owns the full methodology kernel,
  packet model, validators, run loop, review semantics, and scheduler/bridge
  surfaces
- standalone `_external/nimi-coding` already owns bootstrap truth, delegated
  runtime posture, `doctor`, `handoff`, validators, local projection, and
  explicit admission as a boundary-complete standalone package
- OMX already provides a strong external orchestration/runtime shell

Current gap:

- standalone `_external/nimi-coding` intentionally does not provide the full
  promoted internal run loop
- standalone `_external/nimi-coding` now packages a dedicated local-only
  `high_risk_execution` result contract plus bounded closeout/decision/ingest/
  review projection plus explicit canonical admission, and the canonical
  admission target is now guarded by a package-owned admission schema
  contract, but not automatic semantic promotion
- standalone `_external/nimi-coding` now recognizes the package-owned OMX
  adapter overlay as an admitted named host profile, but still keeps it
  additive and non-authoritative

This design treats standalone as boundary-complete rather than
promoted-runtime-parity complete.

## 3. Design Principles

1. Semantic truth remains in `.nimi/**`.
2. External execution hosts are admitted, not authoritative.
3. Runtime state and semantic truth must stay separate.
4. Prompt/output/evidence exchange is allowed.
5. Acceptance, disposition, and finding judgment stay under `nimi-coding`.
6. Missing authority, missing context, or contract drift must fail closed.
7. Adapter integration must not turn `@nimiplatform/nimi-coding` into a
   runtime platform.

## 4. Layer Model

### 4.1 Semantic Kernel

Owned by `nimi-coding`.

Includes:

- `.nimi/methodology/**`
- `.nimi/spec/**`
- `.nimi/contracts/**`
- `.nimi/config/**` contract truth
- packet / prompt / worker-output / acceptance / evidence schema ownership
- semantic review ownership

### 4.2 External Execution Host

Owned by OMX.

Includes:

- routing
- role/agent dispatch
- autonomy-first execution
- long-running operational continuity
- runtime observability
- host-local operational state

### 4.3 Interop Adapter

Owned by `@nimiplatform/nimi-coding`.

Includes:

- host admission truth
- bridge constraints
- handoff projection
- output/evidence candidate projection
- fail-closed mapping between `.nimi/**` and the external host

## 5. Ownership Boundary

### 5.1 Semantic Owner

Canonical semantic owner remains:

- `.nimi/methodology`
- `.nimi/spec`
- `.nimi/contracts`
- `.nimi/config`

OMX must not overwrite these surfaces as if they were runtime-owned.

### 5.2 Operational Owner

Operational owner may be OMX for:

- `.omx/**`
- process state
- session state
- orchestration logs
- transport state
- host-level notifications

`nimi-coding` may also keep local operational state in:

- `.nimi/local/**`
- `.nimi/cache/**`

### 5.3 Semantic Review Owner

Semantic review owner remains `nimicoding_manager`.

OMX may produce:

- plan candidate
- prompt execution output
- evidence candidate
- worker-output candidate

OMX must not decide:

- final acceptance
- final disposition
- finding lifecycle outcome
- semantic completion

## 6. Adapter Contract

The adapter contract has three responsibilities.

### 6.1 Host Admission

`nimi-coding` must declare:

- which host adapters are admitted
- which adapter is currently selected
- what handoff mode is allowed
- who owns semantic review

This is now represented by the standalone bootstrap seed:

- `.nimi/config/host-adapter.yaml`
- `.nimi/contracts/external-host-compatibility.yaml`

### 6.2 Prompt Handoff

`nimi-coding` exports explicit host-facing handoff payloads through:

- `nimicoding handoff --skill <id> --json`
- `nimicoding handoff --skill <id> --prompt`

The JSON payload is the authoritative machine contract. The prompt output is a
human-readable projection of that same contract.

These payloads must carry:

- ordered context
- hard constraints
- expected results
- declared runtime owner
- selected adapter identity
- semantic review owner
- expected local artifact landing roots for packet/orchestration/prompt/output/evidence refs

### 6.3 Output / Evidence Handoff

OMX may return:

- `*.worker-output.md`
- evidence candidate artifacts
- local result summary candidates

Those outputs remain candidate material until validated and attached by
`nimi-coding`.

## 7. Artifact Mapping

| Concern | Producer | Canonical owner | Notes |
|---|---|---|---|
| reconstruction prompt | `nimicoding handoff` | `nimi-coding` | exported to OMX |
| reconstruction result | OMX | `nimi-coding` closeout projection | local-only until admitted |
| high-risk prompt | `nimicoding handoff` | `nimi-coding` | exported to OMX |
| worker output | OMX | `nimi-coding` schema/validators | candidate only |
| evidence | OMX | `nimi-coding` evidence model | candidate only |
| acceptance | manager / `nimi-coding` | `nimi-coding` | OMX cannot own |
| disposition | manager / `nimi-coding` | `nimi-coding` | OMX cannot own |
| runtime state | OMX | OMX | operational only |

## 8. Supported Flows

### 8.1 Bootstrap Reconstruction

1. `nimicoding init --with-entrypoints`
2. `nimicoding doctor`
3. `nimicoding handoff --skill spec_reconstruction --prompt`
4. send prompt to OMX
5. OMX reconstructs declared `.nimi/spec/*.yaml`
6. `nimicoding closeout --skill spec_reconstruction --from <json> --write-local`

### 8.2 Doc/Spec Audit

1. reconstructed target truth exists
2. `nimicoding handoff --skill doc_spec_audit --prompt`
3. send prompt to OMX
4. OMX returns local audit result candidate
5. `nimicoding closeout --skill doc_spec_audit --from <json> --write-local`

### 8.3 High-Risk Execution

Current first cut:

1. reconstructed target truth exists
2. choose external host adapter in `.nimi/config/host-adapter.yaml`
3. `nimicoding handoff --skill high_risk_execution --prompt`
4. OMX executes against exported context
5. OMX writes `worker-output` and evidence candidate artifacts
6. `nimicoding` validators validate artifact shape
7. manager-owned review/decision can be projected locally in standalone
8. explicit canonical admission can be recorded in standalone
9. automatic semantic promotion still remains in promoted internal `nimi-coding`

This is intentionally still not a fully automated semantic promotion loop.

## 9. Why OMX Fits

OMX is a strong match for the external-host role because it already provides:

- external routing
- agent/team dispatch
- autonomy-first execution
- operational continuity
- observability and runtime ergonomics

But OMX must be constrained because its native runtime logic is not itself the
authority system for Nimi methodology truth.

## 10. Why Direct Merge Is Wrong

Direct merge would blur:

- semantic truth
- runtime truth
- operator ergonomics
- methodology contracts

That would create a hybrid product that is harder to audit and easier to let
drift into pseudo-ownership by the runtime shell.

Therefore:

- `nimi-coding` should admit OMX
- `nimi-coding` should not absorb OMX

## 11. First Implemented Adapter Cut

The first implemented cut in `_external/nimi-coding` now includes:

- adapter documentation under `adapters/**`
- an OMX adapter sketch under `adapters/oh-my-codex/**`
- `host-adapter` bootstrap seed under `.nimi/config/host-adapter.yaml`
- a package-owned OMX adapter overlay contract under `adapters/oh-my-codex/profile.yaml`
- `doctor` checks for adapter selection, boundary posture, and package-owned adapter overlay drift
- `handoff` payload and prompt projection with adapter metadata and selected overlay details

This cut does not introduce:

- host-specific runtime execution code
- host-specific CLI runtime
- self-hosted orchestration
- acceptance automation

## 12. Required Next Steps

### Remaining Work

1. add automation around explicit manager admission without widening standalone
   runtime ownership
2. keep named host-profile recognition additive rather than ownership-changing
3. preserve OMX as an external execution host rather than a runtime authority

## 13. Non-Goals

This design does not aim to:

- replace promoted internal `nimi-coding`
- turn standalone `@nimiplatform/nimi-coding` into a runtime platform
- make OMX the semantic owner
- allow runtime state to become canonical methodology truth

## 14. Decision

The correct product direction is:

- keep `nimi-coding` as the semantic kernel
- admit OMX as a constrained external execution host
- use an adapter layer for prompt/output/evidence handoff
- preserve packet-bound runtime, provider execution, scheduler, notification,
  and automation ownership in promoted internal `nimi-coding`

This gives the first user a usable combined workflow now without corrupting the
authority model that `nimi-coding` is trying to productize.
