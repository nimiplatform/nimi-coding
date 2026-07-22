# AGENTS.md

## Scope

This repository publishes `@nimiplatform/nimi-coding`. It owns the compact canonical-authority methodology, formatter, private compiler/read primitives, exact package projections, and deterministic gates.

It does not own project product semantics, historical-format reconstruction, an AI host's planning/delegation/execution/review/task state, or host workflow commands.

## Engineering rules

- Read package-internal authority contracts before changing compiler behavior.
- Preserve fail-closed authority semantics; never add inferred compatibility or fallback success.
- Keep package projections byte-stable through `nimicoding sync --check`.
- Treat only `*.authority.yaml` and `*.authority.md` under a host's `.nimi/spec/**` as canonical inputs.
- Keep generated and verification evidence under `.nimi/local/**`, never in product authority.
- Keep optional L3 repository governance separate from authority admission and host task execution.
- Prefer root-cause changes and test every contract change.
- ESM imports include `.mjs` or `.js` extensions.

## Verification

```bash
pnpm test
pnpm check:pack
pnpm check:ci
```
