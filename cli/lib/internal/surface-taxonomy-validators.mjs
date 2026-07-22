import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

import { pathExists } from "../fs-helpers.mjs";
import { loadSeedPolicy } from "../../seeds/bootstrap.mjs";
import { parseYamlText } from "../yaml-helpers.mjs";
import { isPlainObject } from "../value-helpers.mjs";

const SURFACE_RESULT_CONTRACT = "nimicoding.surface-validator-result.v2";
const PACKAGE_SPEC_LAYOUT_REF = "package://@nimiplatform/nimi-coding/contracts/spec-layout.schema.yaml";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const CONTRACT_REFS = {
  sharedEnums: "contracts/shared-enums.yaml",
  surfaceTaxonomy: "contracts/surface-taxonomy.schema.yaml",
  placement: "contracts/placement-contract.schema.yaml",
  projectionEdge: "contracts/projection-edge.schema.yaml",
  tableFamily: "contracts/table-family.schema.yaml",
  domainAdmission: "contracts/domain-admission.schema.yaml",
  trackedOutputAdmission: "contracts/tracked-output-admission.schema.yaml",
  specLayout: "contracts/spec-layout.schema.yaml",
  negativeFixtures: "contracts/negative-fixtures.yaml",
};

const TEXT_RULE_BODY_PATTERN = /\bMUST(?:\s+NOT)?\b|\bmust\s+not\b|必须|不得|fail(?:s|ed)?\s+closed/i;
const PRODUCT_RULE_DEFINITION_PATTERN = /^\s*(?:[-*]\s*)?(?:rule_id|rule id)\s*[:|]/im;
const GENERATED_REF_PATTERN = /\.nimi\/spec\/[^)\s]+\/kernel\/generated\/|\.nimi\/spec\/generated\/|kernel\/generated\//;
const EXACT_HOST_CONFIG_CLASSES = new Map([
  [".nimi/config/host-overlay.yaml", "host_projection_anchor"],
  [".nimi/config/spec-layout.yaml", "support_registry"],
  [".nimi/config/governance.yaml", "support_registry"],
]);

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function relativeRef(projectRoot, absolutePath) {
  return toPosix(path.relative(projectRoot, absolutePath));
}

async function readYamlAt(relativePath) {
  const absolutePath = path.join(PACKAGE_ROOT, relativePath);
  const text = await readFile(absolutePath, "utf8");
  return {
    path: path.relative(PACKAGE_ROOT, absolutePath),
    text,
    data: parseYamlText(text),
  };
}

async function readHostYamlAt(projectRoot, relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const exists = await pathExists(absolutePath);
  if (!exists?.isFile()) {
    return null;
  }
  const text = await readFile(absolutePath, "utf8");
  return {
    path: relativePath,
    text,
    data: parseYamlText(text),
  };
}

async function loadSurfaceContracts(projectRoot) {
  const entries = await Promise.all(Object.entries(CONTRACT_REFS).map(async ([key, ref]) => [key, await readYamlAt(ref)]));
  const contracts = Object.fromEntries(entries);
  const hostDomainAdmission = await readHostYamlAt(projectRoot, ".nimi/contracts/domain-admission.schema.yaml");
  if (hostDomainAdmission) {
    contracts.domainAdmission = hostDomainAdmission;
  }
  const seedPolicy = await loadSeedPolicy();
  contracts.seedProjections = new Map(seedPolicy.projections.map((entry) => [entry.outputRelativePath, entry]));
  const hostSpecLayout = await readHostYamlAt(projectRoot, ".nimi/config/spec-layout.yaml");
  contracts.hostSpecLayout = parseHostSpecLayout(
    hostSpecLayout,
    contracts.specLayout,
    contracts.tableFamily,
  );
  return contracts;
}

function isPortableRef(ref) {
  return typeof ref === "string"
    && ref.length > 0
    && !path.posix.isAbsolute(ref)
    && !ref.startsWith("./")
    && !ref.split("/").includes("..")
    && path.posix.normalize(ref) === ref;
}

function isRefWithin(ref, root) {
  return ref === root || ref.startsWith(`${root}/`);
}

function hasExactFields(value, requiredFields) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...requiredFields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function isLiteralPortableRef(ref) {
  return isPortableRef(ref) && !/[\*{}]/.test(ref);
}

function isGeneratedProjectionRoot(ref, canonicalRoot) {
  return ref === `${canonicalRoot}/generated`
    || ref.startsWith(`${canonicalRoot}/generated/`)
    || /^\.nimi\/spec\/[^/]+\/kernel\/generated(?:\/.*)?$/.test(ref);
}

function parseHostSpecLayout(hostConfig, schemaContract, tableFamilyContract) {
  if (!hostConfig) {
    return {
      ok: true,
      present: false,
      errors: [],
      canonicalRoot: ".nimi/spec",
      hostInstructionPaths: [],
      trackedDerivedProjections: [],
      tableFamilyExtensions: [],
    };
  }

  const errors = [];
  const parsed = hostConfig.data;
  const layout = parsed?.spec_layout;
  const requiredDocumentFields = Array.isArray(schemaContract.data?.required_top_level_fields)
    ? schemaContract.data.required_top_level_fields.map(String)
    : [];
  const requiredLayoutFields = Array.isArray(schemaContract.data?.layout_required_fields)
    ? schemaContract.data.layout_required_fields.map(String)
    : [];
  const requiredProjectionFields = Array.isArray(schemaContract.data?.tracked_derived_projection_required_fields)
    ? schemaContract.data.tracked_derived_projection_required_fields.map(String)
    : [];
  const requiredFamilyFields = Array.isArray(schemaContract.data?.table_family_extension_required_fields)
    ? schemaContract.data.table_family_extension_required_fields.map(String)
    : [];
  const packageFamilyIds = new Set(
    (tableFamilyContract.data?.table_families ?? []).map((entry) => String(entry.table_family)),
  );

  if (parsed?.version !== 1 || parsed?.contract_ref !== PACKAGE_SPEC_LAYOUT_REF || !isPlainObject(layout)) {
    errors.push("invalid_spec_layout_config: .nimi/config/spec-layout.yaml");
  }
  if (!hasExactFields(parsed, requiredDocumentFields)) {
    errors.push("invalid_spec_layout_document_fields: .nimi/config/spec-layout.yaml");
  }
  if (!hasExactFields(layout, requiredLayoutFields)) {
    errors.push("invalid_spec_layout_fields: .nimi/config/spec-layout.yaml");
  }
  for (const field of requiredLayoutFields) {
    if (!(field in (layout ?? {}))) {
      errors.push(`missing_spec_layout_field: .nimi/config/spec-layout.yaml: ${field}`);
    }
  }

  const canonicalRoot = typeof layout?.canonical_root === "string" ? layout.canonical_root : ".nimi/spec";
  if (!isPortableRef(canonicalRoot) || canonicalRoot !== ".nimi/spec") {
    errors.push(`invalid_spec_layout_canonical_root: ${canonicalRoot}`);
  }

  if (!Array.isArray(layout?.host_instruction_paths)) {
    errors.push("invalid_host_instruction_paths: .nimi/config/spec-layout.yaml");
  }
  const hostInstructionPaths = Array.isArray(layout?.host_instruction_paths)
    ? layout.host_instruction_paths.map(String)
    : [];
  const seenInstructionPaths = new Set();
  for (const ref of hostInstructionPaths) {
    if (!isPortableRef(ref)
      || !ref.startsWith(`${canonicalRoot}/`)
      || ref === `${canonicalRoot}/INDEX.md`
      || ref.includes("/kernel/")
      || !ref.endsWith(".md")
      || /[\*{}]/.test(path.posix.basename(ref))) {
      errors.push(`invalid_host_instruction_path: ${ref}`);
    }
    if (seenInstructionPaths.has(ref)) {
      errors.push(`duplicate_host_instruction_path: ${ref}`);
    }
    seenInstructionPaths.add(ref);
  }

  if (!Array.isArray(layout?.tracked_derived_projections)) {
    errors.push("invalid_tracked_derived_projections: .nimi/config/spec-layout.yaml");
  }
  const trackedDerivedProjections = Array.isArray(layout?.tracked_derived_projections)
    ? layout.tracked_derived_projections
    : [];
  const seenProjectionIds = new Set();
  const seenProjectionRoots = new Set();
  for (const projection of trackedDerivedProjections) {
    if (!isPlainObject(projection)) {
      errors.push("invalid_tracked_derived_projection: non-object entry");
      continue;
    }
    if (!hasExactFields(projection, requiredProjectionFields)) {
      errors.push(`invalid_tracked_derived_projection_fields: ${String(projection.projection_id ?? "unknown")}`);
    }
    for (const field of requiredProjectionFields) {
      if (!(field in projection)) {
        errors.push(`missing_tracked_derived_projection_field: ${String(projection.projection_id ?? "unknown")}: ${field}`);
      }
    }
    const projectionId = String(projection.projection_id ?? "");
    const root = String(projection.root ?? "");
    const sourceRoots = Array.isArray(projection.source_roots) ? projection.source_roots.map(String) : [];
    if (!projectionId || seenProjectionIds.has(projectionId)) {
      errors.push(`invalid_or_duplicate_projection_id: ${projectionId || "empty"}`);
    }
    const overlapsExistingRoot = [...seenProjectionRoots].some((existingRoot) => (
      isRefWithin(root, existingRoot) || isRefWithin(existingRoot, root)
    ));
    if (!isLiteralPortableRef(root)
      || !isGeneratedProjectionRoot(root, canonicalRoot)
      || overlapsExistingRoot) {
      errors.push(`invalid_or_duplicate_projection_root: ${root || "empty"}`);
    }
    if (sourceRoots.length === 0 || sourceRoots.some((ref) => (
      !isLiteralPortableRef(ref)
      || !ref.startsWith(`${canonicalRoot}/`)
      || isRefWithin(ref, root)
    ))) {
      errors.push(`invalid_projection_source_roots: ${projectionId || "unknown"}`);
    }
    for (const field of ["generate_command", "drift_check_command", "required_marker"]) {
      if (typeof projection[field] !== "string" || projection[field].trim().length === 0) {
        errors.push(`invalid_tracked_derived_projection_field: ${projectionId || "unknown"}: ${field}`);
      }
    }
    seenProjectionIds.add(projectionId);
    seenProjectionRoots.add(root);
  }

  if (!Array.isArray(layout?.table_family_extensions)) {
    errors.push("invalid_table_family_extensions: .nimi/config/spec-layout.yaml");
  }
  const tableFamilyExtensions = Array.isArray(layout?.table_family_extensions)
    ? layout.table_family_extensions
    : [];
  const seenFamilies = new Set();
  for (const family of tableFamilyExtensions) {
    if (!isPlainObject(family)) {
      errors.push("invalid_table_family_extension: non-object entry");
      continue;
    }
    if (!hasExactFields(family, requiredFamilyFields)) {
      errors.push(`invalid_table_family_extension_fields: ${String(family.table_family ?? "unknown")}`);
    }
    for (const field of requiredFamilyFields) {
      if (!(field in family)) {
        errors.push(`missing_table_family_extension_field: ${String(family.table_family ?? "unknown")}: ${field}`);
      }
    }
    const familyId = String(family.table_family ?? "");
    if (!/^[a-z][a-z0-9_]*$/.test(familyId) || seenFamilies.has(familyId)) {
      errors.push(`invalid_or_duplicate_table_family_extension: ${familyId || "empty"}`);
    }
    if (packageFamilyIds.has(familyId)) {
      errors.push(`table_family_extension_shadows_package_family: ${familyId}`);
    }
    if (family.authority_class !== "product_authority_table"
      || !Array.isArray(family.required_fields)
      || family.required_fields.length === 0
      || family.required_fields.some((field) => typeof field !== "string" || field.length === 0)
      || !family.required_fields.includes("table_family")
      || !family.required_fields.includes("owner")
      || new Set(family.required_fields).size !== family.required_fields.length
      || !Array.isArray(family.forbidden_fields)
      || family.forbidden_fields.some((field) => typeof field !== "string" || field.length === 0)
      || new Set(family.forbidden_fields).size !== family.forbidden_fields.length
      || family.required_fields.some((field) => family.forbidden_fields.includes(field))) {
      errors.push(`invalid_table_family_extension_shape: ${familyId || "unknown"}`);
    }
    seenFamilies.add(familyId);
  }

  return {
    ok: errors.length === 0,
    present: true,
    errors,
    canonicalRoot,
    hostInstructionPaths,
    trackedDerivedProjections,
    tableFamilyExtensions,
  };
}

async function collectFilesUnder(rootPath) {
  const exists = await pathExists(rootPath);
  if (!exists || !exists.isDirectory()) {
    return [];
  }

  async function walk(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(childPath));
      } else if (entry.isFile()) {
        files.push(childPath);
      }
    }
    return files.sort();
  }

  return walk(rootPath);
}

async function collectCandidateFiles(projectRoot, rootRef = ".nimi/spec") {
  const roots = [
    rootRef,
    ".nimi/contracts",
    ".nimi/methodology",
    ".nimi/config",
    ".nimi/derived",
    ".nimi/state",
    ".nimi/audit",
  ];
  const uniqueRoots = [...new Set(roots)];
  const files = [];
  for (const root of uniqueRoots) {
    files.push(...await collectFilesUnder(path.resolve(projectRoot, root)));
  }
  return [...new Set(files)].sort();
}

function pathMatchesGlob(candidate, pattern) {
  const tokens = [];
  let source = pattern
    .replaceAll("{spec,methodology,contracts,config}", "__BRACE_PACKAGE_ROOTS__")
    .replaceAll("{config,contracts,methodology,spec}", "__BRACE_PACKAGE_ROOTS__")
    .replaceAll("<domain>", "__DOMAIN__")
    .replaceAll("**", "__DOUBLE_STAR__")
    .replaceAll("*", "__STAR__");

  source = source.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  source = source
    .replaceAll("__BRACE_PACKAGE_ROOTS__", "(?:spec|methodology|contracts|config)")
    .replaceAll("__DOMAIN__", "[^/]+")
    .replaceAll("__DOUBLE_STAR__", ".*")
    .replaceAll("__STAR__", "[^/]*");
  tokens.push(new RegExp(`^${source}$`));
  return tokens.some((regex) => regex.test(candidate));
}

function basenameNoExt(ref) {
  return path.posix.basename(ref).replace(/\.(yaml|yml|md)$/i, "");
}

function firstPathSegment(ref) {
  return ref.split("/")[0] ?? "";
}

function domainForSpecRef(ref) {
  const parts = ref.split("/");
  if (parts[0] !== ".nimi" || parts[1] !== "spec" || parts.length < 4) {
    return null;
  }
  if (parts[2] === "_meta" || parts[2] === "generated") {
    return null;
  }
  return parts[2] ?? null;
}

function walkObjectKeys(value, callback) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkObjectKeys(entry, callback);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    callback(String(key), entry);
    walkObjectKeys(entry, callback);
  }
}

function containsAnyKey(value, keys) {
  const wanted = new Set(keys);
  let found = false;
  walkObjectKeys(value, (key) => {
    if (wanted.has(key)) {
      found = true;
    }
  });
  return found;
}

function yamlForText(text) {
  return parseYamlText(text);
}

function isYamlRef(ref) {
  return /\.(yaml|yml)$/i.test(ref);
}

function isMarkdownRef(ref) {
  return /\.md$/i.test(ref);
}

function isCanonicalAuthorityRef(ref) {
  return ref.endsWith(".authority.yaml") || ref.endsWith(".authority.md");
}

function tableFamilyContractMap(contracts) {
  const families = Array.isArray(contracts.tableFamily.data?.table_families)
    ? contracts.tableFamily.data.table_families
    : [];
  const extensions = contracts.hostSpecLayout?.ok
    ? contracts.hostSpecLayout.tableFamilyExtensions
    : [];
  return new Map([...families, ...extensions].map((entry) => [String(entry.table_family), entry]));
}

function domainAdmissionMap(contracts) {
  const admissions = Array.isArray(contracts.domainAdmission.data?.domain_admissions)
    ? contracts.domainAdmission.data.domain_admissions
    : [];
  return new Map(admissions.map((entry) => [String(entry.domain_id), entry]));
}

function trackedAdmissionRoots(contracts) {
  const admissions = Array.isArray(contracts.trackedOutputAdmission.data?.admissions)
    ? contracts.trackedOutputAdmission.data.admissions
    : [];
  return admissions.map((entry) => String(entry.root)).filter(Boolean);
}

function isTrackedNonProductRef(ref) {
  return ref.startsWith(".nimi/derived/")
    || ref.startsWith(".nimi/state/")
    || ref.startsWith(".nimi/audit/");
}

function isAdmittedTrackedOutput(ref, admittedRoots) {
  return admittedRoots.some((root) => pathMatchesGlob(ref, root));
}

function projectionForRef(ref, contracts) {
  if (!contracts.hostSpecLayout?.ok) {
    return null;
  }
  return contracts.hostSpecLayout.trackedDerivedProjections.find((entry) => isRefWithin(ref, String(entry.root))) ?? null;
}

function isHostInstructionRef(ref, contracts) {
  return contracts.hostSpecLayout?.ok
    && contracts.hostSpecLayout.hostInstructionPaths.some((pattern) => pathMatchesGlob(ref, pattern));
}

function classifyRef(ref, text, parsedYaml, contracts) {
  const seedProjection = contracts.seedProjections.get(ref);
  if (seedProjection) {
    return seedProjection.ownership === "package_canonical" ? "nimicoding_managed_projection" : "support_registry";
  }
  if (EXACT_HOST_CONFIG_CLASSES.has(ref)) {
    return EXACT_HOST_CONFIG_CLASSES.get(ref);
  }
  if (ref.startsWith(".nimi/spec/future/")) {
    return "unclassified";
  }
  if (isHostInstructionRef(ref, contracts)) {
    return "host_instruction";
  }
  if (projectionForRef(ref, contracts)) {
    return "tracked_derived_projection";
  }
  if (ref.startsWith(".nimi/spec/generated/") || ref.includes("/kernel/generated/")) {
    return "derived_view";
  }
  if (ref === ".nimi/spec/_meta/spec-generation-audit.yaml" || ref.startsWith(".nimi/spec/_meta/spec-generation-audit/")) {
    return "spec_generation_state";
  }
  if (ref.startsWith(".nimi/spec/_meta/")) {
    if (ref.endsWith("-admission-anchor.yaml")) {
      return "host_projection_anchor";
    }
    return "methodology_authority";
  }
  if (ref === ".nimi/spec/product-scope.yaml") {
    return "methodology_authority";
  }
  if (ref.startsWith(".nimi/spec/") && domainForSpecRef(ref) && isCanonicalAuthorityRef(ref)) {
    return "product_authority";
  }
  if (ref.startsWith(".nimi/spec/") && ref.includes("/kernel/tables/") && isYamlRef(ref)) {
    if (isPlainObject(parsedYaml) && parsedYaml.table_family === "support_registry") {
      return "support_registry";
    }
    if (isPlainObject(parsedYaml) && typeof parsedYaml.table_family === "string") {
      return "product_authority_table";
    }
    const stateKeys = ["done", "covered", "coverage_status", "audit_date", "evidence_report", "current", "proposed", "backlog_status", "migration_status", "mapping_status", "run_id", "ledger_ref"];
    if (containsAnyKey(parsedYaml, stateKeys) || /rule-evidence|backlog|migration/i.test(basenameNoExt(ref))) {
      return "audit_evidence_state";
    }
    return "product_authority_table";
  }
  if (ref.startsWith(".nimi/spec/") && isYamlRef(ref) && basenameNoExt(ref) === "spec-exempt-modules") {
    return "support_registry";
  }
  if (ref.startsWith(".nimi/spec/") && ref.includes("/kernel/") && isMarkdownRef(ref)) {
    return "product_authority";
  }
  if (ref === ".nimi/spec/INDEX.md" || (ref.startsWith(".nimi/spec/") && isMarkdownRef(ref))) {
    return "thin_guidance";
  }
  if (ref.startsWith(".nimi/local/derived/")) {
    return "derived_view";
  }
  if (ref.startsWith(".nimi/local/state/spec-generation/")) {
    return "spec_generation_state";
  }
  if (ref.startsWith(".nimi/local/audit/")) {
    return "audit_evidence_state";
  }
  if (ref.startsWith(".nimi/local/") || ref.startsWith(".local/")) {
    return "operational_local_artifact";
  }
  if (ref.startsWith(".nimi/contracts/") || ref.startsWith(".nimi/methodology/") || ref.startsWith(".nimi/config/")) {
    return "unclassified";
  }
  if (ref.startsWith("package://@nimiplatform/nimi-coding/")) {
    return "methodology_authority";
  }
  if (isTrackedNonProductRef(ref)) {
    if (ref.startsWith(".nimi/derived/")) return "derived_view";
    if (ref.startsWith(".nimi/state/")) return "spec_generation_state";
    if (ref.startsWith(".nimi/audit/")) return "audit_evidence_state";
  }
  return "unclassified";
}

function dispositionFor(ref, surfaceClass, errors) {
  if (errors.length > 0 && surfaceClass === "unclassified") {
    return "block";
  }
  if (surfaceClass === "methodology_authority") {
    return "move_package";
  }
  if (surfaceClass === "nimicoding_managed_projection") {
    return "keep";
  }
  if (surfaceClass === "derived_view") {
    return "delete";
  }
  if (surfaceClass === "host_instruction" || surfaceClass === "tracked_derived_projection") {
    return errors.length > 0 ? "block" : "keep";
  }
  if (["spec_generation_state", "audit_evidence_state", "operational_local_artifact"].includes(surfaceClass)) {
    return "move_local";
  }
  if (errors.length > 0) {
    return "block";
  }
  return "keep";
}

function targetRootFor(surfaceClass, ref) {
  if (surfaceClass === "methodology_authority") {
    return "nimi-coding";
  }
  if (surfaceClass === "nimicoding_managed_projection") {
    return ".nimi";
  }
  if (surfaceClass === "derived_view") {
    return "stdout_view";
  }
  if (surfaceClass === "host_instruction" || surfaceClass === "tracked_derived_projection") {
    return ".nimi/spec";
  }
  if (surfaceClass === "spec_generation_state" || surfaceClass === "operational_local_artifact") {
    return ".nimi/local/state";
  }
  if (surfaceClass === "audit_evidence_state") {
    return ".nimi/local/audit";
  }
  if (surfaceClass === "unclassified") {
    return null;
  }
  if (ref.startsWith(".nimi/spec/")) {
    return ".nimi/spec";
  }
  return firstPathSegment(ref);
}

function ownerFor(surfaceClass, ref, contracts = null) {
  const seedProjection = contracts?.seedProjections?.get(ref);
  if (seedProjection) return seedProjection.ownership === "package_canonical" ? "nimi-coding" : "product_host";
  if (EXACT_HOST_CONFIG_CLASSES.has(ref)) return ref === ".nimi/config/host-overlay.yaml" ? "host_projection" : "product_host";
  if (surfaceClass === "methodology_authority" || surfaceClass === "nimicoding_managed_projection") {
    return "nimi-coding";
  }
  if (surfaceClass === "unclassified") return "unresolved";
  if (surfaceClass === "derived_view") {
    return "generator";
  }
  if (surfaceClass === "tracked_derived_projection") {
    return "generator";
  }
  if (surfaceClass === "host_instruction") {
    return "product_host";
  }
  if (surfaceClass === "spec_generation_state") {
    return "spec_generator";
  }
  if (surfaceClass === "audit_evidence_state") {
    return "verification_process";
  }
  if (surfaceClass === "operational_local_artifact") {
    return "external_tooling";
  }
  return domainForSpecRef(ref) ?? "product_domain";
}

function confirmationFor(errors) {
  if (errors.some((error) => error.includes("unadmitted_domain_retained_as_spec_input"))) {
    return "product_semantic_fork";
  }
  if (errors.some((error) => error.includes("missing_domain_admission"))) {
    return "owner_ambiguity";
  }
  if (errors.some((error) => error.includes("package_methodology_under_host_spec") || error.includes("package_body_promoted_to_product_authority"))) {
    return "package_boundary_ambiguity";
  }
  return "none";
}

function ambiguityFor(requiredConfirmation, surfaceClass) {
  if (requiredConfirmation === "none") {
    return {
      posture: "none",
      reason: null,
      candidate_owners: [],
    };
  }
  return {
    posture: "blocks_migration",
    reason: requiredConfirmation,
    candidate_owners: surfaceClass === "unclassified" ? [] : [ownerFor(surfaceClass, "")],
  };
}

function validationCommandsFor(entryClass) {
  const commands = {
    product_authority_table: ["pnpm exec nimicoding validate-table-family --profile nimi --root .nimi/spec"],
    support_registry: ["pnpm exec nimicoding validate-table-family --profile nimi --root .nimi/spec"],
    thin_guidance: ["pnpm exec nimicoding validate-guidance-bodies --profile nimi --root .nimi/spec"],
    host_instruction: ["pnpm exec nimicoding validate-placement --profile nimi --root .nimi/spec"],
    tracked_derived_projection: ["pnpm exec nimicoding validate-placement --profile nimi --root .nimi/spec"],
    host_projection_anchor: ["pnpm exec nimicoding validate-projection-edges --profile nimi --root .nimi/spec"],
    nimicoding_managed_projection: ["pnpm exec nimicoding validate-placement --profile nimi --root .nimi/spec"],
  };
  return commands[entryClass] ?? ["pnpm exec nimicoding validate-placement --profile nimi --root .nimi/spec"];
}

function addError(errors, code, ref, detail) {
  errors.push(detail ? `${code}: ${ref}: ${detail}` : `${code}: ${ref}`);
}

function validateRefPlacement(ref, surfaceClass, parsedYaml, text, contracts) {
  const errors = [];

  if (surfaceClass === "unclassified") {
    addError(errors, "unclassified_file", ref);
  }
  if (surfaceClass === "derived_view" && ref.startsWith(".nimi/spec/")) {
    addError(errors, "derived_view_under_product_authority_root", ref);
  }
  if (surfaceClass === "tracked_derived_projection") {
    const projection = projectionForRef(ref, contracts);
    if (!projection) {
      addError(errors, "tracked_derived_projection_without_layout_admission", ref);
    } else if (!text.includes(String(projection.required_marker))) {
      addError(errors, "tracked_derived_projection_missing_generated_marker", ref, String(projection.required_marker));
    }
  }
  if (surfaceClass === "host_instruction" && PRODUCT_RULE_DEFINITION_PATTERN.test(text)) {
    addError(errors, "host_instruction_defines_product_rule", ref);
  }
  if (surfaceClass === "derived_view" && ref.startsWith(".nimi/local/derived/")) {
    addError(errors, "derived_view_written_to_local_derived", ref);
  }
  if (surfaceClass === "spec_generation_state" && ref.startsWith(".nimi/spec/")) {
    addError(errors, "spec_generation_state_under_spec", ref);
  }
  if (surfaceClass === "audit_evidence_state" && ref.startsWith(".nimi/spec/")) {
    addError(errors, "audit_evidence_state_under_spec", ref);
  }
  if (surfaceClass === "methodology_authority" && ref.startsWith(".nimi/spec/")) {
    addError(errors, "package_methodology_under_host_spec", ref);
  }
  if (isTrackedNonProductRef(ref) && !isAdmittedTrackedOutput(ref, trackedAdmissionRoots(contracts))) {
    addError(errors, "tracked_non_product_without_admission", ref);
  }
  if (surfaceClass === "thin_guidance" && isMarkdownRef(ref)) {
    if (TEXT_RULE_BODY_PATTERN.test(text)) {
      addError(errors, "guidance_defines_rule_body", ref);
    }
    if (PRODUCT_RULE_DEFINITION_PATTERN.test(text)) {
      addError(errors, "guidance_defines_product_rule", ref);
    }
  }
  if (surfaceClass === "product_authority" && isMarkdownRef(ref) && GENERATED_REF_PATTERN.test(text)) {
    addError(errors, "derived_view_referenced_as_authority", ref);
  }
  return errors;
}

function validateTableRef(ref, parsedYaml, contracts) {
  const errors = [];
  if (!ref.startsWith(".nimi/spec/") || !ref.includes("/kernel/tables/") || !isYamlRef(ref)) {
    return errors;
  }

  if (!isPlainObject(parsedYaml)) {
    addError(errors, "invalid_yaml_table", ref);
    return errors;
  }

  const family = typeof parsedYaml.table_family === "string" ? parsedYaml.table_family : null;
  const familyMap = tableFamilyContractMap(contracts);
  if (!family) {
    addError(errors, "missing_table_family", ref);
  } else if (!familyMap.has(family)) {
    addError(errors, "unknown_table_family", ref, family);
  } else {
    const familyContract = familyMap.get(family);
    for (const field of familyContract.required_fields ?? []) {
      if (!(field in parsedYaml)) {
        addError(errors, "missing_table_family_required_field", ref, String(field));
      }
    }
    if (containsAnyKey(parsedYaml, familyContract.forbidden_fields ?? [])) {
      addError(errors, "table_contains_family_forbidden_field", ref, family);
    }
  }

  const forbiddenFields = contracts.tableFamily.data?.forbidden_fields_by_authority_class?.product_authority_table ?? [];
  if (containsAnyKey(parsedYaml, forbiddenFields)) {
    addError(errors, "table_contains_forbidden_state_or_audit_field", ref);
  }

  return errors;
}

function validateDomainRef(ref, contracts) {
  const errors = [];
  const domain = domainForSpecRef(ref);
  if (!domain) {
    return errors;
  }
  const admissions = domainAdmissionMap(contracts);
  const admission = admissions.get(domain);
  if (!admission) {
    addError(errors, "missing_domain_admission", ref, domain);
    return errors;
  }
  if (admission.authority_class === "excluded_from_spec") {
    addError(errors, "excluded_domain_retained_under_spec", ref, domain);
  }
  if (admission.authority_class === "migration_input_only") {
    addError(errors, "unadmitted_domain_retained_as_spec_input", ref, domain);
  }
  return errors;
}

async function buildInventory(projectRoot, options = {}) {
  const contracts = await loadSurfaceContracts(projectRoot);
  const rootRef = options.rootRef ?? ".nimi/spec";
  const absoluteFiles = await collectCandidateFiles(projectRoot, rootRef);
  const entries = [];
  const layoutErrors = [...(contracts.hostSpecLayout?.errors ?? [])];
  const errors = [...layoutErrors];

  for (const absolutePath of absoluteFiles) {
    const ref = relativeRef(projectRoot, absolutePath);
    const text = await readFile(absolutePath, "utf8");
    const parsedYaml = isYamlRef(ref) ? yamlForText(text) : null;
    const surfaceClass = classifyRef(ref, text, parsedYaml, contracts);
    const validationErrors = {
      placement: validateRefPlacement(ref, surfaceClass, parsedYaml, text, contracts),
      table_family: validateTableRef(ref, parsedYaml, contracts),
      domain_admission: validateDomainRef(ref, contracts),
    };
    const entryErrors = Object.values(validationErrors).flat();
    errors.push(...entryErrors);
    const requiredConfirmation = confirmationFor(entryErrors);
    entries.push({
      source_path: ref,
      current_inferred_class: surfaceClass,
      target_class: surfaceClass,
      disposition: dispositionFor(ref, surfaceClass, entryErrors),
      target_root: targetRootFor(surfaceClass, ref),
      owner: ownerFor(surfaceClass, ref, contracts),
      required_confirmation: requiredConfirmation,
      ambiguity: ambiguityFor(requiredConfirmation, surfaceClass),
      evidence: entryErrors.length > 0 ? entryErrors : [`classified_as:${surfaceClass}`],
      validation_commands: validationCommandsFor(surfaceClass),
      validation_errors: validationErrors,
      errors: entryErrors,
    });
  }

  return {
    contracts,
    entries,
    layoutErrors,
    errors,
  };
}

function summarize(entries) {
  const byClass = {};
  const byDisposition = {};
  for (const entry of entries) {
    byClass[entry.current_inferred_class] = (byClass[entry.current_inferred_class] ?? 0) + 1;
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1;
  }
  return {
    total_files: entries.length,
    by_surface_class: byClass,
    by_disposition: byDisposition,
    blocking_entries: entries.filter((entry) => entry.disposition === "block").length,
  };
}

function reportFor(validator, ok, errors, warnings, entries, extra = {}) {
  return {
    contract: SURFACE_RESULT_CONTRACT,
    validator,
    ok,
    errors,
    warnings,
    summary: summarize(entries),
    ...extra,
  };
}

function countBy(entries, field) {
  const counts = {};
  for (const entry of entries) {
    const value = String(entry[field] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function groupInventoryByDisposition(entries) {
  const groups = {};
  for (const entry of entries) {
    const disposition = String(entry.disposition);
    const group = groups[disposition] ?? [];
    group.push(entry.source_path);
    groups[disposition] = group;
  }
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.sort()]));
}

function buildMigrationGroups(entries) {
  const groupKinds = [
    {
      group_id: "move-package-methodology-copied-under-spec",
      dispositions: ["move_package"],
      requires_confirmation: false,
    },
    {
      group_id: "move-local-derived-and-audit-state",
      dispositions: ["move_local"],
      requires_confirmation: false,
    },
    {
      group_id: "rewrite-product-authority-tables-and-guidance",
      dispositions: ["rewrite"],
      requires_confirmation: true,
    },
    {
      group_id: "resolve-blocked-semantic-forks",
      dispositions: ["block"],
      requires_confirmation: true,
    },
  ];
  return groupKinds
    .map((group) => {
      const matching = entries.filter((entry) => group.dispositions.includes(entry.disposition));
      return {
        ...group,
        entry_count: matching.length,
        source_paths: matching.map((entry) => entry.source_path).sort(),
      };
    })
    .filter((group) => group.entry_count > 0);
}

function enumValidation(entries, inventory) {
  const targetClasses = new Set(inventory.target_class_enum);
  const dispositions = new Set(inventory.disposition_enum);
  return {
    unknown_target_classes: entries
      .filter((entry) => !targetClasses.has(entry.target_class))
      .map((entry) => entry.source_path),
    unknown_dispositions: entries
      .filter((entry) => !dispositions.has(entry.disposition))
      .map((entry) => entry.source_path),
  };
}

function migrationPlanForInventory(rootRef, inventory) {
  const entries = inventory.inventory;
  const enumStatus = enumValidation(entries, inventory);
  const requiredConfirmationEntries = entries.filter((entry) => entry.required_confirmation !== "none");
  return {
    contract: "nimicoding.spec-migration-plan.v2",
    ok: enumStatus.unknown_target_classes.length === 0 && enumStatus.unknown_dispositions.length === 0,
    version: inventory.version,
    root: rootRef,
    inventory: entries,
    disposition_enum: inventory.disposition_enum,
    target_class_enum: inventory.target_class_enum,
    semantic_constraints: [
      ...inventory.semantic_constraints,
      "migration_plan_must_not_modify_files",
      "required_confirmation_entries_must_be_preserved",
      "local_only_plan_artifact_required",
    ],
    summary: {
      total_files: entries.length,
      by_surface_class: countBy(entries, "current_inferred_class"),
      by_disposition: countBy(entries, "disposition"),
      by_required_confirmation: countBy(entries, "required_confirmation"),
      required_confirmation_count: requiredConfirmationEntries.length,
      blocking_entries: entries.filter((entry) => entry.disposition === "block").length,
    },
    enum_validation: enumStatus,
    required_confirmations: requiredConfirmationEntries.map((entry) => ({
      source_path: entry.source_path,
      required_confirmation: entry.required_confirmation,
      ambiguity: entry.ambiguity,
      evidence: entry.evidence,
      recommendation: entry.required_confirmation === "product_semantic_fork"
        ? "stop_for_user_decision_before_migration"
        : "resolve_owner_or_package_boundary_before_migration",
    })),
    groups: groupInventoryByDisposition(entries),
    migration_groups: buildMigrationGroups(entries),
    mutation_policy: {
      mutates_source_tree: false,
      allowed_output_roots: [".nimi/local/state/spec-surface"],
      forbidden_output_roots: [".nimi/spec", ".nimi/contracts", ".nimi/methodology", ".nimi/config"],
    },
  };
}

export async function classifySpecSurface(projectRoot, options = {}) {
  const { entries, errors } = await buildInventory(projectRoot, options);
  return reportFor("classify-spec-tree", errors.length === 0, errors, [], entries, {
    inventory: {
      version: 2,
      inventory: entries,
      disposition_enum: ["keep", "move_package", "move_local", "split", "rewrite", "delete", "block"],
      target_class_enum: [
        "product_authority",
        "product_authority_table",
        "thin_guidance",
        "host_instruction",
        "tracked_derived_projection",
        "derived_view",
        "spec_generation_state",
        "audit_evidence_state",
        "operational_local_artifact",
        "methodology_authority",
        "nimicoding_managed_projection",
        "host_projection_anchor",
        "support_registry",
      ],
      semantic_constraints: [
        "inventory_must_not_modify_files",
        "future_under_spec_must_fail_classification",
        "nimicoding_managed_projection_must_not_be_promoted_to_product_authority",
      ],
    },
  });
}

export async function generateSpecMigrationPlan(projectRoot, options = {}) {
  const classification = await classifySpecSurface(projectRoot, options);
  return migrationPlanForInventory(options.rootRef ?? ".nimi/spec", classification.inventory);
}

export async function buildSpecSurfaceInventory(projectRoot, options = {}) {
  const { entries, errors } = await buildInventory(projectRoot, options);
  return {
    contract: SURFACE_RESULT_CONTRACT,
    entries,
    errors,
    summary: summarize(entries),
  };
}

export function isProductAuthoritySurfaceClass(surfaceClass) {
  return [
    "product_authority",
    "product_authority_table",
    "thin_guidance",
    "host_projection_anchor",
    "support_registry",
  ].includes(surfaceClass);
}

export async function validatePlacement(projectRoot, options = {}) {
  const { entries, layoutErrors } = await buildInventory(projectRoot, options);
  const errors = [
    ...layoutErrors,
    ...entries.flatMap((entry) => entry.validation_errors?.placement ?? []),
  ];
  return reportFor("validate-placement", errors.length === 0, errors, [], entries);
}

export async function validateTableFamily(projectRoot, options = {}) {
  const { contracts, entries } = await buildInventory(projectRoot, options);
  const errors = [];
  for (const entry of entries.filter((item) => item.source_path.startsWith(".nimi/spec/")
    && item.source_path.includes("/kernel/tables/")
    && isYamlRef(item.source_path)
    && ["product_authority_table", "support_registry"].includes(item.current_inferred_class))) {
    const text = await readFile(path.join(projectRoot, entry.source_path), "utf8");
    errors.push(...validateTableRef(entry.source_path, yamlForText(text), contracts));
  }
  return reportFor("validate-table-family", errors.length === 0, errors, [], entries);
}

export async function validateProjectionEdges(projectRoot, options = {}) {
  const { entries, contracts } = await buildInventory(projectRoot, options);
  const errors = [];
  const edgeTargets = new Set((contracts.projectionEdge.data?.projection_edges ?? []).map((entry) => String(entry.target_ref)));
  const anchorRef = ".nimi/spec/_meta/nimi-coding-admission-anchor.yaml";
  if (entries.some((entry) => entry.source_path === anchorRef) && !edgeTargets.has(anchorRef)) {
    addError(errors, "missing_projection_edge_for_anchor", anchorRef);
  }
  for (const entry of entries) {
    if (entry.current_inferred_class === "methodology_authority" && entry.source_path.startsWith(".nimi/spec/")) {
      addError(errors, "package_body_promoted_to_product_authority", entry.source_path);
    }
    if (entry.current_inferred_class === "product_authority") {
      const text = await readFile(path.join(projectRoot, entry.source_path), "utf8");
      if (GENERATED_REF_PATTERN.test(text)) {
        addError(errors, "derived_view_referenced_as_authority", entry.source_path);
      }
    }
  }
  return reportFor("validate-projection-edges", errors.length === 0, errors, [], entries);
}

export async function validateGuidanceBodies(projectRoot, options = {}) {
  const { entries } = await buildInventory(projectRoot, options);
  const errors = [];
  for (const entry of entries.filter((item) => item.current_inferred_class === "thin_guidance")) {
    const text = await readFile(path.join(projectRoot, entry.source_path), "utf8");
    if (TEXT_RULE_BODY_PATTERN.test(text)) {
      addError(errors, "guidance_defines_rule_body", entry.source_path);
    }
    if (PRODUCT_RULE_DEFINITION_PATTERN.test(text)) {
      addError(errors, "guidance_defines_product_rule", entry.source_path);
    }
  }
  return reportFor("validate-guidance-bodies", errors.length === 0, errors, [], entries);
}

export async function validateDomainAdmission(projectRoot, options = {}) {
  const { contracts, entries } = await buildInventory(projectRoot, options);
  const errors = [];
  for (const entry of entries.filter((item) => item.source_path.startsWith(".nimi/spec/"))) {
    errors.push(...validateDomainRef(entry.source_path, contracts));
  }
  return reportFor("validate-domain-admission", errors.length === 0, errors, [], entries);
}

export async function validateTrackedOutputAdmission(projectRoot, options = {}) {
  const { contracts, entries } = await buildInventory(projectRoot, options);
  const admittedRoots = trackedAdmissionRoots(contracts);
  const errors = [];
  for (const entry of entries.filter((item) => isTrackedNonProductRef(item.source_path))) {
    if (!isAdmittedTrackedOutput(entry.source_path, admittedRoots)) {
      addError(errors, "tracked_non_product_without_admission", entry.source_path);
    }
  }
  return reportFor("validate-tracked-output-admission", errors.length === 0, errors, [], entries);
}

export function parseSurfaceValidatorOptions(args) {
  const options = {
    profile: "default",
    rootRef: ".nimi/spec",
    emit: null,
    check: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      options.profile = args[index + 1] ?? "";
      index += 1;
    } else if (arg === "--root") {
      options.rootRef = args[index + 1] ?? "";
      index += 1;
    } else if (arg === "--emit") {
      options.emit = args[index + 1] ?? "";
      index += 1;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }

  if (!options.rootRef) {
    return { ok: false, error: "--root must not be empty" };
  }
  return { ok: true, options };
}

export async function writeInventoryIfRequested(report, emitRef, projectRoot) {
  if (!emitRef) {
    return;
  }
  const absolutePath = path.resolve(projectRoot, emitRef);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report.inventory, null, 2)}\n`, "utf8");
}

export async function writeMigrationPlanIfRequested(report, emitRef, projectRoot) {
  if (!emitRef) {
    return;
  }
  const allowedRoot = path.resolve(projectRoot, ".nimi/local/state/spec-surface");
  const absolutePath = path.resolve(projectRoot, emitRef);
  const relativeToAllowedRoot = path.relative(allowedRoot, absolutePath);
  if (
    relativeToAllowedRoot === "" ||
    relativeToAllowedRoot.startsWith("..") ||
    path.isAbsolute(relativeToAllowedRoot)
  ) {
    throw new Error("--emit must target .nimi/local/state/spec-surface/**");
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
