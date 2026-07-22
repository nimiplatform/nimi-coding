import { runAuthority } from "./commands/authority.mjs";
import { runBlueprintAudit } from "./commands/blueprint-audit.mjs";
import { runClassifySpecTree } from "./commands/classify-spec-tree.mjs";
import { runClear } from "./commands/clear.mjs";
import { runDoctor } from "./commands/doctor.mjs";
import { runGenerateSpecDerivedDocs } from "./commands/generate-spec-derived-docs.mjs";
import { runGenerateSpecMigrationPlan } from "./commands/generate-spec-migration-plan.mjs";
import { runStart } from "./commands/start.mjs";
import { runSync } from "./commands/sync.mjs";
import { runValidateAiGovernance } from "./commands/validate-ai-governance.mjs";
import { runValidateDomainAdmission } from "./commands/validate-domain-admission.mjs";
import { runValidateGuidanceBodies } from "./commands/validate-guidance-bodies.mjs";
import { runValidatePlacement } from "./commands/validate-placement.mjs";
import { runValidateProjectionEdges } from "./commands/validate-projection-edges.mjs";
import { runValidateSpecAudit } from "./commands/validate-spec-audit.mjs";
import { runValidateSpecGovernance } from "./commands/validate-spec-governance.mjs";
import { runValidateSpecTree } from "./commands/validate-spec-tree.mjs";
import { runValidateTableFamily } from "./commands/validate-table-family.mjs";
import { runValidateTrackedOutputAdmission } from "./commands/validate-tracked-output-admission.mjs";
import { helpText } from "./help.mjs";
import { VERSION } from "./constants.mjs";
import { configureCliUi, localize, parseGlobalUiOptions } from "./lib/ui.mjs";

const COMMANDS = {
  authority: runAuthority,
  start: runStart,
  sync: runSync,
  clear: runClear,
  doctor: runDoctor,
  "blueprint-audit": runBlueprintAudit,
  "validate-spec-governance": runValidateSpecGovernance,
  "validate-spec-audit": runValidateSpecAudit,
  "validate-spec-tree": runValidateSpecTree,
  "classify-spec-tree": runClassifySpecTree,
  "validate-placement": runValidatePlacement,
  "validate-table-family": runValidateTableFamily,
  "validate-projection-edges": runValidateProjectionEdges,
  "validate-guidance-bodies": runValidateGuidanceBodies,
  "validate-domain-admission": runValidateDomainAdmission,
  "validate-tracked-output-admission": runValidateTrackedOutputAdmission,
  "generate-spec-derived-docs": runGenerateSpecDerivedDocs,
  "generate-spec-migration-plan": runGenerateSpecMigrationPlan,
  "validate-ai-governance": runValidateAiGovernance,
};

export async function runCli(args) {
  const parsedUi = parseGlobalUiOptions(args);
  if (!parsedUi.ok) {
    process.stderr.write(parsedUi.error);
    return 2;
  }

  configureCliUi({
    locale: parsedUi.locale,
    colorEnabled: parsedUi.colorEnabled,
  });

  const [command] = parsedUi.args;
  const rest = parsedUi.args.slice(1);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    if (rest.length > 0) {
      process.stderr.write(localize(
        `nimicoding help refused: unexpected arguments: ${rest.join(" ")}\n`,
        `nimicoding help 拒绝执行：存在未预期参数：${rest.join(" ")}\n`,
      ));
      return 2;
    }
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    if (rest.length > 0) {
      process.stderr.write(localize(
        `nimicoding version refused: unexpected arguments: ${rest.join(" ")}\n`,
        `nimicoding version 拒绝执行：存在未预期参数：${rest.join(" ")}\n`,
      ));
      return 2;
    }
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const runner = COMMANDS[command];
  if (!runner) {
    process.stderr.write(localize(
      `Unknown command: ${command}\n\n${helpText()}`,
      `未知命令：${command}\n\n${helpText()}`,
    ));
    return 2;
  }

  return runner(rest);
}
