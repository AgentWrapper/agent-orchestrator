/**
 * ADF (Atlassian Document Format) <-> plain text converter.
 *
 * Handles conversion between Jira's rich-text ADF format and plain text
 * for use in issue descriptions and comments.
 */

import type { AdfNode } from "./types.js";

// ---------------------------------------------------------------------------
// ADF -> Plain Text
// ---------------------------------------------------------------------------

/**
 * Convert an ADF document node to plain text.
 * Recursively traverses the ADF tree and produces a Markdown-like representation.
 */
export function adfToPlainText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  return renderNode(node).trim();
}

function renderNode(node: AdfNode): string {
  switch (node.type) {
    case "doc":
      return renderChildren(node, "\n\n");

    case "paragraph":
      return renderChildren(node, "");

    case "heading": {
      const level = (node.attrs?.["level"] as number) ?? 1;
      const prefix = "#".repeat(level) + " ";
      return prefix + renderChildren(node, "");
    }

    case "text":
      return renderTextNode(node);

    case "bulletList":
      return renderListItems(node, "bullet");

    case "orderedList":
      return renderListItems(node, "ordered");

    case "listItem":
      return renderChildren(node, "\n");

    case "codeBlock": {
      const code = renderChildren(node, "");
      return "```\n" + code + "\n```";
    }

    case "blockquote": {
      const inner = renderChildren(node, "\n\n");
      return inner
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    }

    case "hardBreak":
      return "\n";

    case "rule":
      return "---";

    case "mention": {
      const mentionText = (node.attrs?.["text"] as string) ?? "unknown";
      return "@" + mentionText;
    }

    case "emoji":
      return (node.attrs?.["shortName"] as string) ?? "";

    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[media]";

    case "table":
      return "[table]";

    case "tableRow":
      return renderChildren(node, " | ");

    case "tableHeader":
    case "tableCell":
      return renderChildren(node, "");

    default:
      // Unknown node types: recurse into content if present
      if (node.content && node.content.length > 0) {
        return renderChildren(node, "");
      }
      return "";
  }
}

function renderChildren(node: AdfNode, separator: string): string {
  if (!node.content || node.content.length === 0) return "";
  return node.content.map(renderNode).join(separator);
}

function renderTextNode(node: AdfNode): string {
  let text = node.text ?? "";
  if (!node.marks || node.marks.length === 0) return text;

  for (const mark of node.marks) {
    switch (mark.type) {
      case "bold":
      case "strong":
        text = `**${text}**`;
        break;
      case "italic":
      case "em":
        text = `*${text}*`;
        break;
      case "code":
        text = "`" + text + "`";
        break;
      case "link": {
        const href = mark.attrs?.["href"] as string | undefined;
        if (href) {
          text = `${text} (${href})`;
        }
        break;
      }
    }
  }
  return text;
}

function renderListItems(node: AdfNode, style: "bullet" | "ordered"): string {
  if (!node.content) return "";
  return node.content
    .map((item, index) => {
      const prefix = style === "bullet" ? "- " : `${index + 1}. `;
      const content = renderNode(item);
      return prefix + content;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Plain Text -> ADF
// ---------------------------------------------------------------------------

/**
 * Convert plain text to a minimal ADF document.
 * Splits on double newlines to create paragraphs.
 */
export function plainTextToAdf(text: string): AdfNode {
  if (!text || text.trim() === "") {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "" }],
        },
      ],
    };
  }

  const paragraphs = text.split(/\n\n+/);
  const content: AdfNode[] = paragraphs.map((para) => ({
    type: "paragraph",
    content: [{ type: "text", text: para }],
  }));

  return {
    type: "doc",
    version: 1,
    content,
  };
}
