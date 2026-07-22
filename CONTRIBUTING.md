# Contributing

Nimi Coding accepts changes to canonical-authority methodology, formatter/compiler primitives, exact managed projections, deterministic authority gates, and optional L3 repository checks. Historical-format reconstruction, product-semantic generation, AI-host control, provider execution, task-state management, and review-state management are outside this package.

Before opening a change:

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

Contract changes must update their parser or validator, negative cases, documentation, and package projection tests together. Do not add historical-format compatibility; Git history is the recovery evidence.

Never commit `.nimi/local/**`, credentials, provider transcripts, or private repository evidence.
