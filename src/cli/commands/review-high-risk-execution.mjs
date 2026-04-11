import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildHighRiskReviewPayload,
  formatHighRiskReviewPayload,
} from "../lib/high-risk-review.mjs";

function parseReviewHighRiskExecutionOptions(args) {
  const options = {
    fromPath: null,
    json: false,
    writeLocal: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--write-local") {
      options.writeLocal = true;
      continue;
    }

    if (arg === "--from") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        return {
          ok: false,
          error: "nimicoding review-high-risk-execution refused: --from requires a value.\n",
        };
      }
      options.fromPath = next;
      index += 1;
      continue;
    }

    return {
      ok: false,
      error: `nimicoding review-high-risk-execution refused: unknown option ${arg}.\n`,
    };
  }

  if (!options.fromPath) {
    return {
      ok: false,
      error: "nimicoding review-high-risk-execution refused: explicit --from is required.\n",
    };
  }

  return { ok: true, options };
}

export async function runReviewHighRiskExecution(args) {
  const parsed = parseReviewHighRiskExecutionOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }

  const payload = await buildHighRiskReviewPayload(process.cwd(), parsed.options.fromPath, parsed.options);
  if (payload.inputError) {
    process.stderr.write(payload.error);
    return payload.exitCode;
  }

  if (parsed.options.writeLocal && payload.ok) {
    await mkdir(path.dirname(payload.artifactPath), { recursive: true });
    await writeFile(payload.artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(formatHighRiskReviewPayload(payload));
  }

  return payload.exitCode;
}

export { parseReviewHighRiskExecutionOptions };
