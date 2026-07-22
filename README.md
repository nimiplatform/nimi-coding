# Nimi Coding

Nimi Coding provides a compact canonical-authority methodology, a formatter, private compiler primitives, and deterministic fail-closed gates. Projects author their own product meaning; Nimi Coding does not generate product semantics and does not control an AI host's planning, implementation, review, or task state.

## Install and start

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

`start` creates or maintains only:

- `.nimi/methodology/authority-authoring.yaml`, the compact AI-visible authoring guide;
- managed instruction blocks in `AGENTS.md` and `CLAUDE.md`;
- the ignored `.nimi/local/` root and its `.gitignore` entry.

It does not create `.nimi/spec`, authority examples, product semantics, config/contracts projections, caches, migration state, or generation-audit skeletons.

## Canonical workflow

The project authors only canonical `*.authority.yaml` or `*.authority.md` sources under `.nimi/spec/**`. Historical Markdown kernels, tables, guidance, registries, generated views, and evidence are not inferred or accepted there.

```bash
# Format every changed source file.
pnpm exec nimicoding authority fmt .nimi/spec/example.authority.yaml

# Admit the complete canonical root. This is the sole .nimi/spec conformance gate.
pnpm exec nimicoding authority check .nimi/spec --json

# Optional private compiler and read primitives, after check succeeds.
pnpm exec nimicoding authority compile .nimi/spec --json
pnpm exec nimicoding authority discover .nimi/spec "checkout session" --max-candidates 10 --max-bytes 65536 --json
pnpm exec nimicoding authority query .nimi/spec rule.checkout-session --max-bytes 32768 --json
pnpm exec nimicoding authority context .nimi/spec rule.checkout-session --max-units 8 --max-bytes 65536 --json
pnpm exec nimicoding authority refs .nimi/spec definition.session --direction incoming --relations applies_to --max-units 64 --max-edges 64 --max-bytes 131072 --json
pnpm exec nimicoding authority path .nimi/spec rule.checkout-session definition.session --traversal directed --relations applies_to,supersedes --max-hops 8 --max-units 64 --max-edges 128 --max-bytes 131072 --json
pnpm exec nimicoding authority subgraph .nimi/spec rule.checkout-session --direction outgoing --relations applies_to,supersedes --depth 3 --max-units 64 --max-edges 128 --max-bytes 262144 --json
pnpm exec nimicoding authority audit .nimi/spec --bindings .nimi/config/authority-verifiers.yaml --max-units 64 --max-edges 128 --max-bytes 262144 --json
pnpm exec nimicoding authority diff before/spec after/spec --max-bytes 262144 --json
pnpm exec nimicoding authority impact before/spec after/spec --dispositions .nimi/local/authority-impact-dispositions.yaml --max-bytes 262144 --json
pnpm exec nimicoding authority review . --base origin/main --bindings .nimi/config/authority-verifiers.yaml --dispositions .nimi/local/authority-impact-dispositions.yaml --max-units 64 --max-edges 128 --max-bytes 262144 --json
```

`discover` returns bounded deterministic lexical candidates when a task lacks an exact ID. It does not perform semantic search, select authority, attach context, claim complete recall, or prove absence on zero matches. After choosing an ID from task or product authority, call exact `query` or `context`. Candidate and byte bounds are explicit; failures return `discovery: null` and never silently remove candidates to fit bytes.

`context` returns the complete bounded closure of the root unit's declared outgoing `applies_to` and `supersedes` relations. It is an interpretation closure, not complete task context. Budget failure returns no partial packet.

`refs`, `path`, and `subgraph` return `nimicoding.authority-graph/v1`, a compact graph product containing node metadata, canonical authored edges, exact portable source locations, traversal/selection policy, counts, and explicit budgets. Relations are an explicit non-empty unique set limited to `applies_to` and `supersedes`. Directed paths follow authored direction; incidence paths may include clearly marked reverse topology steps. Paths are shortest-hop with a deterministic lexical tie-break. Unknown IDs and insufficient hop/unit/edge/UTF-8 byte budgets fail closed with `graph: null`; disconnected known IDs return a complete `found: false` path result.

`audit` evaluates explicit project-owned verifier bindings against one complete admitted snapshot. The initial built-in detector checks that one exact premise rule directly attaches each selected definition and that every target has the declared minimum of independent active-rule `applies_to` references. Results distinguish governance-bound observations, findings, and required-coverage gaps; `--sarif` projects the same truth to SARIF 2.1.0. Bindings do not make the package infer a predicate from premise prose, and budget or binding failure never returns a partial or clean audit.

```yaml
format: nimicoding.authority-verifier-bindings/v1
required_bindings: [checkout.session-reference]
bindings:
  - id: checkout.session-reference
    detector: minimum-independent-incoming-reference/v1
    premise: rule.checkout-session
    targets: [definition.session]
    minimum: 1
    policy: blocking
```

`impact` reports review obligations derived from declared relations. Disposition text does not prove that implementation, consumers, or tests are synchronized. Diff/impact budget failure returns no partial semantic payload.

`review` resolves the explicit base ref once to a full commit OID, reads the complete base `.nimi/spec` tree from Git objects, and retains exact filesystem handles while it recaptures the complete current tree and performs a capture-commit revalidation. It includes tracked edits/deletions and untracked or unsupported entries; unsupported content still reaches the existing compiler and fails closed. Materialization is isolated outside the worktree and Git administration roots. The compact `nimicoding.authority-review/v1` result combines the existing semantic diff, declared impact, and deterministic audit of the captured current snapshot. It never checkout/stash/reset/stage/commit, does not attribute current findings to the change, and does not manage branches, PRs, approvals, or releases.

Canonical YAML is a closed `format` + non-empty `units` container. Canonical Markdown is a bounded single-unit profile. Unit identity is explicit and independent of file names, ordering, moves, and regrouping. `authority check` recursively rejects unsupported files, symlinks, non-canonical bytes, illegal grammar, identity, owner/lifecycle, and relation semantics.

## Projection lifecycle

```bash
pnpm exec nimicoding start --yes
pnpm exec nimicoding sync --check
pnpm exec nimicoding sync --apply
pnpm exec nimicoding doctor --json
pnpm exec nimicoding clear --yes
```

Projection ownership is exact: Nimi Coding owns only the compact guide path and its marked blocks. Unrelated host files under `.nimi/config`, `.nimi/contracts`, `.nimi/methodology`, or elsewhere are not inspected by sync. Exact deprecated package projection paths fail `sync --check` and are never automatically deleted.

## Optional L3 repository governance

`validate-ai-governance` remains available for existing repository-level consumers. It performs deterministic repository checks and does not admit `.nimi/spec`, execute host tasks, or aggregate host workflow commands.

```bash
pnpm exec nimicoding validate-ai-governance --profile my-project --scope agents-freshness
```

## Surface boundaries

- **Public:** documented CLI commands and package documentation.
- **Canonical/project-owned:** `.nimi/spec/**/*.authority.{yaml,md}`.
- **Projected/AI-visible/package-owned:** `.nimi/methodology/authority-authoring.yaml` and marked instruction blocks.
- **Local/non-authoritative:** `.nimi/local/**`.
- **Package-internal:** grammar contracts, private AuthorityIR/SourceMap, and compiler implementation.

Graph navigation, deterministic audit, and Git-aware review do not export private AuthorityIR/SourceMap, infer prose relations or predicates, or provide a detector plugin runtime. Review is not a Git/PR workflow. SQLite, cache, incremental compilation, embeddings, semantic search, visualization, AI execution, Atlas, and historical-format compatibility are not admitted.

## Development

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

Requires Node.js 24+ and pnpm 10+.
