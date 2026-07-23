# Nimi Coding

[简体中文](./README.zh-CN.md)

**Deterministic authority for AI coding systems and third-party extensions.**

Nimi Coding turns project-owned normative specifications into stable identities, exact source locations, authored relations, and bounded fail-closed machine products. AI hosts, agent frameworks, CI systems, editor tooling, and third-party extensions can use those products to discover authority, assemble evidence, navigate relationships, and review exact changes without treating model inference as repository truth.

Most end users should not need to invoke `nimicoding` directly. The primary integration surface is the documented CLI and its purpose-specific JSON products. Nimi Coding is not an AI agent, planner, code generator, approval workflow, or universal specification language.

## Why it exists

AI models are good at generating code. They are less reliable at determining which document is authoritative, whether a search result is complete, how a rule moved across files, which declared relationships a change affects, or whether available evidence actually proves conformance.

Nimi Coding makes those questions explicit:

| AI coding problem | Nimi Coding control |
| --- | --- |
| Several documents appear authoritative | One closed canonical authority boundary |
| Paths and headings change | Stable logical unit IDs independent of files and order |
| Search returns noisy or truncated context | Bounded discovery, exact query, declared context, and graph products |
| A model cannot cite the exact source | Portable field- and relation-level SourceMap locations |
| Textual diffs obscure semantic change | Stable-ID semantic diff and declared impact obligations |
| “No result” is presented as “clean” | Explicit budgets, completeness, gaps, refusal, and failure semantics |
| A Git review may mix moving inputs | Immutable base OID plus race-checked complete worktree capture |
| A file or test name is treated as proof | Evidence and conformance are separate product states |

## Product model

```text
Project-owned canonical authority
  .nimi/spec/**/*.authority.{yaml,md}
                    │
                    ▼
Authority Foundation
  fmt · check · compile CLI over private AuthorityIR/SourceMap
                    │
                    ▼
Spec Intelligence Plane
  discover · query · context · refs/path/subgraph
  diff · impact · audit · review · evidence
                    │
                    ▼
Purpose-specific JSON / human output / SARIF (audit only)
                    │
                    ▼
AI hosts · third-party extensions · CI · future editor/UI surfaces
```

Projects own all product meaning. Nimi Coding admits, locates, relates, and derives bounded products from that meaning; it does not invent it. OpenAPI, JSON Schema, Protobuf, tests, ADRs, and design documents remain the right tools for specialized structure, executable verification, rationale, examples, and diagrams.

## What works today

| Layer | Current capability | Truth boundary |
| --- | --- | --- |
| Authority Foundation | Canonical YAML/Markdown, formatter, complete-root check, private deterministic compiler and SourceMap | Unknown or unsupported canonical input is rejected, not ignored |
| Discovery and exact reads | Exact kind/owner/scope/lifecycle filters, normalized lexical snippets, optional direct relation preview, exact query, bounded declared context | No semantic search, automatic authority selection, or absence proof |
| Graph navigation | Incoming/outgoing refs, deterministic paths, bounded subgraphs over `applies_to` and `supersedes` | Only authored relations; no inferred semantic graph |
| Change intelligence | Stable-ID semantic diff and relation-derived impact obligations | Impact is a review requirement, not synchronization proof |
| Deterministic audit | Project-owned verifier bindings, observations/findings/required gaps, JSON and SARIF 2.1.0 | The current built-in detector is a narrow governance verifier, not a natural-language contradiction engine |
| Git-aware review | Immutable base commit plus exact, race-checked current worktree snapshot composed through compile/diff/impact/audit | Read-only; not branch, PR, approval, or release orchestration |
| Authority-to-code evidence | Exact authority/scope to declared package-script command/test target reachability | Static narrow slice only; commands/tests are not executed and completed evidence leaves conformance `not_evaluated` |

The current Nimi-realm validation corpus contains 38 canonical containers, 793 authority units, and 1,260 authored relations. Those figures demonstrate a real large-corpus replay; they are not package limits or a claim that the grammar covers every possible domain.

## Five-minute adoption path

Install and initialize the package:

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

`start` creates the compact AI-visible authoring guide, managed instruction blocks in `AGENTS.md` and `CLAUDE.md`, and the ignored `.nimi/local/` root. It does not generate product semantics or create `.nimi/spec` for the project.

Author a complete canonical source such as `.nimi/spec/checkout.authority.yaml`:

```yaml
format: nimicoding.authority/v1
units:
  - id: definition.checkout-session
    kind: definition
    owner: team.checkout
    lifecycle: active
    title: Checkout session
    meaning: A server-owned session representing an active checkout.
    relations: []
  - id: rule.checkout-session
    kind: rule
    owner: team.checkout
    lifecycle: active
    title: Checkout requires a server-owned session
    modality: must
    scope:
      - api.checkout
    statement: Checkout operations use a server-owned checkout session.
    condition: Whenever a checkout operation begins.
    failure: Reject the operation.
    relations:
      - type: applies_to
        target: definition.checkout-session
```

Format changed files, admit the complete root, and query one exact unit:

```bash
pnpm exec nimicoding authority fmt .nimi/spec/checkout.authority.yaml
pnpm exec nimicoding authority check .nimi/spec --json
pnpm exec nimicoding authority query .nimi/spec rule.checkout-session --max-bytes 32768 --json
```

`authority check` on the complete root is the sole .nimi/spec conformance gate. Formatting a file does not admit its semantics, and checking only a changed file cannot replace the complete-root check. When `--scope-bindings <file>` is supplied, check also requires an exact bidirectional match between registered scopes and active-rule scope use; it validates binding declarations without resolving repository paths.

### Static authority anchors

`authority anchors` performs bounded, read-only lexical validation against one exact Git worktree root:

```bash
pnpm exec nimicoding authority anchors . \
  --spec .nimi/spec \
  --scope-bindings .nimi/config/authority-scope-bindings.yaml \
  --max-units 1024 \
  --max-anchors 4096 \
  --max-bytes 2097152 \
  --json
```

The anchor grammar is closed and case-sensitive. A **token** is one maximal non-whitespace sequence; punctuation attached without whitespace remains part of that token.

- **Class A — file path:** a token containing at least one `/` and ending exactly in one of `.mjs`, `.js`, `.ts`, `.tsx`, `.rs`, `.go`, `.yaml`, `.yml`, `.md`, `.json`, `.proto`, or `.ps1`. The whole token must equal a path returned by the repository-root `git ls-files` tracked-file inventory. There is no path normalization, prefix removal, or inferred match.
- **Class B — package script:** the token `pnpm`, exactly one ASCII space, then one maximal non-whitespace script-name token. The name is admitted when it contains `:` or fully matches `[a-z][a-z0-9:-]*`; it must be an exact own key of the root `package.json` `scripts` object. Nothing is executed.

Only active-unit `meaning`, `statement`, `condition`, and `failure` fields are scanned. With `--scope-bindings`, every `path_glob` must match at least one tracked file; `*` excludes `/`, `?` matches one non-`/` character, and `**` crosses path segments. `module` and `command` bindings remain structure-only in this version. Human and JSON results report `{units, anchorsChecked, diagnostics}`; anchor diagnostics are ordered by unit ID, anchor text, field, and class and identify the exact unit and field. Unit, anchor, and compact UTF-8 result-byte budgets reject the whole validation rather than truncating it.

Canonical YAML is a closed `format` plus non-empty `units` container. Canonical Markdown is a strict single-unit profile. The model is intentionally compact: `Rule` and `Definition`, `active` and `removed`, `must` and `must_not`, plus authored `applies_to` and linear `supersedes` relations.

If a domain needs member-level API, schema, enum, state-machine, formula, or catalog structure that this grammar does not support, keep that precision in a specialized artifact outside the canonical grammar. Connect it only through an explicitly admitted project binding or adapter; the current built-in evidence slice supports package-script targets, not general API, schema, consumer, or runtime integration. Do not add arbitrary canonical fields: unknown fields fail closed so that no consumer can silently ignore intended authority.

## AI host and extension journey

```text
Task has no exact authority ID
  → discover bounded lexical candidates
  → host or project authority chooses an exact ID
  → query/context/refs/path/subgraph
  → host plans and edits
  → fmt changed sources + check the complete root
  → review immutable base versus exact worktree
      (semantic diff + declared impact + current audit)
  → separately, if configured, inspect current-worktree evidence
```

The host owns authority selection, planning, editing, retries, remediation, review state, and completion. Nimi Coding owns request validation, deterministic computation, explicit budgets, exact locations, and honest result boundaries.

For machine integration, invoke the CLI with an argument array and consume both its exit status and JSON envelope. Read product-specific operation, completeness, policy, gap, and evidence states; never infer clean from an empty candidate/finding array. Invalid usage or internal failure and a completed-but-blocking or incomplete product have distinct command-specific exits.

In a configured Git project, use exact Git-aware review for one composed authority change product:

```bash
pnpm exec nimicoding authority review . \
  --base origin/main \
  --bindings .nimi/config/authority-verifiers.yaml \
  --dispositions .nimi/local/authority-impact-dispositions.yaml \
  --max-units 1024 \
  --max-edges 4096 \
  --max-bytes 2097152 \
  --json
```

This example assumes that the repository already owns valid verifier bindings and impact dispositions, and that `origin/main` resolves to a commit containing `.nimi/spec`. `start` intentionally creates none of those project semantics or governance files.

The base ref is resolved once to a full commit OID. The base `.nimi/spec` tree is read from Git objects; the complete current `.nimi/spec` filesystem tree includes tracked unchanged files, edits, deletions, untracked files, and unsupported entries. Capture races, missing objects, invalid corpora, malformed bindings/dispositions, and insufficient budgets refuse the result instead of publishing a mixed or false-clean review. The command never checks out, stashes, resets, stages, commits, or manages a PR.

## Comparison: old Nimi, current Nimi Coding, and a mature conventional spec stack

“Conventional spec” here means a serious combination of Markdown/ADR, OpenAPI, JSON Schema or Protobuf, tests, and repository conventions—not an artificially weak pile of prose.

| Dimension | Pre-refactor Nimi spec system | Current Nimi Coding | Mature conventional spec stack |
| --- | --- | --- | --- |
| Authority boundary | Human contracts, tables, generated views, maps, and profile rules required precedence conventions | One closed canonical authority root | Several specialized sources of truth, usually without one cross-format boundary |
| Reference corpus shape | 144 mixed files: 101 Markdown, 43 YAML, including 33 generated views and 42 tables | 38 canonical containers compiling to 793 stable units | Project-specific and heterogeneous |
| Identity | Contract IDs, `R-*` anchors, paths, and table rows were not universal | One stable ID per unit, independent of file, order, move, or regroup | Strong inside some formats, inconsistent across formats |
| Domain-internal precision | Some tables modeled entities, required fields, API operations, Prisma/OpenAPI/service locators directly | Many enum/schema/state/catalog details remain atomic prose inside a Definition | OpenAPI, Schema, Protobuf, and dedicated DSLs are strongest in their domains |
| Human rationale | Rich contracts and generated guides | Deliberately compact; long rationale belongs outside canonical authority | ADRs and design documents are strongest |
| Admission | Multiple profile-specific validators and generators | One complete-root, fail-closed admission oracle | Strong per structured format; Markdown and cross-format admission vary |
| Unknown input | Behavior depended on the consuming profile/tool | Rejected everywhere under the canonical root | Often preserved or silently ignored unless a schema/linter forbids it |
| Duplication and drift | Human/table/generated/alignment representations could diverge | One canonical unit representation; derived products are rebuildable | Cross-document and cross-format drift remains common |
| AI retrieval | Search and project-specific projections had duplicate/noisy inputs | Bounded discovery, exact query, and purpose-specific JSON | Full-text/RAG is flexible but completeness and noise vary |
| Source traceability | Different profiles exposed locations differently | Uniform portable SourceMap for units, fields, and authored relations | Good within individual tools, inconsistent across tools |
| Relationship graph | Links, maps, custom fields, and Atlas-like projections | One authored, bounded `applies_to`/`supersedes` graph | `$ref`, links, imports, and conventions remain format-specific |
| Conflict discovery | Custom checks could find project-specific drift | Structural conflicts are deterministic; prose contradictions still require AI/human analysis | Format-local conflicts can be strong; cross-format conflict remains difficult |
| Semantic change | File diff and generated drift dominated | Stable-ID semantic diff; rename/regroup/format-only changes can be semantic zero | Prose is line-diffed; specialized formats may have excellent domain diff tools |
| Impact and audit | Project scripts, maps, and team knowledge | Declared relation impact plus project-bound finding/gap semantics | Build graphs, CODEOWNERS, linters, and tests are strong but fragmented |
| Git review | No unified exact authority snapshot product | Immutable-base, race-checked worktree review | Usually Git diff plus independent format-specific checks |
| Spec-to-code relationship | Direct paths were detailed but could become stale | A narrow, identity-bound package-script evidence slice exists | Codegen, type checking, and contract tests can be substantially stronger |
| Executable conformance | Some custom scripts checked specific project facts | Intentionally not claimed by current evidence | High-quality tests and executable contracts are strongest |
| Ecosystem | Highly project-specific | Stable CLI/JSON products, but no public JS SDK or model/tool standard yet | OpenAPI/Schema/test ecosystems and third-party interoperability are mature |
| Authoring cost | Multiple representations and generators were expensive | IDs, owners, scopes, lifecycles, and relations require discipline | Lowest during exploration; governance cost rises with corpus size |
| Best fit | A project-specific integrated spec system | Stable normative authority control alongside a large, AI-consumed estate of specialized specs | Exploration and specialized API/data/behavior contracts |

The redesign is not a universal win on every axis. It is a deliberate exchange: current Nimi Coding gains a uniform authority coordinate system, deterministic machine consumption, and exact review semantics, while specialized formats retain domain precision, executable verification, ecosystem maturity, and human explanation.

## Comprehensive assessment

The current architecture is already a strong substrate for AI coding because it addresses authority identity, retrieval, traceability, change review, and false-clean prevention without depending on a particular model.

Three levels of product truth should remain distinct:

1. **Strong today:** stable identity, fail-closed admission, exact SourceMap, authored graph navigation, bounded machine products, semantic diff, and exact Git review.
2. **Improved but incomplete:** locating and tracing the exact inputs for human/AI conflict review, task-context assembly, owner/scope accountability, and spec-to-code traceability. Contradiction judgment itself is not a deterministic product.
3. **Intentionally not solved:** universal business-semantic completeness, automatic authority selection, executable code conformance, model reasoning, and AI workflow orchestration.

The long-term ceiling is high if Nimi Coding standardizes the authority protocol rather than attempting to absorb every domain language. A model-native ecosystem could train AI systems to discover before guessing, resolve exact IDs, distinguish authored facts from inference, honor gaps and completeness, and request review/evidence after edits. Deterministic runtime products must remain the oracle; model familiarity must never replace admission or evidence.

## Safety and truth boundaries

- Only `*.authority.yaml` and `*.authority.md` under `.nimi/spec/**` are canonical product authority.
- IDs, relations, owners, and scopes are declared facts. Nimi Coding does not infer relations or organizational truth from prose.
- `discover` is deterministic lexical candidate retrieval, not semantic search, selection, context assembly, or absence proof.
- `context` is a complete bounded outgoing interpretation closure, not complete task context.
- `audit` evaluates explicitly bound deterministic governance checks; it does not prove that all business rules are non-contradictory.
- `impact` produces declared review obligations; a disposition does not prove implementation or tests are synchronized.
- `review` audits the captured current snapshot and does not attribute a current finding to the change unless a future product explicitly compares finding fingerprints.
- Snapshot no-follow hardening is platform-dependent. On `win32`, Node.js does not expose `O_NOFOLLOW`/`O_DIRECTORY`, so snapshot capture uses surrounding `lstat`/`realpath` validation without descriptor-level no-follow guarantees.
- `evidence` currently proves only declared package-script target reachability. It executes no command or test; every completed evidence product reports `conformanceStatus: not_evaluated`, while refused input returns no evidence product.
- Raw AuthorityIR, SourceMap internals, and compiler implementation are package-private. There is currently no public JavaScript API (`exports` is empty).
- `.nimi/local/**` is derived or local evidence, never product authority.

## Future roadmap

The roadmap is paused at the current validated baseline. The entries below are candidate lanes, not implementation authorization, release promises, or an implied sequence. A future iteration should select one real adopter journey at a time.

| Candidate lane | Intended product | Entry condition |
| --- | --- | --- |
| Stateless AI tool adapter | Typed tools over current bounded JSON products, potentially via MCP or an extension API | A real host integration demonstrates that direct CLI invocation is insufficient |
| General M4 API/consumer evidence | API/consumer locators and producer → API → consumer reachability | A real canonical-authority seam exists; no inference from the current package-script slice |
| D2 IDE/LSP | Live diagnostics, exact-ID navigation/completion, full-snapshot unsaved-buffer overlays | A sustained editor journey justifies a separate delivery unit |
| D3 local Studio | Read-only unit/graph/diff/impact/audit/evidence exploration | Several real review/exploration journeys are validated first |
| D4 external semantic candidates | Model/embedding/reranking candidates with provenance and abstention | Lexical/graph shortcomings are measured on an owner-approved task corpus |
| E1 multi-repository Atlas | Visibility-filtered composition of canonical repository snapshots | Ecosystem repositories, identity, visibility, ownership, and workspace membership are explicit |

Conditional work remains separate:

- Structured Definitions, replacement DAGs, owner/scope registries, or a public library API require demonstrated authoring/query/consumer loss.
- Storage, SQLite, cache, or incremental compilation require a real workload to violate a predeclared SLO and profiling to identify repeated parse/index/join as the cause.
- Version bump, 4.0.0, tag, publish, ecosystem activation, and release compatibility are independent release decisions.
- AI planning, delegation, execution, approval, task state, model/provider orchestration, and inferred model findings do not belong in the core package.

## Command reference

The current public integration surface is the CLI. All budgets are explicit positive safe integers; a product that cannot fit its required budget refuses rather than truncating a blocking-capable result.

| Purpose | Commands |
| --- | --- |
| Author and admit | `authority fmt`, `authority check`, `authority compile` |
| Find and read | `authority discover`, `authority query`, `authority context` |
| Navigate | `authority refs`, `authority path`, `authority subgraph` |
| Analyze and review | `authority audit`, `authority diff`, `authority impact`, `authority review` |
| Validate lexical anchors | `authority anchors` |
| Connect bounded evidence | `authority evidence` |
| Project lifecycle | `start`, `sync`, `doctor`, `clear` |
| Optional L3 repository governance | `validate-ai-governance` |

<details>
<summary>Complete authority command syntax</summary>

```text
nimicoding authority fmt <file> [--check] [--json]
nimicoding authority check <path> [--scope-bindings <file>] [--json]
nimicoding authority compile <path> [--json]
nimicoding authority anchors <repository-path> --spec <corpus-path> [--scope-bindings <file>] --max-units <n> --max-anchors <n> --max-bytes <n> [--json]
nimicoding authority discover <path> <query> [--kind <definition|rule>] [--owner <exact-owner>] [--scope <exact-scope>] [--lifecycle <active|removed>] --max-candidates <n> --max-snippet-terms <n> --max-bytes <n> [--preview-direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-edges <n>] [--json]
nimicoding authority query <path> <id> --max-bytes <n> [--json]
nimicoding authority context <path> <id> --max-units <n> --max-bytes <n> [--json]
nimicoding authority refs <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority path <path> <from-id> <to-id> --traversal <directed|incidence> --relations <comma-separated-relation-types> --max-hops <n> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority subgraph <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --depth <n> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority audit <path> --bindings <file> --max-units <n> --max-edges <n> --max-bytes <n> [--json|--sarif]
nimicoding authority diff <before-path> <after-path> --max-bytes <n> [--json]
nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <n> [--json]
nimicoding authority review <repository-path> --base <git-ref> --bindings <file> --dispositions <file> --max-units <n> --max-edges <n> --max-bytes <n> [--json]
nimicoding authority evidence <repository-path> --bindings <tracked-.nimi/config-path> [--probe-results <.nimi/local-path>] --max-units <n> --max-bindings <n> --max-locators <n> --max-edges <n> --max-input-bytes <n> --max-bytes <n> [--json]
```

</details>

Relation types are a non-empty unique subset of the closed set `applies_to,supersedes`; discovery relation preview requires direction, relation types, and edge budget together.

<details>
<summary>Project lifecycle, governance, and global syntax</summary>

```text
nimicoding start [--yes]
nimicoding sync [--apply|--check|--dry-run] [--json]
nimicoding clear [--yes]
nimicoding doctor [--verbose|--json]
nimicoding validate-ai-governance --profile <profile-id> --scope <all|agents-freshness|context-budget|structure-budget|high-risk-doc-metadata> [--json]
```

Global presentation options are `--lang en|zh`, `--color`, and `--no-color`.

</details>

Projection ownership is exact: `start`/`sync` own only their documented managed paths and marked instruction blocks. Files outside those exact managed surfaces are not inspected or modified by projection sync. Optional `validate-ai-governance` remains separate from authority admission and host task execution.

## Development

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

Requires Node.js 24+ and pnpm 10+.
