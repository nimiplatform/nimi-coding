# Contributing

Thanks for taking the time to improve Nimi Coding.

## Project Boundary

This repository is the standalone `@nimiplatform/nimi-coding` package. Package
source lives directly under `config/**`, `contracts/**`, `methodology/**`, and
`spec/**`. Adopted projects receive `.nimi/**` projections at bootstrap time.

Do not add provider execution, scheduler ownership, notification backends,
packet-bound runtime orchestration, or self-hosted methodology execution unless
the active package contract explicitly admits that redesign.

## Development Setup

```bash
pnpm install
pnpm test
pnpm check:pack
```

Use `pnpm check:ci` before larger pull requests. It runs tests, npm pack
dry-run, and CLI smoke checks.

## Pull Request Expectations

- Keep changes scoped to one problem.
- Read existing files before editing.
- Prefer editing existing source over replacing whole files.
- Add or update focused tests for behavior changes.
- Update README or contract docs when user-visible behavior changes.
- Do not commit local `.nimi/local/**`, `.nimi/cache/**`, `.nimi/topics/**`, or
  other generated operational artifacts.

## Commit Sign-Off

This project accepts signed-off commits:

```bash
git commit -s
```

The sign-off certifies that you have the right to submit the contribution under
the project's license.
