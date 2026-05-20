# @nimiplatform/nimi-coding

**English** · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@nimiplatform/nimi-coding.svg?label=npm)](https://www.npmjs.com/package/@nimiplatform/nimi-coding)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](#requirements)

> A **vendor-neutral, AI-native methodology toolkit** for governing
> high-risk AI-assisted software work. Bootstraps a project-local
> `.nimi/**` truth surface, ships the `nimicoding` CLI, and turns
> "AI plausibly finished this" into "the four closure dimensions
> are evidenced."

Reader documentation: <https://docs.nimi.ai/nimicoding>
npm package: [`@nimiplatform/nimi-coding`](https://www.npmjs.com/package/@nimiplatform/nimi-coding)

---

## Why This Exists

AI-assisted implementation routinely produces output that **compiles,
passes existing tests, looks plausible to a reviewer, and is still
wrong** about authority, scope, semantics, or product meaning. These
are not bugs in the conventional sense — they are *closure failures*:
the work was claimed done in a state where the closure conditions had
not actually held.

A short, non-exhaustive list of failure shapes Nimi Coding is
designed to catch:

- **Stale-doc anchoring** — the assistant follows a document that
  looked authoritative but had drifted from the active spec.
- **Implicit scope expansion** — the assistant edits an adjacent
  surface "while it's in the file"; ownership silently shifts.
- **Plausible synthesis** — when authoritative source is missing,
  the assistant invents a coherent answer indistinguishable from a
  real one.
- **Old-route preservation** — a new route is added alongside the
  old one as "safe migration"; the old route was supposed to be
  deleted.
- **Build-pass closure** — work declared done because tests run,
  even though consumer-facing behavior is wrong.
- **Pseudo-success** — a typed contract failure is hidden behind a
  fallback that returns "something" instead of failing closed.

Better prompts and better tests do not address this. The loop
reviewing the AI's output is the same loop that produced it. Nimi
Coding introduces **structural separation** instead.

## What Nimi Coding Is (And Is Not)

Nimi Coding is **not** another AI coding assistant. It does not write
code, dispatch to a provider, or run an agent loop.

It is the **standalone host-agnostic boundary package** that sits as
a governance layer under whichever AI host you use (Claude, Codex,
Gemini, OMX, or your own). It ships:

- a package-owned **methodology** under `methodology/**`
- typed **contracts** under `contracts/**`
- **bootstrap + host profile** config under `config/**`
- a **bootstrap spec seed** under `spec/**`
- the **`nimicoding` CLI** for bootstrap, validation, skill handoff,
  local closeout, topic lifecycle, sweep audit, sweep design, and
  high-risk execution gates
- **host adapter** profile overlays for external AI hosts

It deliberately does **not** ship:

- a packet-bound run kernel
- provider-backed AI execution
- a scheduler
- notification infrastructure
- an automation backend
- self-hosted methodology execution

Runtime ownership stays with an external AI host. The methodology
and contracts stay portable. You can change AI hosts tomorrow
without changing the methodology contract.

When a host project runs `nimicoding start`, the package-owned
sources are *projected* into that project's
`.nimi/{config,contracts,methodology,spec}/**` surface. The adopted
project then owns its `.nimi/spec/**` product authority. **The
package does not make a host read package source paths directly** —
the adopted project always reads its own projected `.nimi/**`.

## The Mental Model

Four moves separate Nimi Coding from a checklist:

| Move | What it means |
| --- | --- |
| **Authority is named** | Every change names where its truth lives (`.nimi/spec/**`), who owns the surface, and what kind of work is happening. |
| **Execution is packetized** | Implementation is bounded by a frozen packet declaring allowed reads, allowed writes, acceptance invariants, negative tests, stop lines, and reopen conditions — *before* the worker begins. |
| **Closure is multidimensional** | Four independent closure gates — Authority, Semantic, Consumer, Drift Resistance — must all hold. Three out of four is not closed. |
| **Roles are separated** | Manager owns wave admission and judgement; Worker owns the packet write set; Auditor performs structural review from a **structurally separate loop** (a different AI session, a different vendor). |

See [Four Closures](https://docs.nimi.ai/nimicoding/four-closures) and
[The Paradigm](https://docs.nimi.ai/nimicoding/the-paradigm) for the
full framework.

## Who This Is For

| Persona | What you get |
| --- | --- |
| Solo founder shipping with AI | Team-scale review discipline without a team — route the auditor through a second AI session on the same laptop |
| Small team (2–5) adopting AI | Structural review redundancy that scales without headcount |
| OSS maintainer accepting AI-authored PRs | Provable contribution discipline — packet boundaries, typed evidence, four-closure gates |
| Organization under AI-coding compliance pressure | Audit trail and structured acceptance independent of any single AI vendor |
| Researcher studying AI engineering practice | Observable methodology corpus over real repository history |

If you have ever watched an AI-assisted change look complete to every
available signal — type checker green, tests green, reviewer
approved — and turn out to be wrong about authority, scope, or
product meaning, this package is for you.

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | `>=24.0.0` |
| Package manager (consumer) | npm, pnpm, yarn, or compatible |
| pnpm (repository development) | `>=10.0.0` |

A version-controlled project is recommended — `start` creates files.

## Install

In the repository that should receive the `.nimi/**` governance
layer:

```bash
npm install --save-dev @nimiplatform/nimi-coding
# or
pnpm add -D @nimiplatform/nimi-coding
```

Check the CLI:

```bash
npx nimicoding --version
npx nimicoding --help
```

## 5-Minute Minimal Path

Most projects should start small. The first successful path is:

```bash
# 1. Bootstrap .nimi/** in your project root
npx nimicoding start

# 2. Check the bootstrap is healthy
npx nimicoding doctor --json

# 3. Hand off canonical spec reconstruction to your AI host
npx nimicoding handoff --skill spec_reconstruction --json

# 4. After the host consumes that payload and materializes .nimi/spec/**,
#    validate the canonical tree
npx nimicoding validate-spec-tree .nimi/spec
npx nimicoding validate-spec-audit
```

After this, you have a project-local `.nimi/**` truth surface, a
typed reconstruction of project authority into `.nimi/spec/**`, and
mechanical validators you can re-run on every change.

`handoff` exports an authoritative task payload. It does not call an AI
provider or run the reconstruction itself; the external host must
consume the payload, write or return the expected artifacts, and then
the local validators check the result.

You do **not** need to create topics, freeze packets, or run
high-risk gates for ordinary low-risk changes. Those tools exist for
authority-bearing, cross-module, multi-wave, or audit-sensitive work.

To remove only package-managed bootstrap material from a test
project (preserves `.nimi/spec/**`, `.nimi/local/**`, `.nimi/cache/**`,
and locally modified bootstrap files):

```bash
npx nimicoding clear --yes
```

## When You Need More: Topics, Waves, Packets

For authority-bearing, high-risk, or cross-module work, escalate to
the topic lifecycle. A topic groups one strategic change; waves split
the topic into bounded units of work; each wave freezes a **packet**
before the worker begins.

```bash
nimicoding topic create <slug> --justification <text>
nimicoding topic wave add <topic-id> <wave-id> <slug> \
  --goal <text> --owner-domain <domain>
nimicoding topic packet freeze <topic-id> --from <draft-path>
nimicoding handoff --skill high_risk_execution --json
nimicoding ingest-high-risk-execution --from result.json
nimicoding review-high-risk-execution --from ingest.json
nimicoding decide-high-risk-execution --from review.json \
  --acceptance accept.md --verified-at <iso8601>
```

Each step is bounded by typed validation. Skipping a step or
smuggling fields through means the CLI refuses (fail closed, no
exceptions).

## The Four Declared Skills

External AI hosts implement these skills; the `handoff` CLI emits a
machine-readable payload for each:

| Skill | Purpose | Required at bootstrap |
| --- | --- | --- |
| `spec_reconstruction` | Reconstruct canonical project authority into `.nimi/spec/**` with source basis and unresolved-gap tracking | yes |
| `doc_spec_audit` | Audit per-file grounding and inference against the canonical tree | yes |
| `audit_sweep` | Split a target root into auditable chunks and record typed evidence | no |
| `high_risk_execution` | Execute admitted high-risk packets with typed packet / orchestration / prompt / worker-output / acceptance evidence | no |

See [Skills](https://docs.nimi.ai/nimicoding/skills) for contract
detail.

## CLI Surface

Common commands, grouped by entry scenario:

```bash
# Bootstrap
nimicoding start
nimicoding sync --check
nimicoding doctor --json
nimicoding clear --yes

# Skill handoff and local closeout
nimicoding handoff --skill <id> --json
nimicoding closeout --from result.json --write-local

# Spec audit
nimicoding validate-spec-tree .nimi/spec
nimicoding validate-spec-audit
nimicoding blueprint-audit

# Topic lifecycle
nimicoding topic create <slug> --justification <text>
nimicoding topic wave add|select|admit ...
nimicoding topic packet freeze ...
nimicoding topic worker dispatch ...
nimicoding topic result record ...
nimicoding topic closeout ...
nimicoding topic true-close-audit ...
nimicoding topic run-next-step <topic-id> --json

# Sweep audit / sweep design
nimicoding sweep audit plan --root <dir> --json
nimicoding sweep audit chunk ...
nimicoding sweep design intake|packet-build|result-ingest|finalize ...

# High-risk execution gates
nimicoding admit-high-risk-decision --from <json> --admitted-at <iso8601>
nimicoding ingest-high-risk-execution --from <json>
nimicoding review-high-risk-execution --from <json>
nimicoding decide-high-risk-execution --from <json> \
  --acceptance <path> --verified-at <iso8601>

# Mechanical artifact validators
nimicoding validate-execution-packet <path>
nimicoding validate-orchestration-state <path>
nimicoding validate-prompt <path>
nimicoding validate-worker-output <path>
nimicoding validate-acceptance <path>
```

Conceptual CLI overview:
<https://docs.nimi.ai/nimicoding/cli>
Field-level reference:
<https://docs.nimi.ai/nimicoding/reference/cli-commands>

## How Does This Compare To …

| | Cursor / Copilot / Claude Code | Lint / TDD / Code review | Nimi Coding |
| --- | --- | --- | --- |
| Writes code | yes | no | **no** |
| Catches local bugs | partial | yes | n/a |
| Catches authority drift | no | no | **yes** |
| Catches consumer-closure failure | no | no | **yes** |
| Vendor lock-in | yes (per tool) | no | **no — host-agnostic** |
| Audit trail across AI sessions | chat transcript | PR comments | **typed evidence under `.nimi/**`** |

Nimi Coding sits *underneath* the AI host you already use. It is the
machinery that lets the work AI did graduate from "looks done" to
"closed across four dimensions, with evidence."

## Repository Map

| Path | Purpose |
| --- | --- |
| `bin/nimicoding.mjs` | Executable package binary |
| `cli/**` | CLI implementation |
| `config/**` | Package-owned bootstrap and host profile source |
| `contracts/**` | Package-owned machine-readable schemas and contracts |
| `methodology/**` | Package-owned methodology source (policies) |
| `spec/**` | Bootstrap spec seed and package scope source |
| `adapters/**` | External host adapter profile overlays (e.g. `oh-my-codex`) |
| `test/**` | Node test suite and fixtures |

Adopted projects use `.nimi/**` for the projected layer. This
repository itself keeps the package-owned source directly under
`config/**`, `contracts/**`, `methodology/**`, and `spec/**`.

## Development

```bash
pnpm install
pnpm test           # runs the node:test suite (341 tests at 0.2.5)
pnpm check:pack     # npm pack --dry-run
pnpm check:ci       # test + pack + CLI help/version smoke
```

Local CLI smoke:

```bash
node ./bin/nimicoding.mjs --version
node ./bin/nimicoding.mjs --help
```

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md).
The short version: keep changes scoped, preserve the host-agnostic
boundary, do not add runtime ownership unless the methodology
contract is explicitly redesigned, and run the relevant tests before
claiming the work is done.

## Publishing

Releases are tag-driven through GitHub Actions. A `vX.Y.Z` tag
publishes the matching `package.json` version after tests, dry-run
packing, and CLI smoke checks pass. The workflow also supports a
manual dry-run release gate.

The package publishes with npm provenance enabled.

## Security

Do not disclose vulnerabilities in public GitHub issues. Use a
private channel:

- GitHub private security advisory for
  [`nimiplatform/nimi-coding`](https://github.com/nimiplatform/nimi-coding/security/advisories/new)
- `security@nimi.ai`

See [SECURITY.md](SECURITY.md) for the supported reporting path.

## Documentation

Full reader documentation lives at <https://docs.nimi.ai/nimicoding>,
including:

- [The Paradigm](https://docs.nimi.ai/nimicoding/the-paradigm)
- [Four Closures](https://docs.nimi.ai/nimicoding/four-closures)
- [False Closure Typology](https://docs.nimi.ai/nimicoding/false-closure-typology)
- [Forbidden Shortcuts](https://docs.nimi.ai/nimicoding/forbidden-shortcuts)
- [Role Separation](https://docs.nimi.ai/nimicoding/role-separation)
- [Topic Lifecycle](https://docs.nimi.ai/nimicoding/topic-lifecycle)
- [The Package](https://docs.nimi.ai/nimicoding/the-package)
- [CLI Surface](https://docs.nimi.ai/nimicoding/cli)
- [Installation](https://docs.nimi.ai/nimicoding/installation)
- [Adoption Path](https://docs.nimi.ai/nimicoding/adoption-path)
- [Comparison](https://docs.nimi.ai/nimicoding/comparison)
- [Walkthrough](https://docs.nimi.ai/nimicoding/walkthrough)

## License

MIT. See [LICENSE](LICENSE).
