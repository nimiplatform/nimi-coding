import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { compareText, createLocator, makeDiagnostic, portablePath, REPAIRS, sortDiagnostics } from "./diagnostics.mjs";
import { parseMarkdownAuthority, stringifyCanonicalMarkdown } from "./source-markdown.mjs";
import { loadAuthorityContract, parseYamlAuthority, stringifyCanonicalYaml } from "./source-yaml.mjs";
import { validateFormatStructure } from "./validate.mjs";

export class AuthorityInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorityInputError";
  }
}

function profileFor(filePath) {
  if (filePath.endsWith(".authority.yaml")) return "yaml";
  if (filePath.endsWith(".authority.md")) return "markdown";
  return null;
}

async function collectDirectory(current, files) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new AuthorityInputError(`authority input refuses symbolic link: ${absolutePath}`);
    if (entry.isDirectory()) await collectDirectory(absolutePath, files);
    else if (entry.isFile()) {
      if (!profileFor(absolutePath)) throw new AuthorityInputError(`authority input contains unsupported file: ${absolutePath}`);
      files.push(absolutePath);
    } else throw new AuthorityInputError(`authority input contains unsupported filesystem entry: ${absolutePath}`);
  }
}

export async function collectAuthorityFiles(inputPath, options = {}) {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    throw new AuthorityInputError(`authority input is not readable: ${absolutePath}: ${error.message}`);
  }
  if (info.isSymbolicLink()) throw new AuthorityInputError(`authority input refuses symbolic link: ${absolutePath}`);
  if (options.singleFile && !info.isFile()) throw new AuthorityInputError("authority fmt requires one regular canonical source file");
  const files = [];
  if (info.isFile()) {
    if (!profileFor(absolutePath)) throw new AuthorityInputError(`unsupported authority source suffix: ${absolutePath}`);
    files.push(absolutePath);
  } else if (info.isDirectory()) await collectDirectory(absolutePath, files);
  else throw new AuthorityInputError(`unsupported authority input type: ${absolutePath}`);
  if (files.length === 0) throw new AuthorityInputError(`authority input contains no canonical source files: ${absolutePath}`);
  return files;
}

export async function parseAuthorityFile(absolutePath) {
  const bytes = await readFile(absolutePath);
  const profile = profileFor(absolutePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    const file = portablePath(absolutePath);
    const locator = createLocator("");
    return {
      ok: false,
      file,
      locator,
      diagnostics: [makeDiagnostic({
        code: "AUTH_SYNTAX_UNSUPPORTED",
        file,
        range: locator.range(0),
        reason: "authority source bytes are not valid UTF-8",
        repair: "rewrite the file as valid UTF-8 without changing product semantics",
      })],
      locations: new Map(),
      keyLocations: new Map(),
      insertionPoints: new Map(),
      data: null,
      profile,
      isDocument: true,
      units: [],
      sourceText: "",
      absolutePath,
    };
  }
  const source = profile === "yaml"
    ? parseYamlAuthority(text, absolutePath)
    : parseMarkdownAuthority(text, absolutePath);
  const document = profile === "yaml"
    ? source
    : { ...source, isDocument: true, units: source.data ? [source] : [] };
  return { ...document, absolutePath };
}

export async function parseAuthorityPath(inputPath, options = {}) {
  const contract = await loadAuthorityContract();
  const files = await collectAuthorityFiles(inputPath, options);
  const documents = [];
  const sources = [];
  for (const file of files) {
    const document = await parseAuthorityFile(file);
    documents.push(document);
    sources.push(...document.units.map((source) => ({ ...source, absolutePath: document.absolutePath })));
  }
  return { contract, files, documents, sources };
}

export function canonicalText(document) {
  return document.profile === "yaml"
    ? stringifyCanonicalYaml(document.data, { container: true })
    : stringifyCanonicalMarkdown(document.data);
}

export function formattingDiagnostics(documents, contract) {
  const diagnostics = [];
  for (const document of documents) {
    const structure = validateFormatStructure(document, contract);
    if (structure.length > 0) {
      diagnostics.push(...structure);
      continue;
    }
    const canonical = canonicalText(document);
    if (canonical !== document.sourceText) {
      diagnostics.push(makeDiagnostic({
        code: "AUTH_FORMAT_DRIFT",
        file: document.file,
        range: document.locations.get("") ?? document.locator.range(0, document.sourceText.length),
        reason: "authority source is not byte-canonical",
        repair: REPAIRS.format,
      }));
    }
  }
  return sortDiagnostics(diagnostics);
}

async function atomicWrite(filePath, content) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function formatAuthorityFile(inputPath, options = {}) {
  const { contract, documents } = await parseAuthorityPath(inputPath, { singleFile: true });
  const document = documents[0];
  const diagnostics = validateFormatStructure(document, contract);
  if (diagnostics.length > 0) return { ok: false, changed: false, diagnostics, fileCount: 1 };
  const canonical = canonicalText(document);
  const changed = canonical !== document.sourceText;
  if (options.check && changed) return {
    ok: false,
    changed: true,
    diagnostics: formattingDiagnostics([document], contract),
    fileCount: 1,
  };
  if (!options.check && changed) await atomicWrite(document.absolutePath ?? path.resolve(process.cwd(), inputPath), canonical);
  return { ok: true, changed, diagnostics: [], fileCount: 1 };
}
