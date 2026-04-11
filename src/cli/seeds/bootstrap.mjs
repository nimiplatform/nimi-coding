import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_ROOT = fileURLToPath(new URL("../../../templates/bootstrap", import.meta.url));

async function collectTemplateFiles(rootPath, currentPath, seedMap) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await collectTemplateFiles(rootPath, absolutePath, seedMap);
      continue;
    }

    const relativePath = path.relative(rootPath, absolutePath);
    seedMap.set(relativePath, await readFile(absolutePath, "utf8"));
  }
}

export async function createBootstrapSeedFileMap() {
  const seedMap = new Map();
  await collectTemplateFiles(TEMPLATE_ROOT, TEMPLATE_ROOT, seedMap);
  return seedMap;
}
