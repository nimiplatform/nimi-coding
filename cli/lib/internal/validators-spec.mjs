import path from "node:path";

import {
  SPEC_GENERATION_AUDIT_CONTRACT_REF,
  SPEC_GENERATION_AUDIT_COVERAGE_STATUS_ENUM,
  SPEC_GENERATION_AUDIT_SOURCE_BASIS_ENUM,
} from "../../constants.mjs";
import {
  loadBlueprintReference,
  loadSpecGenerationAuditContract,
  loadSpecGenerationInputsConfig,
} from "../contracts.mjs";
import { readTextIfFile } from "../fs-helpers.mjs";
import { isPlainObject } from "../value-helpers.mjs";
import { parseYamlText } from "../yaml-helpers.mjs";
import {
  makeValidatorRefusal,
  VALIDATOR_NATIVE_REFUSAL_CODES,
} from "./validators-shared.mjs";
import {
  validateDomainAdmission,
  validateGuidanceBodies,
  validatePlacement,
  validateProjectionEdges,
  validateTableFamily,
} from "./surface-taxonomy-validators.mjs";
import {
  collectTreeFiles,
  isDeclaredInputsCompatibleWithConfig,
  isSourceRefWithinDeclaredRoots,
} from "./validators-spec-helpers.mjs";

async function loadRequiredFiles(projectRoot) {
  const text = await readTextIfFile(path.join(projectRoot, ".nimi", "methodology", "spec-reconstruction.yaml"));
  const parsed = parseYamlText(text);
  return Array.isArray(parsed?.reconstruction?.target_tree_shape?.minimal_required_outputs)
    ? parsed.reconstruction.target_tree_shape.minimal_required_outputs.map(String)
    : [];
}
function normalizeAuditFileClass(entry) {
  return typeof entry.surface_class === "string"
    ? entry.surface_class
    : String(entry.file_class ?? "");
}

function toPortableProjectPath(projectRoot, absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join(path.posix.sep);
}

function invalidTree(errors, warnings, message) {
  return {
    ok: false,
    errors,
    warnings,
    refusal: makeValidatorRefusal(VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_TREE_INVALID, message),
  };
}

export async function validateSpecTree(rootPath, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const generationInputs = await loadSpecGenerationInputsConfig(projectRoot);
  const errors = [];
  const warnings = [];

  if (!generationInputs.ok || generationInputs.mode !== "class_filtered") {
    return invalidTree(
      [`invalid spec generation inputs config: ${generationInputs.path}`],
      warnings,
      "spec tree validation requires class-filtered generation inputs",
    );
  }

  const targetRoot = path.resolve(rootPath);
  const expectedRoot = path.resolve(projectRoot, generationInputs.canonicalTargetRoot);
  if (targetRoot !== expectedRoot) {
    errors.push(`spec tree root mismatch: expected ${expectedRoot} but received ${targetRoot}`);
  }

  const files = await collectTreeFiles(targetRoot);
  if (files.length === 0) {
    return {
      ok: false,
      errors: errors.length > 0 ? errors : [`missing spec tree root: ${targetRoot}`],
      warnings,
      refusal: makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_TREE_MISSING,
        "spec tree root is missing or empty",
      ),
    };
  }

  const canonicalRoot = generationInputs.canonicalTargetRoot;
  const requiredFiles = await loadRequiredFiles(projectRoot);
  const missingRequired = requiredFiles
    .map((entry) => path.posix.relative(canonicalRoot, entry))
    .filter((entry) => !files.includes(entry));
  if (missingRequired.length > 0) {
    errors.push(`missing required canonical files: ${missingRequired.join(", ")}`);
  }

  const rootRef = path.relative(projectRoot, targetRoot).split(path.sep).join(path.posix.sep) || ".";
  const reports = await Promise.all([
    validatePlacement(projectRoot, { rootRef }),
    validateDomainAdmission(projectRoot, { rootRef }),
    validateTableFamily(projectRoot, { rootRef }),
    validateProjectionEdges(projectRoot, { rootRef }),
    validateGuidanceBodies(projectRoot, { rootRef }),
  ]);
  for (const report of reports) {
    for (const error of report.errors ?? []) {
      if (!errors.includes(error)) errors.push(error);
    }
    for (const warning of report.warnings ?? []) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    refusal: errors.length === 0
      ? null
      : makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_TREE_INVALID,
        `spec tree is invalid: ${path.basename(targetRoot)}`,
      ),
    summary: {
      profile: "surface_taxonomy_v2",
      canonicalRoot,
      totalFiles: files.length,
      requiredFiles: requiredFiles.length,
      missingRequired,
      classifiedFiles: reports[0]?.summary?.total ?? files.length,
      unexpectedFiles: [],
      conflictingFiles: [],
    },
  };
}

export async function validateSpecAudit(auditPath, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const generationInputs = await loadSpecGenerationInputsConfig(projectRoot);
  const blueprintReference = await loadBlueprintReference(projectRoot);
  const auditContract = await loadSpecGenerationAuditContract(projectRoot);
  const errors = [];
  const warnings = [];

  if (!generationInputs.ok || generationInputs.mode !== "class_filtered") {
    return {
      ok: false,
      errors: [`invalid spec generation inputs config: ${generationInputs.path}`],
      warnings,
      refusal: makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_AUDIT_INVALID,
        "spec audit validation requires class-filtered generation inputs",
      ),
    };
  }
  if (!auditContract.ok) {
    return {
      ok: false,
      errors: [`invalid spec generation audit contract: ${auditContract.path}`],
      warnings,
      refusal: makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_AUDIT_INVALID,
        "spec audit validation requires a valid audit contract",
      ),
    };
  }
  if (!blueprintReference.ok) {
    errors.push(`invalid blueprint reference: ${blueprintReference.path}`);
  }

  const absoluteAuditPath = path.resolve(auditPath);
  const auditText = await readTextIfFile(absoluteAuditPath);
  if (auditText === null) {
    return {
      ok: false,
      errors: [`missing file: ${absoluteAuditPath}`],
      warnings,
      refusal: makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_AUDIT_MISSING,
        "spec generation audit artifact is missing",
      ),
    };
  }

  const parsed = parseYamlText(auditText);
  const audit = parsed?.spec_generation_audit;
  if (!isPlainObject(parsed) || !isPlainObject(audit)) {
    return {
      ok: false,
      errors: [`invalid YAML document: ${absoluteAuditPath}`],
      warnings,
      refusal: makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_AUDIT_INVALID,
        "spec generation audit artifact is not valid YAML",
      ),
    };
  }

  if (parsed.version !== 2) errors.push("spec generation audit version must be 2");
  if (String(parsed.contract_ref ?? "") !== SPEC_GENERATION_AUDIT_CONTRACT_REF) {
    errors.push(`spec generation audit contract_ref must be ${SPEC_GENERATION_AUDIT_CONTRACT_REF}`);
  }

  const missingTopLevelFields = auditContract.requiredTopLevelFields.filter((field) => !(field in audit));
  if (missingTopLevelFields.length > 0) {
    errors.push(`spec generation audit is missing required fields: ${missingTopLevelFields.join(", ")}`);
  }

  const declaredInputs = {
    code_roots: Array.isArray(audit?.input_roots?.code_roots) ? audit.input_roots.code_roots.map(String) : [],
    docs_roots: Array.isArray(audit?.input_roots?.docs_roots) ? audit.input_roots.docs_roots.map(String) : [],
    structure_roots: Array.isArray(audit?.input_roots?.structure_roots) ? audit.input_roots.structure_roots.map(String) : [],
    human_note_paths: Array.isArray(audit?.input_roots?.human_note_paths) ? audit.input_roots.human_note_paths.map(String) : [],
    benchmark_blueprint_root: audit?.input_roots?.benchmark_blueprint_root === null
      ? null
      : typeof audit?.input_roots?.benchmark_blueprint_root === "string"
        ? audit.input_roots.benchmark_blueprint_root
        : null,
  };

  if (String(audit.generation_mode ?? "") !== "class_filtered") {
    errors.push("spec generation audit generation_mode must be class_filtered");
  }
  const canonicalRoot = generationInputs.canonicalTargetRoot;
  if (String(audit.canonical_target_root ?? "") !== canonicalRoot) {
    errors.push(`spec generation audit canonical_target_root must be ${canonicalRoot}`);
  }
  if (String(audit.declared_profile ?? "") !== "surface_taxonomy_v2") {
    errors.push("spec generation audit declared_profile must be surface_taxonomy_v2");
  }
  if (!isDeclaredInputsCompatibleWithConfig(declaredInputs, generationInputs, blueprintReference)) {
    errors.push("spec generation audit input_roots must match declared generation inputs and optional blueprint root");
  }

  const treeFiles = await collectTreeFiles(path.resolve(projectRoot, canonicalRoot));
  if (treeFiles.length === 0) {
    errors.push(`missing spec tree root: ${path.resolve(projectRoot, canonicalRoot)}`);
  }
  const auditedFiles = treeFiles.filter((entry) => !entry.startsWith("_meta/"));
  const fileEntries = Array.isArray(audit.files) ? audit.files : [];
  if (!Array.isArray(audit.files)) errors.push("spec generation audit files must be an array");

  const fileEntryRefs = audit.file_entry_refs === undefined
    ? []
    : Array.isArray(audit.file_entry_refs)
      ? audit.file_entry_refs.map(String)
      : null;
  if (fileEntryRefs === null) {
    errors.push("spec generation audit file_entry_refs must be an array when present");
  }

  const referencedFileEntries = [];
  for (const entryRef of fileEntryRefs ?? []) {
    const expectedPrefix = ".nimi/local/state/spec-generation/spec-generation-audit/";
    const absoluteEntryRef = path.resolve(projectRoot, entryRef);
    const relativeEntryRef = toPortableProjectPath(projectRoot, absoluteEntryRef);
    if (!entryRef || path.isAbsolute(entryRef) || relativeEntryRef !== entryRef || !entryRef.startsWith(expectedPrefix)) {
      errors.push(`spec generation audit file_entry_ref must stay under ${expectedPrefix}: ${entryRef}`);
      continue;
    }
    const entryText = await readTextIfFile(absoluteEntryRef);
    const entryParsed = parseYamlText(entryText);
    const entryPayload = entryParsed?.spec_generation_audit_file_entries;
    if (!isPlainObject(entryParsed) || !isPlainObject(entryPayload) || entryParsed.version !== 2) {
      errors.push(`spec generation audit file_entry_ref is invalid: ${entryRef}`);
      continue;
    }
    if (String(entryParsed.contract_ref ?? "") !== SPEC_GENERATION_AUDIT_CONTRACT_REF) {
      errors.push(`spec generation audit file_entry_ref contract_ref is invalid: ${entryRef}`);
    }
    if (String(entryPayload.parent_ref ?? "") !== toPortableProjectPath(projectRoot, absoluteAuditPath)) {
      errors.push(`spec generation audit file_entry_ref parent_ref is invalid: ${entryRef}`);
    }
    if (!Array.isArray(entryPayload.files)) {
      errors.push(`spec generation audit file_entry_ref files must be an array: ${entryRef}`);
      continue;
    }
    referencedFileEntries.push(...entryPayload.files);
  }

  const auditEntryByRelativePath = new Map();
  for (const entry of [...fileEntries, ...referencedFileEntries]) {
    if (!isPlainObject(entry)) {
      errors.push("spec generation audit file entries must be mappings");
      continue;
    }
    const missingFields = auditContract.requiredFileEntryFields.filter((field) => !(field in entry));
    if (missingFields.length > 0) {
      errors.push(`spec generation audit file entry is missing required fields: ${missingFields.join(", ")}`);
      continue;
    }
    const canonicalPath = String(entry.canonical_path ?? "");
    if (!canonicalPath.startsWith(`${canonicalRoot}/`)) {
      errors.push(`spec generation audit canonical_path must stay under ${canonicalRoot}: ${canonicalPath}`);
      continue;
    }
    const relativePath = path.posix.relative(canonicalRoot, canonicalPath);
    if (relativePath.startsWith("_meta/")) {
      errors.push(`spec generation audit must not record _meta files: ${canonicalPath}`);
      continue;
    }
    if (auditEntryByRelativePath.has(relativePath)) {
      errors.push(`duplicate spec generation audit entry: ${canonicalPath}`);
      continue;
    }

    if (!Array.isArray(entry.source_refs) || entry.source_refs.length === 0) {
      errors.push(`spec generation audit source_refs must be non-empty for ${canonicalPath}`);
    } else {
      const invalidRefs = entry.source_refs.filter((ref) => !isSourceRefWithinDeclaredRoots(ref, declaredInputs));
      if (invalidRefs.length > 0) {
        errors.push(`spec generation audit source_refs escape declared inputs for ${canonicalPath}: ${invalidRefs.join(", ")}`);
      }
    }
    if (!SPEC_GENERATION_AUDIT_SOURCE_BASIS_ENUM.includes(String(entry.source_basis ?? ""))) {
      errors.push(`spec generation audit source_basis is invalid for ${canonicalPath}`);
    }
    if (!SPEC_GENERATION_AUDIT_COVERAGE_STATUS_ENUM.includes(String(entry.coverage_status ?? ""))) {
      errors.push(`spec generation audit coverage_status is invalid for ${canonicalPath}`);
    }
    if (!Array.isArray(entry.unresolved_items) || entry.unresolved_items.some((item) => typeof item !== "string")) {
      errors.push(`spec generation audit unresolved_items must be strings for ${canonicalPath}`);
    }
    if ((entry.source_basis !== "grounded" || entry.coverage_status !== "complete")
      && (!Array.isArray(entry.unresolved_items) || entry.unresolved_items.length === 0)) {
      errors.push(`inferred or partial files must declare unresolved_items for ${canonicalPath}`);
    }
    auditEntryByRelativePath.set(relativePath, entry);
  }

  const missingAuditEntries = auditedFiles.filter((entry) => !auditEntryByRelativePath.has(entry));
  if (missingAuditEntries.length > 0) {
    errors.push(`spec generation audit is missing canonical files: ${missingAuditEntries.join(", ")}`);
  }
  for (const relativePath of auditEntryByRelativePath.keys()) {
    if (!auditedFiles.includes(relativePath)) {
      errors.push(`spec generation audit entry points to a non-existent canonical file: ${relativePath}`);
    }
  }

  const requiredFiles = (await loadRequiredFiles(projectRoot))
    .map((entry) => path.posix.relative(canonicalRoot, entry))
    .filter((entry) => !entry.startsWith("_meta/"));
  for (const requiredFile of requiredFiles) {
    const entry = auditEntryByRelativePath.get(requiredFile);
    if (!entry) errors.push(`required canonical file is missing an audit entry: ${requiredFile}`);
    else if (entry.coverage_status === "placeholder_not_allowed") {
      errors.push(`required canonical file must not be placeholder_not_allowed: ${requiredFile}`);
    }
  }

  const values = [...auditEntryByRelativePath.values()];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    refusal: errors.length === 0
      ? null
      : makeValidatorRefusal(
        VALIDATOR_NATIVE_REFUSAL_CODES.SPEC_AUDIT_INVALID,
        `spec generation audit is invalid: ${path.basename(absoluteAuditPath)}`,
      ),
    summary: {
      canonicalRoot,
      declaredProfile: "surface_taxonomy_v2",
      auditedFiles: values.length,
      requiredAuditedFiles: requiredFiles.length,
      missingAuditEntries,
      completeFiles: values.filter((entry) => entry.coverage_status === "complete").length,
      partialFiles: values.filter((entry) => entry.coverage_status === "partial").length,
      placeholderFiles: values.filter((entry) => entry.coverage_status === "placeholder_not_allowed").length,
      unresolvedFiles: values.filter((entry) => entry.unresolved_items?.length > 0).length,
      inferredFiles: values.filter((entry) => entry.source_basis !== "grounded").length,
    },
  };
}
