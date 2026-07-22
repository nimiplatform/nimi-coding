export const VERSION = "0.3.1";
export const PACKAGE_NAME = "@nimiplatform/nimi-coding";
export const LOCAL_GITIGNORE_ENTRIES = [".nimi/local/", ".nimi/cache/"];
export const REQUIRED_LOCAL_DIRS = [".nimi/local", ".nimi/cache"];

export const AGENTS_BEGIN = "<!-- nimicoding:managed:agents:start -->";
export const AGENTS_END = "<!-- nimicoding:managed:agents:end -->";
export const CLAUDE_BEGIN = "<!-- nimicoding:managed:claude:start -->";
export const CLAUDE_END = "<!-- nimicoding:managed:claude:end -->";

export const SPEC_GENERATION_AUDIT_REF = ".nimi/local/state/spec-generation/spec-generation-audit.yaml";
export const SPEC_GENERATION_AUDIT_CONTRACT_REF = "package://@nimiplatform/nimi-coding/contracts/spec-generation-audit.schema.yaml";
export const SPEC_GENERATION_INPUTS_REF = ".nimi/config/spec-generation-inputs.yaml";
export const SPEC_GENERATION_INPUTS_CONTRACT_REF = "package://@nimiplatform/nimi-coding/contracts/spec-generation-inputs.schema.yaml";
export const BLUEPRINT_REFERENCE_REF = ".nimi/local/state/spec-generation/blueprint-reference.yaml";

export const SPEC_GENERATION_AUDIT_REQUIRED_TOP_LEVEL_FIELDS = [
  "generation_mode",
  "canonical_target_root",
  "declared_profile",
  "input_roots",
  "files",
];
export const SPEC_GENERATION_AUDIT_SOURCE_BASIS_ENUM = [
  "grounded",
  "mixed_grounded_and_inferred",
  "inferred",
];

export const SPEC_GENERATION_AUDIT_COVERAGE_STATUS_ENUM = [
  "complete",
  "partial",
  "placeholder_not_allowed",
];
