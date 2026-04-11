import { VERSION } from "./constants.mjs";

export function helpText() {
  return `nimicoding ${VERSION}

Usage:
  nimicoding --help
  nimicoding --version
  nimicoding init
  nimicoding init --with-entrypoints
  nimicoding repair
  nimicoding repair --with-entrypoints
  nimicoding doctor
  nimicoding doctor --json
  nimicoding handoff --skill <skill-id>
  nimicoding handoff --skill <skill-id> --json
  nimicoding handoff --skill <skill-id> --prompt
  nimicoding admit-high-risk-decision --from <json> --admitted-at <iso8601> [--json] [--write-spec]
  nimicoding closeout --skill <skill-id> --outcome <completed|blocked|failed> --verified-at <iso8601>
  nimicoding closeout --skill <skill-id> --outcome <completed|blocked|failed> --verified-at <iso8601> --json
  nimicoding closeout --skill <skill-id> --outcome <completed|blocked|failed> --verified-at <iso8601> --write-local
  nimicoding closeout --from <json> [--json] [--write-local]
  nimicoding decide-high-risk-execution --from <json> --acceptance <path> --verified-at <iso8601> [--json] [--write-local]
  nimicoding ingest-high-risk-execution --from <json> [--json] [--write-local]
  nimicoding review-high-risk-execution --from <json> [--json] [--write-local]
  nimicoding validate-execution-packet <path>
  nimicoding validate-orchestration-state <path>
  nimicoding validate-prompt <path>
  nimicoding validate-worker-output <path>
  nimicoding validate-acceptance <path>

Current status:
  This CLI is boundary-complete for standalone bootstrap, contract, handoff,
  validation, projection, and explicit admission workflows. It is not a
  packaged run kernel: topic runtime, provider execution, scheduler,
  notification, automation, and self-hosting remain explicitly deferred.
`;
}
