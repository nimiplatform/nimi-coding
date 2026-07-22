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
pnpm exec nimicoding authority query .nimi/spec rule.checkout-session --max-bytes 32768 --json
pnpm exec nimicoding authority context .nimi/spec rule.checkout-session --max-units 8 --max-bytes 65536 --json
pnpm exec nimicoding authority diff before/spec after/spec --max-bytes 262144 --json
pnpm exec nimicoding authority impact before/spec after/spec --dispositions .nimi/local/authority-impact-dispositions.yaml --max-bytes 262144 --json
```

`context` returns the complete bounded closure of the root unit's declared outgoing `applies_to` and `supersedes` relations. It is an interpretation closure, not complete task context. Budget failure returns no partial packet.

`impact` reports review obligations derived from declared relations. Disposition text does not prove that implementation, consumers, or tests are synchronized. Diff/impact budget failure returns no partial semantic payload.

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

SQLite, cache, incremental compilation, embeddings, search, visualization, AI execution, Atlas, and historical-format compatibility are not admitted.

## Development

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

Requires Node.js 24+ and pnpm 10+.
