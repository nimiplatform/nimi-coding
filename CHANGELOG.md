# Changelog

All notable changes to `@nimiplatform/nimi-coding` are tracked here.

This project follows semantic versioning for published npm releases.

## 0.2.8

- Fixed Windows audit-sweep execution for JavaScript auditor entrypoints by
  invoking `.cjs`, `.js`, and `.mjs` binaries through the active Node runtime
  before passing CLI arguments to Codex or Claude auditors.
- Hardened post-update proof lineage selection by ordering worker prompts with
  nanosecond file timestamps and explicit dispatch-time mtimes, so rapid
  remediation dispatches do not collapse into ambiguous or stale prompt
  lineage.
- Made README example alignment tolerant of CRLF checkouts without relaxing the
  documented topic command shape.

## 0.2.7

- Added delegated projection admissions for spec-authority sweeps so a host
  `.nimi/spec/**` subtree projected from a parent or external source authority
  can audit host-local projection evidence while delegating source-owned
  implementation refs through an explicit boundary.
- Kept delegated projections as audit modeling only: the CLI records and
  validates source-authority boundaries, but does not read, sync, rewrite, or
  mutate parent/external source repositories.
- Ignored npm package/import specifiers and explicit `./` relative refs when
  deriving declared evidence targets, so package subpaths and YAML fragment refs
  do not get promoted into project-local evidence paths.

## 0.2.6

- Hard-cut high-risk admission records out of active `.nimi/spec/**`
  authority. Admission records are now local-only evidence under
  `.nimi/local/high-risk-admissions.yaml`; product authority must live in
  domain spec files.
- Removed the `product_admission_registry` surface class and changed
  `admit-high-risk-decision` to write local evidence through `--write-local`
  instead of writing canonical spec truth.

## 0.2.5

- Fixed the `cli_version` field in `config/bootstrap.yaml` drifting away from
  the package version; it had been stale since the 0.2.3 release missed the
  bump and 0.2.4 inherited the miss.
- Added a release guard test asserting that `cli_version`, the `package.json`
  version, and the `VERSION` constant stay in lockstep, so future releases
  cannot silently miss the bump.

## 0.2.4

- Added the `product_state_machine` and `product_record_schema` table families
  for product-owned kernel tables, covering state machines and record-schema
  tables that are neither closed enums, generic product catalogs, nor release
  gate registries.
- Kept table-family admission fail-closed: any table family outside the
  admitted set is still rejected with `unknown_table_family`.

## 0.2.3

- Added `nimicoding sweep audit chunk audit-claude` for Claude-backed sweep
  chunk audits with structured JSON output, evidence ingestion, review, freeze,
  post-chunk validation, and run-ledger events.
- Hardened Claude auditor output handling by normalizing Claude CLI JSON result
  wrappers, including `structured_output` and replayed raw output files.
- Tightened audit evidence normalization so AGENTS, README, spec, contract, and
  methodology refs are treated as context rather than implementation evidence.
- Improved P0/P1 validity and spec-authority evidence mapping so context-only
  chunks can be marked not applicable while declared implementation refs,
  including `.prisma` surfaces, map to the correct owner roots.
- Updated default audit-sweep exclusions for common tool state and archive
  directories while keeping host-specific `nimi/**` exclusions out of the
  package defaults.

## 0.2.2

- Fixed v2 doctor lifecycle/readiness derivation so host projects using the
  class-filtered surface model no longer depend on legacy `.nimi/spec/_meta`
  carriers or `.nimi/spec/bootstrap-state.yaml`.
- Fixed v2 handoff readiness for `doc_spec_audit` so it can run when the
  canonical tree is present but the local generation audit still needs repair.

## 0.2.1

- Added the `gate_registry` table family for product-owned release gate
  registries that are not closed enums or generic product catalogs.

## 0.2.0

- Split Nimi Coding into a standalone public package.
- Published the `nimicoding` CLI boundary for bootstrap, validation, handoff,
  local closeout, topic lifecycle, sweep audit, sweep design, and high-risk
  execution gates.
- Kept runtime execution, scheduling, notifications, provider invocation, and
  self-hosted methodology execution outside the package boundary.
