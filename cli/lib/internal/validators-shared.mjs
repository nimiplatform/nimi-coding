export const VALIDATOR_CLI_RESULT_CONTRACT = "validator-cli-result.v1";

export const VALIDATOR_NATIVE_REFUSAL_CODES = {
  SPEC_TREE_MISSING: "SPEC_TREE_MISSING",
  SPEC_TREE_INVALID: "SPEC_TREE_INVALID",
  SPEC_AUDIT_MISSING: "SPEC_AUDIT_MISSING",
  SPEC_AUDIT_INVALID: "SPEC_AUDIT_INVALID",
};

export function makeValidatorRefusal(code, message) {
  return { code, message };
}
