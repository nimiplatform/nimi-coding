# Contributing

Nimi Coding accepts changes to methodology, spec construction, managed projections, and deterministic governance validators. AI-host control, provider execution, task-state management, and review-state management are outside this package.

Before opening a change:

```bash
pnpm install
pnpm test
pnpm check:pack
pnpm check:ci
```

Contract changes must update their parser or validator, negative cases, documentation, and package projection tests together. Do not add compatibility branches for pre-0.3 behavior; Git history is the migration evidence.

Never commit `.nimi/local/**`, `.nimi/cache/**`, credentials, provider transcripts, or private repository evidence.
