import { runCloseout } from "./commands/closeout.mjs";
import { runAdmitHighRiskDecision } from "./commands/admit-high-risk-decision.mjs";
import { runDecideHighRiskExecution } from "./commands/decide-high-risk-execution.mjs";
import { runDoctor } from "./commands/doctor.mjs";
import { runHandoff } from "./commands/handoff.mjs";
import { runIngestHighRiskExecution } from "./commands/ingest-high-risk-execution.mjs";
import { runInit } from "./commands/init.mjs";
import { runRepair } from "./commands/repair.mjs";
import { runReviewHighRiskExecution } from "./commands/review-high-risk-execution.mjs";
import { runValidateAcceptance } from "./commands/validate-acceptance.mjs";
import { runValidateExecutionPacket } from "./commands/validate-execution-packet.mjs";
import { runValidateOrchestrationState } from "./commands/validate-orchestration-state.mjs";
import { runValidatePrompt } from "./commands/validate-prompt.mjs";
import { runValidateWorkerOutput } from "./commands/validate-worker-output.mjs";
import { helpText } from "./help.mjs";
import { VERSION } from "./constants.mjs";

const COMMANDS = {
  init: runInit,
  repair: runRepair,
  doctor: runDoctor,
  handoff: runHandoff,
  closeout: runCloseout,
  "admit-high-risk-decision": runAdmitHighRiskDecision,
  "decide-high-risk-execution": runDecideHighRiskExecution,
  "ingest-high-risk-execution": runIngestHighRiskExecution,
  "review-high-risk-execution": runReviewHighRiskExecution,
  "validate-execution-packet": runValidateExecutionPacket,
  "validate-orchestration-state": runValidateOrchestrationState,
  "validate-prompt": runValidatePrompt,
  "validate-worker-output": runValidateWorkerOutput,
  "validate-acceptance": runValidateAcceptance,
};

export async function runCli(args) {
  const [command] = args;
  const rest = args.slice(1);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    if (rest.length > 0) {
      process.stderr.write(`nimicoding help refused: unexpected arguments: ${rest.join(" ")}\n`);
      return 2;
    }
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    if (rest.length > 0) {
      process.stderr.write(`nimicoding version refused: unexpected arguments: ${rest.join(" ")}\n`);
      return 2;
    }
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const runner = COMMANDS[command];
  if (!runner) {
    process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
    return 2;
  }

  return runner(rest);
}
