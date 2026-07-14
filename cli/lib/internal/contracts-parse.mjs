import {
  SPEC_GENERATION_AUDIT_COVERAGE_STATUS_ENUM,
  SPEC_GENERATION_AUDIT_REQUIRED_TOP_LEVEL_FIELDS,
  SPEC_GENERATION_AUDIT_SOURCE_BASIS_ENUM,
} from "../../constants.mjs";
import { arraysEqual, isPlainObject, toStringArray } from "../value-helpers.mjs";
import { parseYamlText } from "../yaml-helpers.mjs";

const ACCEPTANCE_MODES = [
  "semantic_and_structural_parity_when_blueprint_exists",
  "placement_validity_before_generation",
];
const SPEC_GENERATION_INPUT_FIELDS = [
  "mode",
  "canonical_target_root",
  "code_inputs",
  "docs_inputs",
  "structure_inputs",
  "local_inputs",
  "forbidden_source_classes",
  "generation_order",
  "inference_rules",
  "acceptance_mode",
];
const SPEC_GENERATION_INPUT_DOCUMENT_FIELDS = [
  "version",
  "contract_ref",
  "spec_generation_inputs",
];

function toStringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function hasExactFields(value, expectedFields) {
  return isPlainObject(value)
    && arraysEqual(Object.keys(value).sort(), [...expectedFields].sort());
}

function isAllowedAuthorityRoot(root) {
  return typeof root === "string"
    && (root === ".nimi/spec" || root.startsWith(".nimi/spec/"))
    && !root.includes("..");
}

export function parseSpecGenerationAuditContract(text) {
  const parsed = parseYamlText(text);
  const requiredTopLevelFields = toStringArray(parsed?.required_top_level_fields);
  const requiredFileEntryFields = toStringArray(parsed?.required_file_entry_fields);
  const sourceBasisEnum = toStringArray(parsed?.source_basis_enum);
  const coverageStatusEnum = toStringArray(parsed?.coverage_status_enum);
  const hardConstraints = toStringArray(parsed?.hard_constraints);
  const expectedTopLevelFields = [
    ...SPEC_GENERATION_AUDIT_REQUIRED_TOP_LEVEL_FIELDS.slice(0, 4),
    "placement_report_ref",
    ...SPEC_GENERATION_AUDIT_REQUIRED_TOP_LEVEL_FIELDS.slice(4),
  ];
  const expectedFileEntryFields = [
    "canonical_path",
    "surface_class",
    "source_refs",
    "source_basis",
    "coverage_status",
    "unresolved_items",
  ];

  return {
    ok: parsed?.version === 2
      && String(parsed?.audit_contract?.id ?? "") === "canonical_spec_generation_audit"
      && String(parsed?.audit_contract?.target_ref ?? "") === ".nimi/local/state/spec-generation/spec-generation-audit.yaml"
      && arraysEqual(requiredTopLevelFields, expectedTopLevelFields)
      && arraysEqual(requiredFileEntryFields, expectedFileEntryFields)
      && arraysEqual(sourceBasisEnum, SPEC_GENERATION_AUDIT_SOURCE_BASIS_ENUM)
      && arraysEqual(coverageStatusEnum, SPEC_GENERATION_AUDIT_COVERAGE_STATUS_ENUM)
      && hardConstraints.includes("every_generated_canonical_file_requires_a_matching_audit_entry")
      && hardConstraints.includes("required_canonical_files_must_not_be_placeholder_not_allowed")
      && hardConstraints.includes("unresolved_or_inferred_content_must_be_explicit")
      && hardConstraints.includes("source_refs_must_stay_within_class_filtered_declared_inputs")
      && hardConstraints.includes("no_empty_success_looking_audit_entries"),
    requiredTopLevelFields,
    requiredFileEntryFields,
    sourceBasisEnum,
    coverageStatusEnum,
    hardConstraints,
  };
}

export function parseSpecGenerationInputsContract(text) {
  const parsed = parseYamlText(text);
  const contract = parsed?.input_contract;
  const requiredFields = toStringArray(parsed?.required_fields);
  const generationOrderEnum = toStringArray(parsed?.generation_order_enum);
  const hardConstraints = toStringArray(parsed?.hard_constraints);

  return {
    ok: parsed?.version === 3
      && String(contract?.id ?? "") === "canonical_spec_generation_inputs"
      && String(contract?.owner ?? "") === "nimi-coding"
      && arraysEqual(toStringArray(parsed?.mode_enum), ["class_filtered"])
      && arraysEqual(requiredFields, SPEC_GENERATION_INPUT_FIELDS)
      && generationOrderEnum.includes("classify_inputs")
      && generationOrderEnum.includes("validate_placement")
      && hardConstraints.includes("docs_roots_blanket_ingestion_is_forbidden")
      && hardConstraints.includes("each_input_file_must_have_an_accepted_surface_class_before_render"),
    requiredFields,
    generationOrderEnum,
    hardConstraints,
  };
}

export function parseSpecGenerationInputsConfig(text) {
  const parsed = parseYamlText(text);
  const config = parsed?.spec_generation_inputs;
  const codeInputs = Array.isArray(config?.code_inputs) ? config.code_inputs : [];
  const docsInputs = Array.isArray(config?.docs_inputs) ? config.docs_inputs : [];
  const structureInputs = Array.isArray(config?.structure_inputs) ? config.structure_inputs : [];
  const localInputs = Array.isArray(config?.local_inputs) ? config.local_inputs : [];
  const forbiddenSourceClasses = toStringArray(config?.forbidden_source_classes);
  const generationOrder = toStringArray(config?.generation_order);
  const inferenceRules = toStringArray(config?.inference_rules);
  const acceptanceMode = toStringOrNull(config?.acceptance_mode);

  return {
    ok: hasExactFields(parsed, SPEC_GENERATION_INPUT_DOCUMENT_FIELDS)
      && hasExactFields(config, SPEC_GENERATION_INPUT_FIELDS)
      && parsed.version === 3
      && String(parsed?.contract_ref ?? "") === ".nimi/contracts/spec-generation-inputs.schema.yaml"
      && config?.mode === "class_filtered"
      && config?.canonical_target_root === ".nimi/spec"
      && docsInputs.length > 0
      && docsInputs.every((entry) => isPlainObject(entry)
        && isAllowedAuthorityRoot(entry.root)
        && Array.isArray(entry.allowed_surface_classes)
        && Array.isArray(entry.forbidden_surface_classes)
        && entry.use_as_authority === true)
      && Array.isArray(codeInputs)
      && Array.isArray(structureInputs)
      && Array.isArray(localInputs)
      && forbiddenSourceClasses.length > 0
      && generationOrder.includes("classify_inputs")
      && generationOrder.includes("validate_placement")
      && inferenceRules.includes("no_blanket_docs_roots")
      && ACCEPTANCE_MODES.includes(acceptanceMode),
    mode: toStringOrNull(config?.mode),
    canonicalTargetRoot: toStringOrNull(config?.canonical_target_root),
    codeRoots: codeInputs.map((entry) => String(entry?.root ?? "")).filter(Boolean),
    docsRoots: docsInputs.map((entry) => String(entry?.root ?? "")).filter(Boolean),
    structureRoots: structureInputs.map((entry) => String(entry?.root ?? "")).filter(Boolean),
    localRoots: localInputs.map((entry) => String(entry?.root ?? "")).filter(Boolean),
    humanNotePaths: [],
    benchmarkBlueprintRoot: null,
    benchmarkMode: "none",
    acceptanceMode,
    generationOrder,
    inferenceRules,
  };
}

export function parseBlueprintReference(text) {
  if (!text) {
    return {
      ok: true,
      present: false,
      mode: null,
      root: null,
      canonicalTargetRoot: null,
      equivalenceContractRef: null,
    };
  }

  const parsed = parseYamlText(text);
  const reference = parsed?.blueprint_reference;
  const mode = toStringOrNull(reference?.mode);
  const root = toStringOrNull(reference?.root);
  const canonicalTargetRoot = toStringOrNull(reference?.canonical_target_root);
  const equivalenceContractRef = toStringOrNull(reference?.equivalence_contract_ref);
  const localRefValid = equivalenceContractRef === null
    || (equivalenceContractRef.startsWith(".nimi/local/") && !equivalenceContractRef.includes(".."));

  return {
    ok: parsed?.version === 2
      && ["repo_spec_blueprint", "custom_blueprint"].includes(mode)
      && typeof root === "string"
      && canonicalTargetRoot === ".nimi/spec"
      && localRefValid,
    present: true,
    mode,
    root,
    canonicalTargetRoot,
    equivalenceContractRef,
  };
}
