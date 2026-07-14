import { readdir } from "node:fs/promises";
import path from "node:path";

export async function collectTreeFiles(rootPath) {
  async function walk(currentPath) {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = [];
    for (const entry of entries) {
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(childPath));
      } else if (entry.isFile()) {
        files.push(path.relative(rootPath, childPath).split(path.sep).join(path.posix.sep));
      }
    }
    return files.sort();
  }

  return walk(rootPath);
}
export function isSourceRefWithinDeclaredRoots(sourceRef, declaredInputs) {
  const roots = [
    ...declaredInputs.code_roots,
    ...declaredInputs.docs_roots,
    ...declaredInputs.structure_roots,
    ...(declaredInputs.benchmark_blueprint_root ? [declaredInputs.benchmark_blueprint_root] : []),
  ];

  return roots.some((root) => (
    root === "."
      ? !path.posix.isAbsolute(sourceRef)
      : sourceRef === root || sourceRef.startsWith(`${root}/`)
  ));
}

export function isDeclaredInputsCompatibleWithConfig(declaredInputs, generationInputs, blueprintReference) {
  const blueprintRoot = blueprintReference.present ? blueprintReference.root : null;
  const rootsAlign = (declaredRoots, configuredRoots) =>
    declaredRoots.every((entry) => configuredRoots.includes(entry));

  return rootsAlign(declaredInputs.code_roots, generationInputs.codeRoots ?? [])
    && rootsAlign(declaredInputs.docs_roots, generationInputs.docsRoots ?? [])
    && rootsAlign(declaredInputs.structure_roots, generationInputs.structureRoots ?? [])
    && declaredInputs.human_note_paths.length === 0
    && declaredInputs.benchmark_blueprint_root === blueprintRoot;
}
