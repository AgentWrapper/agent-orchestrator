import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { getMock, hasTrustedApiBaseUrlMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	hasTrustedApiBaseUrlMock: vi.fn(() => true),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
}));

import { useWorkspaceQuery } from "./useWorkspaceQuery";

function wrapper({ children }: { children: ReactNode }) {
	// The hook pins its own retry policy; retryDelay 0 keeps the error tests fast.
	const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function respondWith(payload: {
	projects?: { data?: unknown; error?: unknown };
	sessions?: { data?: unknown; error?: unknown };
}) {
	getMock.mockImplementation(async (url: string) => {
		if (url === "/api/v1/projects") return payload.projects ?? { data: { projects: [] }, error: undefined };
		if (url === "/api/v1/sessions") return payload.sessions ?? { data: { sessions: [] }, error: undefined };
		throw new Error(`unexpected GET ${url}`);
	});
}

beforeEach(() => {
	getMock.mockReset();
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
});

describe("useWorkspaceQuery", () => {
	it("returns an empty workspace list while the daemon base URL is untrusted", async () => {
		hasTrustedApiBaseUrlMock.mockReturnValue(false);

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual([]);
		expect(getMock).not.toHaveBeenCalled();
	});

	it("maps projects and their sessions, applying provider/status/title fallbacks", async () => {
		respondWith({
			projects: {
				data: { projects: [{ id: "proj-1", name: "my-app", path: "/home/me/my-app" }] },
				error: undefined,
			},
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							terminalHandleId: "term-1",
							displayName: "fix-bug",
							issueId: "github:acme/project-one#42",
							harness: "claude-code",
							branch: "qa/modal-worker",
							status: "mergeable",
							isTerminated: false,
							activity: { state: "idle", lastActivityAt: "2026-06-10T15:30:00Z" },
							updatedAt: "2026-06-10T16:15:04Z",
						},
						{
							// Unknown harness/status and no displayName/issueId: falls back
							// to codex / unknown / the session id.
							id: "sess-2",
							projectId: "proj-1",
							harness: "mystery-agent",
							status: "bogus",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
						},
						// Belongs to another project; must not leak into proj-1.
						{ id: "sess-3", projectId: "proj-2", isTerminated: false, updatedAt: "2026-06-10T16:15:04Z" },
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const [workspace] = result.current.data ?? [];
		expect(workspace).toMatchObject({ id: "proj-1", name: "my-app", path: "/home/me/my-app" });
		expect(workspace.sessions).toHaveLength(2);
		expect(workspace.sessions[0]).toMatchObject({
			id: "sess-1",
			terminalHandleId: "term-1",
			title: "fix-bug",
			issueId: "github:acme/project-one#42",
			provider: "claude-code",
			branch: "qa/modal-worker",
			status: "mergeable",
			activity: { state: "idle", lastActivityAt: "2026-06-10T15:30:00Z" },
		});
		expect(workspace.sessions[1]).toMatchObject({
			id: "sess-2",
			title: "sess-2",
			provider: "codex",
			status: "unknown",
			branch: "session/sess-2",
		});
	});

	it("maps each session's prs straight from the session list", async () => {
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							status: "pr_open",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
							prs: [
								{
									number: 278,
									state: "open",
									url: "u",
									ci: "passing",
									review: "approved",
									mergeability: "clean",
									reviewComments: false,
									updatedAt: "2026-06-10T16:15:04Z",
								},
							],
						},
						{
							id: "sess-2",
							projectId: "proj-1",
							status: "working",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const sessions = result.current.data?.[0].sessions ?? [];
		expect(sessions[0].prs).toEqual([
			{
				number: 278,
				state: "open",
				url: "u",
				ci: "passing",
				review: "approved",
				mergeability: "clean",
				reviewComments: false,
				updatedAt: "2026-06-10T16:15:04Z",
			},
		]);
		// A session with no PRs maps to an empty stack, so the empty states render.
		expect(sessions[1].prs).toEqual([]);
	});

	it("preserves backend merged status for terminated merged sessions", async () => {
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							status: "merged",
							isTerminated: true,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data?.[0].sessions[0].status).toBe("merged");
	});

	it("falls back to terminated for terminated sessions without a known backend status", async () => {
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							status: "bogus",
							isTerminated: true,
							updatedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			},
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data?.[0].sessions[0].status).toBe("terminated");
	});

	it("surfaces a projects fetch error", async () => {
		const failure = new TypeError("Failed to fetch");
		respondWith({ projects: { data: undefined, error: failure } });

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });
		expect(result.current.error).toBe(failure);
	});

	it("surfaces a sessions fetch error even when projects load", async () => {
		const failure = new Error("sessions backend down");
		respondWith({
			projects: { data: { projects: [{ id: "proj-1", name: "my-app", path: "/p" }] }, error: undefined },
			sessions: { data: undefined, error: failure },
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });
		expect(result.current.error).toBe(failure);
	});
});
