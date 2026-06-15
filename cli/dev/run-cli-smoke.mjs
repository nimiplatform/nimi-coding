import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repoRoot, "bin", "nimicoding.mjs");

for (const args of [["--help"], ["--version"]]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
  });
  if (result.error) {
    process.stderr.write(`${args.join(" ")} smoke failed: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stderr.write(`${args.join(" ")} smoke exited with ${result.status ?? "unknown"}\n`);
    process.exit(result.status ?? 1);
  }
}
