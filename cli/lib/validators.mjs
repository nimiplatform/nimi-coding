import {
  VALIDATOR_CLI_RESULT_CONTRACT,
  VALIDATOR_NATIVE_REFUSAL_CODES,
} from "./internal/validators-shared.mjs";
import {
  validateSpecAudit as validateSpecAuditInternal,
  validateSpecTree as validateSpecTreeInternal,
} from "./internal/validators-spec.mjs";

export { VALIDATOR_NATIVE_REFUSAL_CODES };

export function validateSpecTree(rootPath, options = {}) {
  return validateSpecTreeInternal(rootPath, options);
}
export function validateSpecAudit(auditPath, options = {}) {
  return validateSpecAuditInternal(auditPath, options);
}

export function buildValidatorCliReport(validator, filePath, report) {
  return {
    contract: VALIDATOR_CLI_RESULT_CONTRACT,
    validator,
    target_ref: filePath,
    ok: Boolean(report.ok),
    refusal: report.refusal || null,
    errors: report.errors || [],
    warnings: report.warnings || [],
    ...(report.summary ? { summary: report.summary } : {}),
  };
}
