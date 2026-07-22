import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POLICY_PATH = fileURLToPath(new URL("./seed-policy.yaml", import.meta.url));
let cachedPolicy = null;

function portable(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function admittedRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || value.startsWith("./") || value.split("/").includes("..") || path.posix.normalize(value) !== value) {
    throw new Error(`seed policy ${label} must be a portable relative path`);
  }
  return value;
}

async function loadPolicy() {
  if (cachedPolicy) return cachedPolicy;
  const parsed = YAML.parse(await readFile(POLICY_PATH, "utf8"));
  if (parsed?.policy_id !== "nimicoding.seed-projection.v3" || !Array.isArray(parsed.projections) || parsed.projections.length !== 1) {
    throw new Error("seed policy must declare the v3 exact projection registry");
  }

  const seenOutput = new Set();
  const projections = parsed.projections.map((entry) => {
    const sourceRelativePath = admittedRelativePath(entry?.source, "source");
    const outputRelativePath = admittedRelativePath(entry?.output, "output");
    if (!outputRelativePath.startsWith(".nimi/")) throw new Error(`seed policy output must stay below .nimi: ${outputRelativePath}`);
    if (entry?.ownership !== "package_canonical") throw new Error(`seed policy ownership is unsupported: ${entry?.ownership}`);
    if (typeof entry?.downstream_consumer !== "string" || !entry.downstream_consumer.trim()) throw new Error(`seed policy entry requires a downstream consumer: ${sourceRelativePath}`);
    if (seenOutput.has(outputRelativePath)) throw new Error(`seed policy contains duplicate output: ${outputRelativePath}`);
    seenOutput.add(outputRelativePath);
    return { sourceRelativePath, outputRelativePath, ownership: entry.ownership, downstreamConsumer: entry.downstream_consumer };
  });

  const deprecatedProjections = (parsed.deprecated_projections ?? []).map((entry) => admittedRelativePath(entry, "deprecated projection"));
  if (new Set(deprecatedProjections).size !== deprecatedProjections.length || deprecatedProjections.some((entry) => seenOutput.has(entry))) {
    throw new Error("seed policy deprecated projections must be unique and disjoint from current projections");
  }
  cachedPolicy = { policyId: parsed.policy_id, projections, deprecatedProjections: deprecatedProjections.sort() };
  return cachedPolicy;
}

export async function loadSeedPolicy() {
  return loadPolicy();
}

export async function getBootstrapSeedEntries() {
  const policy = await loadPolicy();
  const entries = [];
  for (const projection of policy.projections) {
    const sourceAbsolutePath = path.resolve(PACKAGE_ROOT, projection.sourceRelativePath);
    if (portable(path.relative(PACKAGE_ROOT, sourceAbsolutePath)) !== projection.sourceRelativePath) throw new Error(`seed source escapes package: ${projection.sourceRelativePath}`);
    entries.push({ ...projection, sourceAbsolutePath, content: await readFile(sourceAbsolutePath, "utf8") });
  }
  return entries;
}

export async function createBootstrapSeedFileMap() {
  const entries = await getBootstrapSeedEntries();
  return new Map(entries.map((entry) => [entry.outputRelativePath, entry.content]));
}
