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
		expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
		expect(screen.getByText("2 files changed")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /README\.md/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download src/App.tsx" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Copy path for src/App.tsx" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Diff layout" })).not.toBeInTheDocument();
		expect(screen.queryByText("Stacked")).not.toBeInTheDocument();

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "src/App.tsx" } },
			}),
		);
		expect(await screen.findByText("+const value = 1;")).toBeInTheDocument();
	});

	it("filters and expands a changed file from the review list", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

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

		const codePane = (await screen.findByText("+const value = 1;")).closest("pre");
		expect(codePane).toHaveClass("text-terminal-foreground");
		expect(codePane).toHaveClass("session-files-diff-scrollbar");
		expect(codePane).not.toHaveClass("text-terminal");
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
