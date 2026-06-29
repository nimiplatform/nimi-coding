export const GENERATED_RUNTIME_DECLARED_TARGETS = new Set([
  "reports/preset-zeroing-run.json",
  "source/source-manifest.json",
]);

function normalizedDeclaredTargetRef(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
}

export function isGeneratedRuntimeDeclaredTarget(ref) {
  return GENERATED_RUNTIME_DECLARED_TARGETS.has(normalizedDeclaredTargetRef(ref));
}
