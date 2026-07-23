export {
  appendGitattributesEntries,
  appendGitignoreEntries,
  hasExactGitignoreRule,
  hasExactTextLine,
  ManagedPathError,
  ManagedTextError,
  normalizeTextToLf,
  pathExists,
  preflightManagedProjectPaths,
  readTextIfFile,
  readUtf8FileFatal,
} from "./fs-helpers.mjs";
export {
  integrateEntrypoints,
  previewEntrypointIntegration,
  previewEntrypointRemoval,
  removeManagedEntrypoints,
} from "./entrypoints.mjs";
export {
  previewBootstrapRemoval,
  previewBootstrapWrites,
  removeManagedBootstrapFiles,
  writeMissingBootstrapFiles,
} from "./bootstrap.mjs";
export {
  formatDoctorResult,
  inspectDoctorState,
} from "./doctor.mjs";
