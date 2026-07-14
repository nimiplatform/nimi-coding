import path from "node:path";

import {
  BLUEPRINT_REFERENCE_REF,
  SPEC_GENERATION_AUDIT_CONTRACT_REF,
  SPEC_GENERATION_INPUTS_CONTRACT_REF,
  SPEC_GENERATION_INPUTS_REF,
} from "../../constants.mjs";
import { readTextIfFile } from "../fs-helpers.mjs";
import {
  parseBlueprintReference,
  parseSpecGenerationAuditContract,
  parseSpecGenerationInputsConfig,
  parseSpecGenerationInputsContract,
} from "./contracts-parse.mjs";

async function loadParsedYaml(projectRoot, relativePath, parse) {
  const text = await readTextIfFile(path.join(projectRoot, relativePath));
  return {
    path: relativePath,
    text,
    ...parse(text),
  };
}
export function loadSpecGenerationInputsContract(projectRoot) {
  return loadParsedYaml(
    projectRoot,
    SPEC_GENERATION_INPUTS_CONTRACT_REF,
    parseSpecGenerationInputsContract,
  );
}

export function loadSpecGenerationAuditContract(projectRoot) {
  return loadParsedYaml(
    projectRoot,
    SPEC_GENERATION_AUDIT_CONTRACT_REF,
    parseSpecGenerationAuditContract,
  );
}

export function loadSpecGenerationInputsConfig(projectRoot) {
  return loadParsedYaml(projectRoot, SPEC_GENERATION_INPUTS_REF, parseSpecGenerationInputsConfig);
}

export function loadBlueprintReference(projectRoot) {
  return loadParsedYaml(projectRoot, BLUEPRINT_REFERENCE_REF, parseBlueprintReference);
}
