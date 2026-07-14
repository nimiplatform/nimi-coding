import {
  loadBlueprintReference as loadBlueprintReferenceInternal,
  loadSpecGenerationAuditContract as loadSpecGenerationAuditContractInternal,
  loadSpecGenerationInputsConfig as loadSpecGenerationInputsConfigInternal,
  loadSpecGenerationInputsContract as loadSpecGenerationInputsContractInternal,
} from "./internal/contracts-loaders.mjs";

export function loadSpecGenerationInputsContract(projectRoot) {
  return loadSpecGenerationInputsContractInternal(projectRoot);
}
export function loadSpecGenerationAuditContract(projectRoot) {
  return loadSpecGenerationAuditContractInternal(projectRoot);
}

export function loadSpecGenerationInputsConfig(projectRoot) {
  return loadSpecGenerationInputsConfigInternal(projectRoot);
}

export function loadBlueprintReference(projectRoot) {
  return loadBlueprintReferenceInternal(projectRoot);
}
