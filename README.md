# Nimi Coding

Nimi Coding is an AI-native methodology and spec-governance package. It gives a repository a precise authority model, canonical spec construction contracts, managed governance projections, and deterministic validation.

Nimi Coding deliberately does not control an AI host. Planning, delegation, implementation, review, and task state belong to the host's native capabilities.

## Install and bootstrap

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

Bootstrap creates or updates only:

- `.nimi/config/**` — package defaults and host-owned spec input configuration
- `.nimi/contracts/**` — authority, taxonomy, placement, and audit contracts
- `.nimi/methodology/**` — reasoning and spec-construction methodology
- managed guidance blocks in `AGENTS.md` and `CLAUDE.md`

Canonical product authority remains under `.nimi/spec/**`. Local generation evidence belongs under `.nimi/local/state/spec-generation/**` and never becomes product authority.

## Core commands

```bash
# Managed projection lifecycle
pnpm exec nimicoding start --yes
pnpm exec nimicoding sync --check
pnpm exec nimicoding sync --apply
pnpm exec nimicoding doctor --json
pnpm exec nimicoding clear --yes

# Spec construction evidence
pnpm exec nimicoding blueprint-audit --json
pnpm exec nimicoding classify-spec-tree --root .nimi/spec --json
pnpm exec nimicoding generate-spec-migration-plan --root .nimi/spec --json
pnpm exec nimicoding generate-spec-derived-docs --profile nimi --scope spec-human-doc

# Deterministic validation
pnpm exec nimicoding validate-spec-tree -- .nimi/spec
pnpm exec nimicoding validate-spec-audit -- .nimi/local/state/spec-generation/spec-generation-audit.yaml
pnpm exec nimicoding validate-placement --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-table-family --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-projection-edges --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-guidance-bodies --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-domain-admission --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-tracked-output-admission --profile nimi --root .nimi/spec
pnpm exec nimicoding validate-spec-governance --profile nimi --scope all
pnpm exec nimicoding validate-ai-governance --profile nimi --scope all
```

`classify-spec-tree` and `generate-spec-migration-plan` are non-mutating analysis commands. An emitted migration plan is local evidence, not an execution schedule.

## Authority model

1. The host's `.nimi/spec/**` is canonical product authority.
2. Package methodology and contracts remain package authority and project into `.nimi/{methodology,contracts,config}/**`.
3. Generated views, audit evidence, and operational state are non-authoritative.
4. Unknown placement or unresolved semantic ambiguity fails closed.

See `methodology/spec-reconstruction.yaml`, `contracts/surface-taxonomy.schema.yaml`, and `contracts/placement-contract.schema.yaml` for the normative construction model.

## Development

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

Requires Node.js 24+ and pnpm 10+.
