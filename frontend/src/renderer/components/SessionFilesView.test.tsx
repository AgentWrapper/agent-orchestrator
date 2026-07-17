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

		await screen.findByRole("button", { name: /src\/App\.tsx/ });
		expect(screen.getByText("1 changed")).toBeInTheDocument();

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "src/App.tsx" } },
			}),
		);
		expect(await screen.findByText("+const value = 1;")).toBeInTheDocument();
	});

	it("filters and opens a file from the list", async () => {
		renderWithQuery(<SessionFilesView onClose={vi.fn()} sessionId="sess-1" />);

		await userEvent.type(await screen.findByPlaceholderText("Search files"), "readme");
		expect(screen.queryByRole("button", { name: /src\/App\.tsx/ })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /README\.md/ }));

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "README.md" } },
			}),
		);
	});
});
