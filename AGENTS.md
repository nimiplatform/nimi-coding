# AGENTS.md

## Scope

This repository publishes `@nimiplatform/nimi-coding`. It owns methodology, spec construction contracts, managed `.nimi/{config,contracts,methodology}` projections, and deterministic validators.

It does not own an AI host's planning, delegation, execution, review, or task state. Do not add provider runtimes or host-control abstractions here.

## Engineering rules

- Read package contracts before changing validator behavior.
- Preserve fail-closed authority semantics; do not add fallback success.
- Keep package projections byte-stable through `nimicoding sync --check`.
- Keep product authority under the host's `.nimi/spec/**`.
- Keep generated and verification evidence outside product authority.
- Prefer root-cause changes and test every contract change.
- ESM imports include `.mjs` or `.js` extensions.

## Verification

```bash
pnpm test
pnpm check:pack
pnpm check:ci
```
