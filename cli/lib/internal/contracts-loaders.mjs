import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLUEPRINT_REFERENCE_REF,
  SPEC_GENERATION_INPUTS_REF,
} from "../../constants.mjs";
import { readTextIfFile } from "../fs-helpers.mjs";
import {
  parseBlueprintReference,
  parseSpecGenerationAuditContract,
  parseSpecGenerationInputsConfig,
  parseSpecGenerationInputsContract,
} from "./contracts-parse.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function loadParsedYaml(projectRoot, relativePath, parse) {
  const text = await readTextIfFile(path.join(projectRoot, relativePath));
  return { path: relativePath, text, ...parse(text) };
}

async function loadParsedPackageYaml(relativePath, parse) {
  const text = await readTextIfFile(path.join(PACKAGE_ROOT, relativePath));
  return { path: `package://@nimiplatform/nimi-coding/${relativePath}`, text, ...parse(text) };
}

export function loadSpecGenerationInputsContract() {
  return loadParsedPackageYaml("contracts/spec-generation-inputs.schema.yaml", parseSpecGenerationInputsContract);
}

export function loadSpecGenerationAuditContract() {
  return loadParsedPackageYaml("contracts/spec-generation-audit.schema.yaml", parseSpecGenerationAuditContract);
}

export function loadSpecGenerationInputsConfig(projectRoot) {
  return loadParsedYaml(projectRoot, SPEC_GENERATION_INPUTS_REF, parseSpecGenerationInputsConfig);
}

export function loadBlueprintReference(projectRoot) {
  return loadParsedYaml(projectRoot, BLUEPRINT_REFERENCE_REF, parseBlueprintReference);
}
