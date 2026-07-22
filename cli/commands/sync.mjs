import { runSeedSync, SYNC_MODE, SYNC_RESULT_STATUS } from "../lib/sync.mjs";
import { localize } from "../lib/ui.mjs";

function parseSyncOptions(args) {
  const options = { mode: SYNC_MODE.DRY_RUN, json: false };
  let modeSet = false;
  for (const arg of args) {
    if (["--apply", "--check", "--dry-run"].includes(arg)) {
      if (modeSet) return { ok: false, error: localize("nimicoding sync refused: --apply, --check, and --dry-run are mutually exclusive.\n", "nimicoding sync 拒绝执行：--apply、--check、--dry-run 互斥。\n") };
      options.mode = arg === "--apply" ? SYNC_MODE.APPLY : arg === "--check" ? SYNC_MODE.CHECK : SYNC_MODE.DRY_RUN;
      modeSet = true;
    } else if (arg === "--json") options.json = true;
    else return { ok: false, error: localize(`nimicoding sync refused: unknown option ${arg}.\n`, `nimicoding sync 拒绝执行：未知选项 ${arg}。\n`) };
  }
  return { ok: true, options };
}

function formatHumanReport(result) {
  const lines = [`nimicoding sync (${result.mode})`, "", localize("Summary:", "概览：")];
  for (const [key, value] of Object.entries(result.summary)) lines.push(`  ${key}: ${value}`);
  const noteworthy = result.results.filter((entry) => entry.status !== SYNC_RESULT_STATUS.IN_SYNC);
  if (noteworthy.length > 0) {
    lines.push("", localize("Per-surface status:", "逐表面状态："));
    for (const entry of noteworthy) lines.push(`  [${entry.status}] (${entry.ownership}) ${entry.outputRelativePath}`);
  }
  if (result.mode === SYNC_MODE.CHECK && !result.ok) {
    lines.push("", localize("FAIL: an exact package projection or managed block is missing or drifted, or an exact deprecated package projection path remains.", "FAIL：精确 package 投影或 managed block 缺失/漂移，或精确 deprecated package 投影路径仍然存在。"));
  }
  return `${lines.join("\n")}\n`;
}

export async function runSync(args) {
  const parsed = parseSyncOptions(args);
  if (!parsed.ok) {
    process.stderr.write(parsed.error);
    return 2;
  }
  let result;
  try {
    result = await runSeedSync(process.cwd(), parsed.options.mode);
  } catch (error) {
    process.stderr.write(localize(
      `nimicoding sync refused: ${error.message}.\n`,
      `nimicoding sync 已拒绝：${error.message}。\n`,
    ));
    return 2;
  }
  process.stdout.write(parsed.options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHumanReport(result));
  return result.ok ? 0 : 1;
}

export { parseSyncOptions };
