import { describe, it, expect } from "vitest";
import { adfToPlainText, plainTextToAdf } from "../adf.js";
import type { AdfNode } from "../types.js";

// ---------------------------------------------------------------------------
// adfToPlainText
// ---------------------------------------------------------------------------

describe("adfToPlainText", () => {
  it("returns empty string for null input", () => {
    expect(adfToPlainText(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(adfToPlainText(undefined)).toBe("");
  });

  it("converts a simple paragraph", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello, world!" }],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Hello, world!");
  });

  it("converts multiple paragraphs separated by double newlines", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph." }],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("converts heading levels", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Subtitle" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Section" }],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("# Title\n\n## Subtitle\n\n### Section");
  });

  it("handles bold, italic, and code marks", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            { type: "text", text: " " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("**bold** *italic* `code`");
  });

  it("handles strong and em marks", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "strong", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "emphasis", marks: [{ type: "em" }] },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("**strong** *emphasis*");
  });

  it("handles link marks", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Click here",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Click here (https://example.com)");
  });

  it("converts bullet lists", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Item A" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Item B" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Item C" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("- Item A\n- Item B\n- Item C");
  });

  it("converts ordered lists", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
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
    expect(adfToPlainText(adf)).toBe("1. First\n2. Second");
  });

  it("converts code blocks", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: 'const x = 42;\nconsole.log(x);' }],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("```\nconst x = 42;\nconsole.log(x);\n```");
  });

  it("converts blockquotes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Quoted text" }],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("> Quoted text");
  });

  it("handles hardBreak nodes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
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
    expect(adfToPlainText(adf)).toBe("Line 1\nLine 2");
  });

  it("handles rule nodes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Above" }] },
        { type: "rule" },
        { type: "paragraph", content: [{ type: "text", text: "Below" }] },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Above\n\n---\n\nBelow");
  });

  it("handles mention nodes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hey " },
            { type: "mention", attrs: { text: "John Doe", id: "abc123" } },
            { type: "text", text: ", please review" },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Hey @John Doe, please review");
  });

  it("handles mention node without text attr", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "abc123" } }],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("@unknown");
  });

  it("handles emoji nodes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Great " },
            { type: "emoji", attrs: { shortName: ":thumbsup:" } },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Great :thumbsup:");
  });

  it("handles media nodes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "mediaSingle",
          content: [
            { type: "media", attrs: { type: "file", id: "abc" } },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("[media]");
  });

  it("handles table nodes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Name" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("[table]");
  });

  it("handles unknown node types with content", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "unknownBlock",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Fallback content" }] },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe("Fallback content");
  });

  it("handles unknown node types without content", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        { type: "unknownEmptyNode" },
      ],
    };
    expect(adfToPlainText(adf)).toBe("");
  });

  it("handles nested content (heading + bullet list + code block)", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Steps" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Step one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Step two" }] },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "npm install" }],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe(
      "## Steps\n\n- Step one\n- Step two\n\n```\nnpm install\n```",
    );
  });

  it("converts a complex real-world ADF document", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Bug Report" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "When clicking the " },
            { type: "text", text: "Submit", marks: [{ type: "bold" }] },
            { type: "text", text: " button, the form " },
            { type: "text", text: "silently fails", marks: [{ type: "italic" }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Steps to Reproduce" }],
        },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Open the form" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Fill in all fields" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Click " },
                    { type: "text", text: "Submit", marks: [{ type: "code" }] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Error Log" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "javascript" },
          content: [{ type: "text", text: "TypeError: Cannot read property 'id' of null" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "CC " },
            { type: "mention", attrs: { text: "Alice", id: "user1" } },
            { type: "text", text: " " },
            { type: "emoji", attrs: { shortName: ":warning:" } },
          ],
        },
      ],
    };

    const expected = [
      "# Bug Report",
      "",
      "When clicking the **Submit** button, the form *silently fails*.",
      "",
      "## Steps to Reproduce",
      "",
      "1. Open the form",
      "2. Fill in all fields",
      "3. Click `Submit`",
      "",
      "## Error Log",
      "",
      "```",
      "TypeError: Cannot read property 'id' of null",
      "```",
      "",
      "CC @Alice :warning:",
    ].join("\n");

    expect(adfToPlainText(adf)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// plainTextToAdf
// ---------------------------------------------------------------------------

describe("plainTextToAdf", () => {
  it("converts empty text to doc with empty paragraph", () => {
    const result = plainTextToAdf("");
    expect(result).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "" }],
        },
      ],
    });
  });

  it("converts whitespace-only text to doc with empty paragraph", () => {
    const result = plainTextToAdf("   ");
    expect(result).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "" }],
        },
      ],
    });
  });

  it("converts single paragraph text", () => {
    const result = plainTextToAdf("Hello, world!");
    expect(result).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello, world!" }],
        },
      ],
    });
  });

  it("splits on double newlines into paragraphs", () => {
    const result = plainTextToAdf("First paragraph.\n\nSecond paragraph.");
    expect(result).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph." }],
        },
      ],
    });
  });

  it("handles triple+ newlines (collapses to paragraph break)", () => {
    const result = plainTextToAdf("A\n\n\n\nB");
    expect(result.content).toHaveLength(2);
    expect(result.content![0].content![0].text).toBe("A");
    expect(result.content![1].content![0].text).toBe("B");
  });

  it("round-trips simple text through adfToPlainText", () => {
    const text = "Hello world.\n\nSecond paragraph.";
    const adf = plainTextToAdf(text);
    const back = adfToPlainText(adf);
    expect(back).toBe(text);
  });

  it("preserves single newlines within paragraphs", () => {
    const text = "Line one\nLine two";
    const adf = plainTextToAdf(text);
    expect(adf.content).toHaveLength(1);
    expect(adf.content![0].content![0].text).toBe("Line one\nLine two");
  });
});
