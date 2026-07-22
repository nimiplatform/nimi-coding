import YAML from "yaml";

export function parseYamlText(text) {
  if (!text) return null;
  try {
    return YAML.parse(text);
  } catch {
    return null;
  }
}
