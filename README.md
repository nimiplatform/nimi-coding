# Nimi Coding

Nimi Coding is an AI-native methodology and spec-governance package. It gives a repository a precise authority model, canonical spec construction contracts, managed governance projections, and deterministic validation.

Nimi Coding deliberately does not control an AI host. Planning, delegation, implementation, review, and task state belong to the host's native capabilities.

## Install and bootstrap

```bash
pnpm add -D @nimiplatform/nimi-coding
pnpm exec nimicoding start --yes
```

Bootstrap uses an exact deny-by-default allowlist and creates or updates only:

- `.nimi/config/spec-generation-inputs.yaml` — host-owned reconstruction inputs
- `.nimi/contracts/domain-admission.schema.yaml` — host-profile domain admission override
- `.nimi/methodology/authority-authoring.yaml` — compact normal-authoring guide
- managed guidance blocks in `AGENTS.md` and `CLAUDE.md`

Canonical product authority remains under `.nimi/spec/**`. Local generation evidence belongs under `.nimi/local/state/spec-generation/**` and never becomes product authority.

Canonical YAML files are closed `format` + non-empty `units` containers and may hold multiple explicit authority units. Unit identity is independent of file names, source order, moves, and regrouping. Canonical Markdown remains a single-unit profile.

## Core commands

```bash
# Canonical authority authoring and compiler kernel
pnpm exec nimicoding authority fmt .nimi/spec/authority/example.authority.yaml
pnpm exec nimicoding authority check .nimi/spec/authority --json
pnpm exec nimicoding authority compile .nimi/spec/authority --json
pnpm exec nimicoding authority query .nimi/spec/authority rule.checkout-session --max-bytes 32768 --json
pnpm exec nimicoding authority context .nimi/spec/authority rule.checkout-session --max-units 8 --max-bytes 65536 --json
pnpm exec nimicoding authority diff before/authority after/authority --max-bytes 262144 --json
pnpm exec nimicoding authority impact before/authority after/authority --dispositions .nimi/local/authority-impact-dispositions.yaml --max-bytes 262144 --json

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

For `authority diff` and `authority impact`, `--max-bytes` bounds the compact semantic diff/impact payload, not the complete CLI report or compiler diagnostics. Overflow returns null semantic payloads rather than truncation.

`classify-spec-tree` and `generate-spec-migration-plan` are non-mutating analysis commands. An emitted migration plan is local evidence, not an execution schedule.

## Authority model

1. The host's `.nimi/spec/**` is canonical product authority.
2. Package methodology and contracts remain installed-package authority; only the three explicitly allowlisted downstream files above are projected.
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
