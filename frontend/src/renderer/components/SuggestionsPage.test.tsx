import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUGGESTION_DISCUSSION_ISSUE_PREFIX } from "../types/workspace";
import { buildSuggestionDiscussionPrompt } from "./SuggestionDiscussionPanel";
import { SuggestionsPage } from "./SuggestionsPage";

const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
		PATCH: (...args: unknown[]) => patchMock(...args),
	},
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const backlog = {
	id: "sg_1",
	projectId: "mer",
	title: "Explore a shared cache",
	note: "Useful after the release.",
	priority: "important",
	status: "backlog",
	createdAt: "2026-07-14T12:00:00Z",
	updatedAt: "2026-07-14T12:00:00Z",
} as const;

function renderPage(onSessionStarted = vi.fn()) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return {
		...render(
			<QueryClientProvider client={queryClient}>
				<SuggestionsPage projectId="mer" onSessionStarted={onSessionStarted} />
			</QueryClientProvider>,
		),
		onSessionStarted,
	};
}

describe("SuggestionsPage", () => {
	beforeEach(() => {
		window.localStorage.clear();
		getMock.mockReset();
		postMock.mockReset();
		patchMock.mockReset();
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/projects/{projectId}/suggestions") {
				return { data: { suggestions: [backlog] } };
			}
			if (path === "/api/v1/agents") {
				return {
					data: {
						supported: [{ id: "claude-code", label: "Claude Code" }],
						installed: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
						authorized: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
					},
				};
			}
			return {
				data: {
					status: "ok",
					project: { id: "mer", config: { worker: { agent: "claude-code" } } },
				},
			};
		});
		patchMock.mockResolvedValue({ data: { suggestion: backlog } });
	});

	it("shows deferred ideas outside the active task board", async () => {
		renderPage();
		expect(await screen.findByText("Explore a shared cache")).toBeInTheDocument();
		expect(screen.getByText("Useful after the release.")).toBeInTheDocument();
		expect(screen.getByText("Waiting for free capacity")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start worker" })).toBeInTheDocument();
	});

	it("adds a suggestion with workflow context and priority", async () => {
		postMock.mockResolvedValue({ data: { suggestion: backlog } });
		renderPage();
		await screen.findByText("Explore a shared cache");

		fireEvent.change(screen.getByLabelText("Suggestion title"), { target: { value: "Map future release gates" } });
		fireEvent.change(screen.getByLabelText("Suggestion note"), { target: { value: "Keep it outside current work" } });
		fireEvent.change(screen.getByLabelText("Suggestion priority"), { target: { value: "later" } });
		fireEvent.click(screen.getByRole("button", { name: "Submit suggestion" }));

		await waitFor(() => expect(postMock).toHaveBeenCalled());
		expect(postMock).toHaveBeenCalledWith("/api/v1/projects/{projectId}/suggestions", {
			params: { path: { projectId: "mer" } },
			body: { title: "Map future release gates", note: "Keep it outside current work", priority: "later" },
		});
	});

	it("starts a pre-submit discussion with the selected model, effort, and access", async () => {
		const onSessionStarted = vi.fn();
		postMock.mockResolvedValue({ data: { session: { id: "mer-discuss-1" } } });
		renderPage(onSessionStarted);
		await screen.findByText("Explore a shared cache");

		fireEvent.change(screen.getByLabelText("Suggestion title"), {
			target: { value: "Refine the shared cache idea" },
		});
		fireEvent.change(screen.getByLabelText("Suggestion note"), {
			target: { value: "Work out the constraints before adding it." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Set up discussion" }));

		const model = await screen.findByRole("combobox", { name: "Model" });
		await waitFor(() => expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("Claude Code"));
		fireEvent.change(model, { target: { value: "opus" } });
		fireEvent.change(screen.getByRole("combobox", { name: "Effort" }), { target: { value: "high" } });
		fireEvent.change(screen.getByRole("combobox", { name: "Access" }), { target: { value: "auto" } });
		fireEvent.click(screen.getByRole("button", { name: "Start discussion" }));

		await waitFor(() => expect(onSessionStarted).toHaveBeenCalledWith("mer-discuss-1"));
		const request = postMock.mock.calls[0]?.[1] as { body: Record<string, unknown> };
		expect(postMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions");
		expect(request.body).toMatchObject({
			projectId: "mer",
			kind: "worker",
			harness: undefined,
			issueId: `${SUGGESTION_DISCUSSION_ISSUE_PREFIX}Refine the shared cache idea`,
			displayName: "Discuss suggestion",
			agentConfig: { model: "opus", reasoningEffort: "high", permissions: "auto" },
		});
		expect(request.body.prompt).toContain("This is a discussion-only session");
		expect(request.body.prompt).toContain("Work out the constraints before adding it.");
		expect(window.localStorage.getItem("ao.suggestion-draft.v1.mer")).toContain("mer-discuss-1");
	});

	it("keeps the discussion prompt read-only and within the daemon byte limit", () => {
		const prompt = buildSuggestionDiscussionPrompt("Unicode draft", "界".repeat(4000));
		expect(prompt).toContain("Do not edit files");
		expect(prompt).toContain("Preserve the user's intent");
		expect(prompt).toContain("Draft note truncated");
		expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(4096);
	});

	it("starts a dedicated worker and opens its task", async () => {
		const onSessionStarted = vi.fn();
		postMock.mockResolvedValue({ data: { suggestion: { ...backlog, status: "in_progress" }, sessionId: "mer-7" } });
		renderPage(onSessionStarted);
		await screen.findByText("Explore a shared cache");

		fireEvent.click(screen.getByRole("button", { name: "Start worker" }));
		await waitFor(() => expect(onSessionStarted).toHaveBeenCalledWith("mer-7"));
		expect(postMock).toHaveBeenCalledWith("/api/v1/projects/{projectId}/suggestions/{suggestionId}/start", {
			params: { path: { projectId: "mer", suggestionId: "sg_1" } },
		});
	});
});
