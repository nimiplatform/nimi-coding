# Changelog

All notable changes to `@nimiplatform/nimi-coding` are tracked here.

This project follows semantic versioning for published npm releases.

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
