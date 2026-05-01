import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import kotlin from "highlight.js/lib/languages/kotlin";
import groovy from "highlight.js/lib/languages/groovy";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("groovy", groovy);

const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".py": "python",
  ".json": "json",
  ".css": "css",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".svg": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".md": "markdown",
  ".rs": "rust",
  ".go": "go",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".gradle": "groovy",
};

export function languageForFilePath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return EXT_TO_LANG[ext];
}

export function highlightFileContentByLines(content: string, languageId: string): string[] | null {
  if (!hljs.getLanguage(languageId)) return null;
  try {
    const result = hljs.highlight(content, { language: languageId });
    return result.value.split("\n");
  } catch {
    return null;
  }
}

export function highlightDiffLine(line: string, languageId: string): string | null {
  if (!hljs.getLanguage(languageId)) return null;
  try {
    return hljs.highlight(line, { language: languageId, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
