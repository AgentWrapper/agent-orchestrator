import { describe, it, expect } from "vitest";
import { adfToMarkdown, type AdfNode } from "../jira-client.js";

describe("adfToMarkdown", () => {
  it("returns empty string for null", () => {
    expect(adfToMarkdown(null)).toBe("");
  });

  it("converts a simple paragraph", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("Hello world");
  });

  it("converts headings", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Section" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("## Section");
  });

  it("converts bold and italic marks", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "em" }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("**bold** and *italic*");
  });

  it("converts code blocks", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("```typescript\nconst x = 1;\n```");
  });

  it("converts bullet lists", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item 1" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item 2" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = adfToMarkdown(doc);
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });

  it("converts inline code", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            { type: "text", text: "fetch()", marks: [{ type: "code" }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("Use `fetch()`");
  });

  it("converts hard breaks", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Line 1" },
            { type: "hardBreak" },
            { type: "text", text: "Line 2" },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("Line 1\nLine 2");
  });

  it("converts horizontal rules", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "rule" },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("---");
  });

  it("handles unknown node types gracefully", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "unknownType",
          content: [{ type: "text", text: "fallback" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("fallback");
  });

  it("converts ordered lists with numeric prefixes", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "First" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Second" }] },
              ],
            },
          ],
        },
      ],
    };
    const result = adfToMarkdown(doc);
    expect(result).toContain("1. First");
    expect(result).toContain("2. Second");
  });

  it("respects the `order` attr for ordered list start index", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { order: 5 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Five" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Six" }] },
              ],
            },
          ],
        },
      ],
    };
    const result = adfToMarkdown(doc);
    expect(result).toContain("5. Five");
    expect(result).toContain("6. Six");
  });

  it("converts strikethrough", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "removed", marks: [{ type: "strike" }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("~~removed~~");
  });
});
