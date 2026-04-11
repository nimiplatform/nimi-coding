import {
  buildHandoffPayload,
  formatHandoffPayload,
  formatHandoffPrompt,
} from "../lib/shared.mjs";

function parseHandoffOptions(args) {
  const options = {
    json: false,
    prompt: false,
    skill: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--prompt") {
      options.prompt = true;
      continue;
    }

    if (arg === "--skill") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        return {
          ok: false,
          error: "nimicoding handoff refused: --skill requires a skill id.\n",
        };
      }
      options.skill = next;
      index += 1;
      continue;
    }

    return {
      ok: false,
      error: `nimicoding handoff refused: unknown option ${arg}.\n`,
    };
  }

  if (!options.skill) {
    return {
      ok: false,
      error: "nimicoding handoff refused: explicit --skill is required.\n",
    };
  }

  if (options.json && options.prompt) {
    return {
      ok: false,
      error: "nimicoding handoff refused: --json and --prompt are mutually exclusive.\n",
    };
  }

  return {
    ok: true,
    options,
  };
}

export async function runHandoff(args) {
  const parsed = parseHandoffOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }

  const payload = await buildHandoffPayload(process.cwd(), parsed.options.skill);
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.options.prompt) {
    process.stdout.write(formatHandoffPrompt(payload));
  } else {
    process.stdout.write(formatHandoffPayload(payload));
  }

  return payload.exitCode;
}

export { parseHandoffOptions };
