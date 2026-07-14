import { VERSION } from "./constants.mjs";
import { localize, styleCommand, styleHeading, styleMuted } from "./lib/ui.mjs";

export function helpText() {
  const commands = [
    "nimicoding start [--yes]",
    "nimicoding sync [--apply|--check|--dry-run] [--json]",
    "nimicoding clear [--yes]",
    "nimicoding doctor [--verbose|--json]",
    "nimicoding blueprint-audit [--blueprint-root <path>] [--canonical-root <path>] [--json] [--write-local]",
    "nimicoding validate-spec-tree [.nimi/spec]",
    "nimicoding validate-spec-audit [.nimi/local/state/spec-generation/spec-generation-audit.yaml]",
    "nimicoding classify-spec-tree --profile <profile-id> --root .nimi/spec [--emit <path>] [--json]",
    "nimicoding generate-spec-migration-plan --profile <profile-id> --root .nimi/spec --emit .nimi/local/state/spec-surface/migration-plan.json [--json]",
    "nimicoding validate-placement --profile <profile-id> --root .nimi/spec [--json]",
    "nimicoding validate-table-family --profile <profile-id> --root .nimi/spec [--json]",
    "nimicoding validate-projection-edges --profile <profile-id> --root .nimi/spec [--json]",
    "nimicoding validate-guidance-bodies --profile <profile-id> --root .nimi/spec [--json]",
    "nimicoding validate-domain-admission --profile <profile-id> --root .nimi/spec [--json]",
    "nimicoding validate-tracked-output-admission --profile <profile-id> --root .nimi/spec [--json]",
    "nimicoding validate-spec-governance --profile <profile-id> --scope <all|host-defined-scope>",
    "nimicoding generate-spec-derived-docs --profile <profile-id> --scope <all|host-defined-scope> [--check]",
    "nimicoding validate-ai-governance --profile <profile-id> --scope <all|agents-freshness|context-budget|structure-budget|high-risk-doc-metadata>",
  ];

  return [
    styleHeading(`nimicoding ${VERSION}`),
    "",
    localize("Usage:", "用法："),
    `  ${styleCommand("nimicoding --help")}`,
    `  ${styleCommand("nimicoding --version")}`,
    ...commands.map((command) => `  ${styleCommand(command)}`),
    "",
    styleMuted(localize(
      "Nimi Coding defines methodology, canonical spec construction, and deterministic governance checks. AI task planning and execution belong to the host.",
      "Nimi Coding 只定义方法论、canonical spec 构建和确定性治理校验；AI 任务规划与执行由宿主负责。",
    )),
    "",
  ].join("\n");
}
