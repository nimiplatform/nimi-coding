import { formatDoctorResult, inspectDoctorState } from "../lib/shared.mjs";

function parseDoctorOptions(args) {
  const options = {
    json: false,
  };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    return {
      ok: false,
      error: `nimicoding doctor refused: unknown option ${arg}.\n`,
    };
  }

  return {
    ok: true,
    options,
  };
}

export async function runDoctor(args) {
  const parsed = parseDoctorOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }

  const result = await inspectDoctorState(process.cwd());
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorResult(result));
  }

  return result.ok ? 0 : 1;
}

export { parseDoctorOptions };
