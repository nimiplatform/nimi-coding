import { symlink } from "node:fs/promises";
import path from "node:path";

export async function createTestSymlink(target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) return false;
    throw error;
  }
}

export function portableTestCommand(executable, args) {
  if (process.platform !== "win32") return { executable, args };

  if (executable === "npm") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm", ...args],
    };
  }

  if (path.basename(executable).toLowerCase() === "nimicoding" && path.basename(path.dirname(executable)) === ".bin") {
    return {
      executable: process.execPath,
      args: [
        path.join(
          path.dirname(path.dirname(executable)),
          "@nimiplatform",
          "nimi-coding",
          "bin",
          "nimicoding.mjs",
        ),
        ...args,
      ],
    };
  }

  return { executable, args };
}
