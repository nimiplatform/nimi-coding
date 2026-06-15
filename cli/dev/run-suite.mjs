import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = spawnSync(process.execPath, ["--test"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, NIMICODING_LANG: "en", NO_COLOR: "1" },
});

if (result.error) {
  process.stderr.write(`node --test failed: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
