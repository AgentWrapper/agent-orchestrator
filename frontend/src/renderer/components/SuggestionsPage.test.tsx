import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUGGESTION_LIVE_DISCUSSION_ISSUE_PREFIX } from "../types/workspace";
import {
	buildDecisionAgentPrompt,
	buildQuickRequestPrompt,
	buildSuggestionDiscussionPrompt,
} from "./SuggestionDiscussionPanel";
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
	getApiBaseUrl: () => "http://127.0.0.1:3001",
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

function renderPage(onSessionStarted = vi.fn(), onOpenProject = vi.fn()) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return {
		...render(
			<QueryClientProvider client={queryClient}>
				<SuggestionsPage
					onOpenProject={onOpenProject}
					onSessionStarted={onSessionStarted}
					projectId="mer"
				/>
			</QueryClientProvider>,
		),
		onOpenProject,
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
			if (path === "/api/v1/sessions") {
				return {
					data: {
						sessions: [
							{
								id: "mer-orchestrator",
								projectId: "mer",
								kind: "orchestrator",
								isTerminated: false,
							},
						],
					},
				};
			}
			if (path === "/api/v1/sessions/{sessionId}/conversation") {
				return { data: { sessionId: "mer-assistant", source: "codex", entries: [] } };
			}
			return {
				data: {
					status: "ok",
					project: { id: "mer", path: "C:\\work\\mer", config: { worker: { agent: "claude-code" } } },
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
		expect(screen.getByRole("region", { name: "Discussion live session" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Quick request session" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Git push status" })).toBeInTheDocument();
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

	it("starts one neutral Assistant and the fixed Sol, Fable, and K3 decision agents", async () => {
		const onSessionStarted = vi.fn();
		let activeSessionCreates = 0;
		let maxConcurrentSessionCreates = 0;
		const sessionIds: Record<string, string> = {
			"Discussion Assistant": "mer-assistant",
			Sol: "mer-sol",
			Fable: "mer-fable",
			K3: "mer-k3",
		};
		postMock.mockImplementation(async (path: string, options: { body?: { displayName?: string } }) => {
			if (path === "/api/v1/sessions") {
				activeSessionCreates += 1;
				maxConcurrentSessionCreates = Math.max(maxConcurrentSessionCreates, activeSessionCreates);
				await Promise.resolve();
				activeSessionCreates -= 1;
				return { data: { session: { id: sessionIds[options.body?.displayName ?? ""] } } };
			}
			return { data: { ok: true } };
		});
		renderPage(onSessionStarted);
		await screen.findByText("Explore a shared cache");

		fireEvent.change(screen.getByLabelText("Suggestion title"), {
			target: { value: "Refine the shared cache idea" },
		});
		fireEvent.change(screen.getByLabelText("Suggestion note"), {
			target: { value: "Work out the constraints before adding it." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Set up live session" }));
		fireEvent.click(screen.getByRole("button", { name: "Start live discussion" }));

		await screen.findByText("Shared live transcript");
		const creates = postMock.mock.calls.filter(([path]) => path === "/api/v1/sessions");
		expect(creates).toHaveLength(4);
		expect(maxConcurrentSessionCreates).toBe(1);
		expect(creates.map(([, request]) => request.body)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					harness: "codex",
					displayName: "Discussion Assistant",
					agentConfig: expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "low" }),
				}),
				expect.objectContaining({
					harness: "codex",
					displayName: "Sol",
					agentConfig: expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }),
				}),
				expect.objectContaining({
					harness: "claude-code",
					displayName: "Fable",
					agentConfig: expect.objectContaining({ model: "fable", reasoningEffort: "max" }),
				}),
				expect.objectContaining({
					harness: "kimi",
					displayName: "K3",
					agentConfig: expect.objectContaining({ model: "k3" }),
				}),
			]),
		);
		for (const [, request] of creates) {
			expect(request.body.issueId).toContain(SUGGESTION_LIVE_DISCUSSION_ISSUE_PREFIX);
			expect(request.body.agentConfig.permissions).toBe("bypass-permissions");
		}
		expect(postMock).toHaveBeenCalledWith(
			"/api/v1/sessions/{sessionId}/send",
			expect.objectContaining({
				params: { path: { sessionId: "mer-assistant" } },
				body: { message: expect.stringContaining("The user is live") },
			}),
		);
		expect(onSessionStarted).not.toHaveBeenCalled();
		expect(window.localStorage.getItem("ao.suggestion-live.v1.mer")).toContain("mer-assistant");
	});

	it("keeps the Assistant neutral and decision prompts read-only and bounded", () => {
		const prompt = buildSuggestionDiscussionPrompt("Unicode draft", "界".repeat(4000));
		expect(prompt).toContain("Do not edit files");
		expect(prompt).toContain("never a decision-maker");
		expect(prompt).toContain("Never summarize context for them");
		expect(prompt).toContain("Context shortened");
		expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(4096);
		const solPrompt = buildDecisionAgentPrompt(
			{ id: "sol", name: "Sol", harness: "codex", model: "gpt-5.6-sol", effort: "xhigh", color: "" },
			"mer-assistant",
		);
		expect(solPrompt).toContain("The Assistant is not");
		expect(solPrompt).toContain("Read the raw conversation yourself");
		expect(solPrompt).toContain("[SOL]");
		const quickPrompt = buildQuickRequestPrompt("C:\\work\\mer", "Check whether git is pushed.");
		expect(quickPrompt).toContain("small operational questions");
		expect(quickPrompt).toContain("Never edit files");
		expect(quickPrompt).toContain("[QUICK_REQUEST] Check whether git is pushed.");
		expect(new TextEncoder().encode(quickPrompt).byteLength).toBeLessThanOrEqual(4096);
	});

	it("starts one lightweight read-only session for the first quick request", async () => {
		postMock.mockImplementation(async (path: string) =>
			path === "/api/v1/sessions"
				? { data: { session: { id: "mer-quick" } } }
				: { data: { ok: true } },
		);
		renderPage();
		await screen.findByText("Explore a shared cache");

		fireEvent.click(screen.getByRole("button", { name: "Git push status" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith(
				"/api/v1/sessions",
				expect.objectContaining({
					body: expect.objectContaining({
						displayName: "Quick request",
						harness: "codex",
						prompt: expect.stringContaining("[QUICK_REQUEST] Check whether the current branch"),
						agentConfig: {
							model: "gpt-5.6-sol",
							reasoningEffort: "low",
							permissions: "auto",
						},
					}),
				}),
			),
		);
		expect(window.localStorage.getItem("ao.quick-request.v1.mer")).toBe("mer-quick");
	});

	it("reuses the lightweight session and opens the project without asking a model", async () => {
		window.localStorage.setItem("ao.quick-request.v1.mer", "mer-quick");
		postMock.mockResolvedValue({ data: { ok: true } });
		const onOpenProject = vi.fn();
		renderPage(vi.fn(), onOpenProject);
		await screen.findByText("Explore a shared cache");

		fireEvent.click(screen.getByRole("button", { name: "Agent status" }));
		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: "mer-quick" } },
				body: { message: "[QUICK_REQUEST] Check the current AO agent and session status for this project." },
			}),
		);

		postMock.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Open project" }));
		expect(onOpenProject).toHaveBeenCalledOnce();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("routes a live user message only through the neutral Assistant", async () => {
		window.localStorage.setItem(
			"ao.suggestion-live.v1.mer",
			JSON.stringify({
				id: "live-1",
				title: "Cache policy",
				createdAt: "2026-07-17T12:00:00Z",
				assistantId: "mer-assistant",
				participantIds: { sol: "mer-sol", fable: "mer-fable", k3: "mer-k3" },
			}),
		);
		postMock.mockResolvedValue({ data: { ok: true } });
		renderPage();
		await screen.findByText("Shared live transcript");
		fireEvent.change(screen.getByLabelText("Message live discussion"), {
			target: { value: "Which cache policy is safest?" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send live" }));
		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: "mer-assistant" } },
				body: { message: expect.stringContaining("[USER_LIVE] Which cache policy is safest?") },
			}),
		);
	});

	it("renders participant contributions and the Assistant's recorded result in one live transcript", async () => {
		window.localStorage.setItem(
			"ao.suggestion-live.v1.mer",
			JSON.stringify({
				id: "live-1",
				title: "Cache policy",
				createdAt: "2026-07-17T12:00:00Z",
				assistantId: "mer-assistant",
				participantIds: { sol: "mer-sol", fable: "mer-fable", k3: "mer-k3" },
			}),
		);
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/projects/{projectId}/suggestions") return { data: { suggestions: [backlog] } };
			if (path === "/api/v1/sessions/{sessionId}/conversation") {
				return {
					data: {
						sessionId: "mer-assistant",
						source: "codex",
						entries: [
							{ id: "sol-1", role: "user", kind: "message", text: "[SOL] Prefer isolation for safety." },
							{
								id: "assistant-1",
								role: "assistant",
								kind: "message",
								text: "NOTE: Sol favors isolation.\nRESULT: Keep isolated caches; Fable and K3 agreed.",
							},
						],
					},
				};
			}
			return { data: { status: "ok", project: { id: "mer", path: "C:\\work\\mer" } } };
		});

		renderPage();
		expect(await screen.findByText("Prefer isolation for safety.")).toBeInTheDocument();
		expect(screen.getByText("Recorded result")).toBeInTheDocument();
		expect(screen.getAllByText(/RESULT: Keep isolated caches/).length).toBeGreaterThan(0);
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
