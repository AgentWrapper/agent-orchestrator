import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFilesView } from "./SessionFilesView";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

function renderWithQuery(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

// A diff line's content lives in a span with a `whitespace-pre*` class. Intra-line
// word highlighting splits that span into child spans, so match on the wrapper's
// full text content rather than a single text node.
function diffLine(text: string) {
	return (_content: string, element: Element | null): boolean =>
		element != null && /whitespace-pre/.test(element.className) && element.textContent === text;
}

describe("SessionFilesView", () => {
	beforeEach(() => {
		getMock.mockReset();
		getMock.mockImplementation(async (path: string, options?: unknown) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [
							{
								path: "src/App.tsx",
								status: "modified",
								additions: 2,
								deletions: 1,
								size: 120,
								binary: false,
							},
							{
								path: "README.md",
								status: "unmodified",
								additions: 0,
								deletions: 0,
								size: 80,
								binary: false,
							},
							{
								path: "docs/guide.md",
								status: "added",
								additions: 3,
								deletions: 0,
								size: 90,
								binary: false,
							},
						],
					},
				};
			}
			if (path === "/api/v1/sessions/{sessionId}/workspace/file") {
				const query = options as { params?: { query?: { path?: string } } };
				return {
					data: {
						sessionId: "sess-1",
						path: query.params?.query?.path ?? "src/App.tsx",
						status: "modified",
						additions: 2,
						deletions: 1,
						size: 120,
						binary: false,
						deleted: false,
						content: "const value = 1;\n",
						contentTruncated: false,
						diff: "@@\n-const value = 0;\n+const value = 1;\n",
						diffTruncated: false,
					},
				};
			}
			return { data: undefined };
		});
	});

	it("loads the workspace files and requests detail for the selected file", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

		await screen.findByRole("button", { name: "Collapse src/App.tsx" });
		expect(screen.getByText("2 files")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /README\.md/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download src/App.tsx" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy path for src/App.tsx" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Diff layout" })).not.toBeInTheDocument();
		expect(screen.queryByText("Stacked")).not.toBeInTheDocument();

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "src/App.tsx" } },
			}),
		);
		expect(await screen.findByText(diffLine("const value = 1;"))).toBeInTheDocument();
	});

	it("filters and expands a changed file from the review list", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

		await userEvent.click(await screen.findByRole("button", { name: "Search files" }));
		await userEvent.type(await screen.findByPlaceholderText("Search changed files"), "guide");
		expect(screen.queryByRole("button", { name: /src\/App\.tsx/ })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Expand docs/guide.md" }));

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "docs/guide.md" } },
			}),
		);
	});

	it("uses the terminal foreground color for diff content", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

		await screen.findByRole("button", { name: "Collapse src/App.tsx" });

		const codePane = (await screen.findByText(diffLine("const value = 1;"))).closest(".session-files-diff-scrollbar");
		expect(codePane).toHaveClass("text-terminal-foreground");
		expect(codePane).toHaveClass("session-files-diff-scrollbar");
		expect(codePane).not.toHaveClass("text-terminal");
	});

	it("renders a real diff without git-header noise and with markers in the gutter", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [{ path: "src/App.tsx", status: "modified", additions: 1, deletions: 1, size: 120, binary: false }],
					},
				};
			}
			return {
				data: {
					sessionId: "sess-1",
					path: "src/App.tsx",
					status: "modified",
					additions: 1,
					deletions: 1,
					size: 120,
					binary: false,
					deleted: false,
					content: "",
					contentTruncated: false,
					// CRLF endings on purpose: the parser must normalize them on every OS.
					diff: "diff --git a/src/App.tsx b/src/App.tsx\r\nindex 111..222 100644\r\n--- a/src/App.tsx\r\n+++ b/src/App.tsx\r\n@@ -1,2 +1,2 @@\r\n context line\r\n-old line\r\n+new line\r\n",
					diffTruncated: false,
				},
			};
		});

		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);
		await screen.findByRole("button", { name: "Collapse src/App.tsx" });

		// Content renders without the leading +/- marker (it lives in the gutter).
		expect(await screen.findByText(diffLine("new line"))).toBeInTheDocument();
		expect(screen.getByText(diffLine("old line"))).toBeInTheDocument();
		expect(screen.getByText("context line")).toBeInTheDocument();
		// Hunk header stays; git file-header lines are hidden.
		expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
		expect(screen.queryByText("diff --git a/src/App.tsx b/src/App.tsx")).not.toBeInTheDocument();
		expect(screen.queryByText("index 111..222 100644")).not.toBeInTheDocument();
		expect(screen.queryByText("+++ b/src/App.tsx")).not.toBeInTheDocument();
		expect(screen.queryByText("+new line")).not.toBeInTheDocument();
		expect(screen.queryByText("-old line")).not.toBeInTheDocument();
	});

	it("wraps long diff lines by default without a toggle", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

		expect(await screen.findByText(diffLine("const value = 1;"))).toHaveClass("whitespace-pre-wrap");
		expect(screen.queryByRole("button", { name: "Wrap long lines" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Disable line wrapping" })).not.toBeInTheDocument();
	});

	it("highlights only the changed tokens within a replaced line", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [{ path: "src/App.tsx", status: "modified", additions: 1, deletions: 1, size: 120, binary: false }],
					},
				};
			}
			return {
				data: {
					sessionId: "sess-1",
					path: "src/App.tsx",
					status: "modified",
					additions: 1,
					deletions: 1,
					size: 120,
					binary: false,
					deleted: false,
					content: "",
					contentTruncated: false,
					diff: "@@ -1,1 +1,1 @@\n-const value = 0;\n+const value = 1;\n",
					diffTruncated: false,
				},
			};
		});

		const { container } = renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);
		await screen.findByText(diffLine("const value = 1;"));

		// Only the differing token is highlighted on each side, not the whole line.
		expect(container.querySelector('[class*="bg-success/35"]')?.textContent).toBe("1");
		expect(container.querySelector('[class*="bg-error/35"]')?.textContent).toBe("0");
	});

	it("switches between unified and side-by-side split diff", async () => {
		const { container } = renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);
		await screen.findByText(diffLine("const value = 1;"));
		expect(container.querySelector(".grid-cols-2")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Split diff view" }));
		expect(container.querySelector(".grid-cols-2")).not.toBeNull();
		// Old on the left, new on the right — both still rendered.
		expect(screen.getByText(diffLine("const value = 0;"))).toBeInTheDocument();
		expect(screen.getByText(diffLine("const value = 1;"))).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Unified diff view" }));
		expect(container.querySelector(".grid-cols-2")).toBeNull();
	});

	it("moves focus between file rows with j and k", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);
		const first = await screen.findByRole("button", { name: "Collapse src/App.tsx" });
		const second = screen.getByRole("button", { name: "Expand docs/guide.md" });

		first.focus();
		await userEvent.keyboard("j");
		expect(second).toHaveFocus();

		await userEvent.keyboard("k");
		expect(first).toHaveFocus();
	});

	it("renders changed files as one integrated review list instead of boxed cards", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

		const activeRowButton = await screen.findByRole("button", { name: "Collapse src/App.tsx" });
		const list = screen.getByRole("list");
		const row = activeRowButton.closest("article");

		expect(list).toHaveClass("session-files-review-list");
		expect(row).toHaveClass("session-files-review-row");
		expect(row).not.toHaveClass("border");
		expect(row).not.toHaveClass("bg-surface");
		expect(row).not.toHaveClass("shadow-sm");
	});

	it("lets the caller toggle between rail and maximized layouts", async () => {
		const onToggleMaximized = vi.fn();
		renderWithQuery(<SessionFilesView onClose={vi.fn()} onToggleMaximized={onToggleMaximized} sessionId="sess-1" />);

		await userEvent.click(await screen.findByRole("button", { name: "Maximize files" }));
		expect(onToggleMaximized).toHaveBeenCalledWith(true);
	});

	it("shows a minimize action while maximized", async () => {
		const onToggleMaximized = vi.fn();
		renderWithQuery(
			<SessionFilesView isMaximized onClose={vi.fn()} onToggleMaximized={onToggleMaximized} sessionId="sess-1" />,
		);

		await userEvent.click(await screen.findByRole("button", { name: "Minimize files" }));
		expect(onToggleMaximized).toHaveBeenCalledWith(false);
	});
});
