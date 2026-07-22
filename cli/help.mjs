import { VERSION } from "./constants.mjs";
import { localize, styleCommand, styleHeading, styleMuted } from "./lib/ui.mjs";

export function helpText() {
  const commands = [
    "nimicoding authority fmt <file> [--check] [--json]",
    "nimicoding authority check <path> [--json]",
    "nimicoding authority compile <path> [--json]",
    "nimicoding authority query <path> <id> --max-bytes <positive-integer> [--json]",
    "nimicoding authority context <path> <id> --max-units <positive-integer> --max-bytes <positive-integer> [--json]",
    "nimicoding authority diff <before-path> <after-path> --max-bytes <positive-integer> [--json]",
    "nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <positive-integer> [--json]",
    "nimicoding start [--yes]",
    "nimicoding sync [--apply|--check|--dry-run] [--json]",
    "nimicoding clear [--yes]",
    "nimicoding doctor [--verbose|--json]",
    "nimicoding validate-ai-governance --profile <profile-id> --scope <all|agents-freshness|context-budget|structure-budget|high-risk-doc-metadata>  # optional L3 repository governance",
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
      "Nimi Coding provides canonical authority methodology, formatting, compiler primitives, and deterministic gates. The optional L3 repository-governance command is not authority admission. AI task planning and execution belong to the host.",
      "Nimi Coding 提供 canonical authority 方法论、格式化、编译器原语与确定性 gate。可选 L3 repository-governance 命令不属于 authority admission；AI 任务规划与执行由宿主负责。",
    )),
    "",
  ].join("\n");
}
