import path from "node:path";

export function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

export function portablePath(filePath, cwd = process.cwd()) {
  const relative = path.relative(cwd, filePath);
  const value = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
  return value.split(path.sep).join(path.posix.sep);
}

export function createLocator(text) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  function position(offset) {
    const bounded = Math.max(0, Math.min(offset, text.length));
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= bounded) low = middle;
      else high = middle;
    }
    return {
      line: low + 1,
      column: [...text.slice(lineStarts[low], bounded)].length + 1,
    };
  }
  return {
    range(start, end = start) {
      return { start: position(start), end: position(end) };
    },
  };
}

export function makeDiagnostic({ code, file, range, pointer = "", reason, repair, related = [] }) {
  return {
    code,
    severity: "error",
    path: file,
    range,
    pointer,
    reason,
    repair,
    related,
  };
}

function comparePosition(left, right) {
  return left.line - right.line || left.column - right.column;
}

export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) => (
    compareText(left.path, right.path)
    || comparePosition(left.range.start, right.range.start)
    || compareText(left.code, right.code)
    || compareText(left.pointer, right.pointer)
  ));
}

export function sourcePointer(source, pointer) {
  return `${source.sourcePrefix ?? ""}${pointer}`;
}

export function relatedLocation(source, pointer, role) {
  return {
    path: source.file,
    range: source.locations.get(pointer) ?? source.locations.get("") ?? source.locator.range(0),
    pointer: sourcePointer(source, pointer),
    role,
  };
}

export const REPAIRS = {
  structural: "make the source structure explicit without inventing product semantics",
  required: "declare the required value from product authority",
  invalid: "replace the value with one admitted by the authoring contract",
  relation: "repair the explicit relation using product authority; do not infer a target",
  duplicate: "keep one declaration chosen from product authority and remove the duplicate",
  format: "run `nimicoding authority fmt` on this file",
};
