import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@aoagents/ao-core";
import { ArtifactMarkdown } from "../ArtifactMarkdown";

function markdownArtifact(markdown: string, overrides: Partial<Artifact> = {}): Extract<
  Artifact,
  { type: "markdown" }
> {
  return {
    version: 1,
    type: "markdown",
    id: "test",
    title: "Test card",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    source: "agent",
    ...overrides,
    payload: { markdown },
  } as Extract<Artifact, { type: "markdown" }>;
}

describe("ArtifactMarkdown", () => {
  it("renders the title and source badge in the card header", () => {
    const { container } = render(
      <ArtifactMarkdown artifact={markdownArtifact("Body", { title: "Hello", source: "my-agent" })} />,
    );

    expect(container.querySelector(".artifact-card-title")?.textContent).toBe("Hello");
    expect(container.querySelector(".artifact-card-source")?.textContent).toBe("my-agent");
  });

  it("falls back to 'agent' when no source is set", () => {
    const artifact = markdownArtifact("Body");
    // Remove source explicitly.
    const noSource = { ...artifact, source: undefined };
    const { container } = render(<ArtifactMarkdown artifact={noSource} />);
    expect(container.querySelector(".artifact-card-source")?.textContent).toBe("agent");
  });

  it("renders headings, bold, italic, code, and lists", () => {
    const md = [
      "# Heading 1",
      "## Heading 2",
      "",
      "**bold** and *italic* and `inline-code`",
      "",
      "- one",
      "- two",
      "- three",
    ].join("\n");

    const { container } = render(<ArtifactMarkdown artifact={markdownArtifact(md)} />);
    const body = container.querySelector(".artifact-card-body");
    expect(body).not.toBeNull();
    expect(body?.querySelector("h1")?.textContent).toBe("Heading 1");
    expect(body?.querySelector("h2")?.textContent).toBe("Heading 2");
    expect(body?.querySelector("strong")?.textContent).toBe("bold");
    expect(body?.querySelector("em")?.textContent).toBe("italic");
    expect(body?.querySelector("code")?.textContent).toBe("inline-code");
    expect(body?.querySelectorAll("ul li").length).toBe(3);
  });

  it("renders fenced code blocks with a language class", () => {
    const md = "```ts\nconst x: number = 1;\n```";
    const { container } = render(<ArtifactMarkdown artifact={markdownArtifact(md)} />);
    const codeEl = container.querySelector(".artifact-card-body pre code");
    expect(codeEl).not.toBeNull();
    expect(codeEl?.className).toContain("language-ts");
    expect(codeEl?.textContent).toContain("const x: number = 1;");
  });

  it("does not pass raw HTML through — <script> is escaped to text", () => {
    const md = "Hi\n\n<script>alert(1)</script>\n\nAfter";
    const { container } = render(<ArtifactMarkdown artifact={markdownArtifact(md)} />);
    // No script element was created in the rendered tree.
    expect(container.querySelector("script")).toBeNull();
    // The literal text appears in the rendered body.
    const body = container.querySelector(".artifact-card-body");
    expect(body?.textContent).toContain("<script>alert(1)</script>");
  });

  it("escapes inline HTML tags like <b> and <img onerror=...>", () => {
    const md = "Some <b>bold</b> and <img src=x onerror=alert(1)>";
    const { container } = render(<ArtifactMarkdown artifact={markdownArtifact(md)} />);
    // No <img> got into the DOM.
    expect(container.querySelector("img")).toBeNull();
    // No <b> got into the DOM either (it was escaped as text).
    expect(container.querySelector(".artifact-card-body b")).toBeNull();
    expect(container.querySelector(".artifact-card-body")?.textContent).toContain("<b>bold</b>");
    expect(container.querySelector(".artifact-card-body")?.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
  });
});
