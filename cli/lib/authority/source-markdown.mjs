import { makeDiagnostic, portablePath, REPAIRS, createLocator } from "./diagnostics.mjs";
import { FRONTMATTER_KEY_ORDER, parseRestrictedYaml, stringifyCanonicalYaml } from "./source-yaml.mjs";

const SECTION_FIELDS = new Map([
  ["Meaning", "meaning"],
  ["Statement", "statement"],
  ["Condition", "condition"],
  ["Failure", "failure"],
  ["Removal reason", "reason"],
]);
const BODY_ORDER = [
  ["meaning", "Meaning"],
  ["statement", "Statement"],
  ["condition", "Condition"],
  ["failure", "Failure"],
  ["reason", "Removal reason"],
];

function lineTable(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === "\n") {
      const raw = text.slice(start, index);
      lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

function ambiguous(file, locator, line, reason) {
  return makeDiagnostic({
    code: "AUTH_MARKDOWN_AMBIGUOUS",
    file,
    range: locator.range(line.start, line.end),
    reason,
    repair: REPAIRS.structural,
  });
}

function isPlainMarkdownSlot(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n\t]/.test(value)) return false;
  if (!/^[\p{L}\p{N}\p{M}\p{Zs}\p{P}\p{S}]+$/u.test(value)) return false;
  if (/[`*_\[\]<>\\~]/u.test(value)) return false;
  if (/^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|(?:-{3,}|={3,})(?:\s|$))/u.test(value)) return false;
  return true;
}

export function parseMarkdownAuthority(text, absolutePath, options = {}) {
  const file = portablePath(absolutePath, options.cwd);
  const locator = createLocator(text);
  const lines = lineTable(text);
  const diagnostics = [];
  if (lines[0]?.text !== "---") {
    diagnostics.push(ambiguous(file, locator, lines[0] ?? { start: 0, end: 0 }, "Markdown authority must start with YAML front matter"));
    return { ok: false, file, locator, diagnostics, locations: new Map(), data: null, profile: "markdown" };
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.text === "---");
  if (closingIndex < 0) {
    diagnostics.push(ambiguous(file, locator, lines[0], "Markdown front matter is missing its closing delimiter"));
    return { ok: false, file, locator, diagnostics, locations: new Map(), data: null, profile: "markdown" };
  }
  const frontStart = lines[0].end + 1;
  const frontEnd = lines[closingIndex].start;
  const front = text.slice(frontStart, frontEnd);
  const parsedFront = parseRestrictedYaml(front, absolutePath, { ...options, offset: frontStart, fullText: text, keyOrder: FRONTMATTER_KEY_ORDER });
  if (!parsedFront.ok) return { ...parsedFront, profile: "markdown" };
  const data = { ...parsedFront.data };
  const frontKeys = Object.keys(parsedFront.data);
  const locations = new Map(parsedFront.locations);
  const keyLocations = new Map(parsedFront.keyLocations);
  const insertionPoints = new Map(parsedFront.insertionPoints);
  const closingInsertion = locator.range(lines[closingIndex].start, lines[closingIndex].start);
  if (!Object.hasOwn(data, "relations")) insertionPoints.set("/relations", closingInsertion);
  locations.set("", locator.range(0, text.length));
  let index = closingIndex + 1;
  while (index < lines.length && lines[index].text === "") index += 1;
  if (lines[index]?.text.startsWith("# ")) {
    const title = lines[index].text.slice(2);
    data.title = title;
    locations.set("/title", locator.range(lines[index].start + 2, lines[index].end));
    if (!isPlainMarkdownSlot(title)) diagnostics.push(ambiguous(file, locator, lines[index], "Markdown title must be one plain non-empty text line"));
    index += 1;
  } else if (/^#(?!#)/.test(lines[index]?.text ?? "")) {
    diagnostics.push(ambiguous(file, locator, lines[index], "Markdown authority allows exactly one level-one title"));
    index += 1;
  }
  const seenSections = new Set();
  const sectionHeadings = new Map();
  while (index < lines.length) {
    while (index < lines.length && lines[index].text === "") index += 1;
    if (index >= lines.length || (index === lines.length - 1 && lines[index].text === "")) break;
    const heading = lines[index];
    if (!heading.text.startsWith("## ")) {
      diagnostics.push(ambiguous(file, locator, heading, "prose and constructs outside known Markdown authority slots are not admitted"));
      index += 1;
      continue;
    }
    const headingName = heading.text.slice(3);
    const field = SECTION_FIELDS.get(headingName);
    if (!field) {
      diagnostics.push(ambiguous(file, locator, heading, `unknown Markdown authority section: ${headingName}`));
      index += 1;
      continue;
    }
    if (seenSections.has(field)) {
      diagnostics.push(ambiguous(file, locator, heading, `duplicate Markdown authority section: ${headingName}`));
      index += 1;
      continue;
    }
    seenSections.add(field);
    sectionHeadings.set(field, locator.range(heading.start, heading.end));
    index += 1;
    while (index < lines.length && lines[index].text === "") index += 1;
    const body = lines[index];
    if (!body || body.text.startsWith("#")) {
      data[field] = "";
      locations.set(`/${field}`, locator.range(heading.end, heading.end));
      continue;
    }
    if (!isPlainMarkdownSlot(body.text)) {
      diagnostics.push(ambiguous(file, locator, body, `${headingName} must contain exactly one plain text line`));
    }
    data[field] = body.text;
    locations.set(`/${field}`, locator.range(body.start, body.end));
    index += 1;
    if (index < lines.length && lines[index].text !== "" && !lines[index].text.startsWith("## ")) {
      diagnostics.push(ambiguous(file, locator, lines[index], `${headingName} must contain exactly one text line`));
      index += 1;
    }
  }
  const firstBodyPosition = locator.range(lines[closingIndex].end + 1, lines[closingIndex].end + 1);
  if (!Object.hasOwn(data, "title")) insertionPoints.set("/title", firstBodyPosition);
  for (let bodyIndex = 0; bodyIndex < BODY_ORDER.length; bodyIndex += 1) {
    const [field] = BODY_ORDER[bodyIndex];
    if (Object.hasOwn(data, field)) continue;
    const nextField = BODY_ORDER.slice(bodyIndex + 1).map(([candidate]) => candidate).find((candidate) => sectionHeadings.has(candidate));
    insertionPoints.set(`/${field}`, nextField ? { start: sectionHeadings.get(nextField).start, end: sectionHeadings.get(nextField).start } : locator.range(text.length, text.length));
  }
  return {
    ok: diagnostics.length === 0,
    file,
    locator,
    diagnostics,
    locations,
    keyLocations,
    insertionPoints,
    data,
    profile: "markdown",
    sourceText: text,
    frontKeys,
  };
}

export function stringifyCanonicalMarkdown(data) {
  const front = {};
  for (const key of ["format", "id", "kind", "owner", "lifecycle", "modality", "scope", "relations"]) {
    if (Object.hasOwn(data, key)) front[key] = data[key];
  }
  let output = `---\n${stringifyCanonicalYaml(front, { frontmatter: true }).trimEnd()}\n---`;
  if (Object.hasOwn(data, "title")) output += `\n# ${data.title}`;
  for (const [field, heading] of BODY_ORDER) {
    if (Object.hasOwn(data, field)) output += `\n\n## ${heading}\n\n${String(data[field])}`;
  }
  return `${output}\n`;
}
