import { VERSION } from "./constants.mjs";
import { AUTHORITY_ANCHOR_GRAMMAR_HELP } from "./lib/authority/anchors.mjs";
import { localize, styleCommand, styleHeading, styleMuted } from "./lib/ui.mjs";

export function helpText() {
  const commands = [
    "nimicoding authority fmt <file> [--check] [--json]",
    "nimicoding authority check <path> [--scope-bindings <file>] [--json]",
    "nimicoding authority compile <path> [--json]",
    "nimicoding authority anchors <repository-path> --spec <corpus-path> [--scope-bindings <file>] --max-units <positive-safe-integer> --max-anchors <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
    "nimicoding authority discover <path> <query> [--kind <definition|rule>] [--owner <exact-owner>] [--scope <exact-scope>] [--lifecycle <active|removed>] --max-candidates <positive-safe-integer> --max-snippet-terms <positive-safe-integer> --max-bytes <positive-safe-integer> [--preview-direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-edges <positive-safe-integer>] [--json]",
    "nimicoding authority query <path> <id> --max-bytes <positive-integer> [--json]",
    "nimicoding authority context <path> <id> --max-units <positive-integer> --max-bytes <positive-integer> [--json]",
    "nimicoding authority refs <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
    "nimicoding authority path <path> <from-id> <to-id> --traversal <directed|incidence> --relations <comma-separated-relation-types> --max-hops <positive-safe-integer> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
    "nimicoding authority subgraph <path> <id> --direction <incoming|outgoing|both> --relations <comma-separated-relation-types> --depth <positive-safe-integer> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
    "nimicoding authority audit <path> --bindings <file> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json|--sarif]",
    "nimicoding authority diff <before-path> <after-path> --max-bytes <positive-integer> [--json]",
    "nimicoding authority impact <before-path> <after-path> --dispositions <file> --max-bytes <positive-integer> [--json]",
    "nimicoding authority review <repository-path> --base <git-ref> --bindings <file> --dispositions <file> --max-units <positive-safe-integer> --max-edges <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
    "nimicoding authority evidence <repository-path> --bindings <tracked-.nimi/config-path> [--probe-results <.nimi/local-path>] --max-units <positive-safe-integer> --max-bindings <positive-safe-integer> --max-locators <positive-safe-integer> --max-edges <positive-safe-integer> --max-input-bytes <positive-safe-integer> --max-bytes <positive-safe-integer> [--json]",
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
    AUTHORITY_ANCHOR_GRAMMAR_HELP,
    "",
    styleMuted(localize(
      "Nimi Coding provides canonical authority methodology, formatting, compiler primitives, and deterministic gates. The optional L3 repository-governance command is not authority admission. AI task planning and execution belong to the host.",
      "Nimi Coding 提供 canonical authority 方法论、格式化、编译器原语与确定性 gate。可选 L3 repository-governance 命令不属于 authority admission；AI 任务规划与执行由宿主负责。",
    )),
    "",
  ].join("\n");
}
