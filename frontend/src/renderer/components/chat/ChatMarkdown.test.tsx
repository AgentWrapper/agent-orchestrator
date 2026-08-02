import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

// The point of these is that the SYNTAX stops being visible. Every case here is a
// shape agents actually emit, and the assertion is that structure replaced markup.

describe("ChatMarkdown", () => {
	it("renders headings as headings rather than literal hashes", () => {
		render(<ChatMarkdown text={"## Findings\n\nTwo files changed."} />);
		expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
		expect(screen.queryByText(/## Findings/)).not.toBeInTheDocument();
	});

	it("renders bullet and numbered lists as lists", () => {
		render(<ChatMarkdown text={"- first\n- second\n\n1. one\n2. two"} />);
		const lists = screen.getAllByRole("list");
		expect(lists).toHaveLength(2);
		expect(screen.getAllByRole("listitem")).toHaveLength(4);
	});

	it("renders a task list with read-only checkboxes reflecting the agent's state", () => {
		render(<ChatMarkdown text={"- [x] done thing\n- [ ] pending thing"} />);
		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes).toHaveLength(2);
		expect(boxes[0]!.checked).toBe(true);
		expect(boxes[1]!.checked).toBe(false);
		// Clicking must not imply AO can rewrite the agent's plan.
		expect(boxes[0]!.readOnly).toBe(true);
	});

	it("renders a GFM table, in a container that scrolls instead of widening the column", () => {
		render(<ChatMarkdown text={"| file | lines |\n| --- | --- |\n| a.ts | 12 |"} />);
		const table = screen.getByRole("table");
		expect(table).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "file" })).toBeInTheDocument();
		expect(screen.getByRole("cell", { name: "a.ts" })).toBeInTheDocument();
		const scroller = table.closest("div");
		expect(scroller?.className).toContain("overflow-x-auto");
	});

	it("renders a fenced code block with its language and a copy control, and no stray backticks", () => {
		render(<ChatMarkdown text={"```go\nfunc main() {}\n```"} />);
		expect(screen.getByText("go")).toBeInTheDocument();
		expect(screen.getByText("func main() {}")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /copy code/i })).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("```");
	});

	it("keeps inline code inline rather than promoting it to a block", () => {
		render(<ChatMarkdown text={"run `go test ./...` first"} />);
		const code = screen.getByText("go test ./...");
		expect(code.tagName).toBe("CODE");
		expect(code.closest("pre")).toBeNull();
	});

	it("escapes raw HTML instead of rendering it", () => {
		// Agent output is only as trustworthy as the files it just read, so an
		// <img onerror> in a README must never become a live element.
		render(<ChatMarkdown text={'before <img src=x onerror="alert(1)"> after'} />);
		expect(document.querySelector("img")).toBeNull();
		expect(document.body.textContent).toContain("onerror");
	});

	it("marks external links to open outside the app", () => {
		render(<ChatMarkdown text={"see [the issue](https://example.com/i/1)"} />);
		const link = screen.getByRole("link", { name: "the issue" });
		expect(link).toHaveAttribute("href", "https://example.com/i/1");
		expect(link).toHaveAttribute("target", "_blank");
		// Without noreferrer the opened page gets a handle on the renderer.
		expect(link.getAttribute("rel")).toContain("noreferrer");
	});

	it("renders bold, strikethrough and blockquotes", () => {
		render(<ChatMarkdown text={"**bold** and ~~gone~~\n\n> quoted"} />);
		expect(screen.getByText("bold").tagName).toBe("STRONG");
		expect(screen.getByText("gone").tagName).toBe("DEL");
		expect(screen.getByText("quoted").closest("blockquote")).not.toBeNull();
	});

	it("renders an unterminated fence as a code block, because streaming text arrives mid-fence", () => {
		render(<ChatMarkdown text={"```ts\nconst x = 1;"} />);
		expect(screen.getByText("const x = 1;")).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("```");
	});
});
