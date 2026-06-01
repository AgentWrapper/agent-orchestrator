import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { CanvasArtifact } from "@aoagents/ao-core";
import { CanvasMarkdown } from "../CanvasMarkdown";

function md(markdown: string): Extract<CanvasArtifact, { type: "markdown" }> {
  return {
    version: 1,
    id: "test",
    type: "markdown",
    title: "Test",
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
    payload: { markdown },
  };
}

describe("CanvasMarkdown safe-link rendering", () => {
  it("renders [text](https://...) as an anchor with safety attrs", () => {
    render(<CanvasMarkdown canvas={md("See [the docs](https://example.com/x) for details.")} />);
    const a = screen.getByRole("link", { name: "the docs" });
    expect(a).toHaveAttribute("href", "https://example.com/x");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  it("renders relative URLs starting with / as anchors", () => {
    render(<CanvasMarkdown canvas={md("Go [home](/dashboard).")} />);
    expect(screen.getByRole("link", { name: "home" })).toHaveAttribute("href", "/dashboard");
  });

  it("rejects javascript: scheme — link text renders as plain text only", () => {
    render(<CanvasMarkdown canvas={md("Click [me](javascript:alert(1)) now.")} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/me/)).toBeInTheDocument();
  });

  it("rejects data: scheme", () => {
    render(<CanvasMarkdown canvas={md("Image [bad](data:text/html,<script>alert(1)</script>).")} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("rejects vbscript: and file: schemes", () => {
    render(<CanvasMarkdown canvas={md("[a](vbscript:foo) [b](file:///etc/passwd)")} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("rejects protocol-relative URLs (//attacker.com) — greptile P1", () => {
    // raw.startsWith("/") would otherwise admit //attacker.com which the
    // browser resolves to https://attacker.com — NOT same-origin.
    render(<CanvasMarkdown canvas={md("Visit [their site](//attacker.com) now.")} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/their site/)).toBeInTheDocument();
  });

  it("still accepts genuine same-origin paths starting with single slash", () => {
    render(<CanvasMarkdown canvas={md("Open [the rail](/projects/foo/sessions/ao-1).")} />);
    const a = screen.getByRole("link", { name: "the rail" });
    expect(a).toHaveAttribute("href", "/projects/foo/sessions/ao-1");
  });

  it("rejects malformed URLs gracefully", () => {
    render(<CanvasMarkdown canvas={md("[broken](not a real url with spaces)")} />);
    // The regex requires a non-space URL; this case won't even match the link
    // pattern, so [broken] renders as literal text.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/\[broken\]/)).toBeInTheDocument();
  });
});
