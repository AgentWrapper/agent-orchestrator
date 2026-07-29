import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { captureRendererEventMock, getMock, postMock, hasTrustedApiBaseUrlMock, controlPlaneUrlMock } = vi.hoisted(
	() => ({
		captureRendererEventMock: vi.fn().mockResolvedValue(undefined),
		getMock: vi.fn(),
		postMock: vi.fn(),
		hasTrustedApiBaseUrlMock: vi.fn(() => true),
		// Default: no control plane configured → cloud fetch is NOT auth-gated
		// (cloud comes from the local daemon). Tests override to exercise gating.
		controlPlaneUrlMock: vi.fn<() => string | null>(() => null),
	}),
);

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
	getControlPlaneBaseUrl: controlPlaneUrlMock,
}));

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: captureRendererEventMock }));

import { useWorkspaceQuery, __resetSharedFetchStateForTest, __seedSharedFailuresForTest } from "./useWorkspaceQuery";
import { setCloudSignedIn } from "../stores/cloud-auth-store";

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
	captureRendererEventMock.mockClear();
	getMock.mockReset();
	postMock.mockReset().mockResolvedValue({ data: undefined, error: undefined });
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	controlPlaneUrlMock.mockReset().mockReturnValue(null);
	setCloudSignedIn(false);
	__resetSharedFetchStateForTest();
	// The cloud-session registry reads imported shares from localStorage; clear it
	// so shared imports never leak between tests.
	if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("useWorkspaceQuery", () => {
	it("rejects workspace reads while the daemon base URL is untrusted", async () => {
		hasTrustedApiBaseUrlMock.mockReturnValue(false);

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error).toEqual(new Error("AO daemon API is not ready"));
		expect(getMock).not.toHaveBeenCalled();
	});

	it("maps projects and their sessions, applying provider/status/title fallbacks", async () => {
		respondWith({
			projects: {
				data: {
					projects: [
						{
							id: "proj-1",
							name: "my-app",
							path: "/home/me/my-app",
							orchestratorAgent: "codex",
						},
					],
				},
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
							scmStatus: "review_pending",
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
		expect(workspace).toMatchObject({
			id: "proj-1",
			name: "my-app",
			path: "/home/me/my-app",
			orchestratorAgent: "codex",
		});
		expect(workspace.sessions).toHaveLength(2);
		expect(workspace.sessions[0]).toMatchObject({
			id: "sess-1",
			terminalHandleId: "term-1",
			title: "fix-bug",
			issueId: "github:acme/project-one#42",
			provider: "claude-code",
			branch: "qa/modal-worker",
			status: "mergeable",
			scmStatus: "review_pending",
			activity: { state: "idle", lastActivityAt: "2026-06-10T15:30:00Z" },
		});
		expect(workspace.sessions[1]).toMatchObject({
			id: "sess-2",
			title: "sess-2",
			provider: "codex",
			status: "unknown",
			branch: undefined,
		});
		expect(captureRendererEventMock).toHaveBeenCalledWith("ao.renderer.session_state_unknown", {
			field: "status",
			reason: "unrecognized",
		});
		expect(captureRendererEventMock).toHaveBeenCalledWith("ao.renderer.session_state_unknown", {
			field: "activity",
			reason: "missing",
		});
	});

	it("preserves scratch projects and leaves branchless scratch sessions branchless", async () => {
		respondWith({
			projects: {
				data: {
					projects: [
						{
							id: "scratch",
							name: "Scratch",
							kind: "scratch",
							path: "/home/me/.ao/scratch/default",
						},
					],
				},
				error: undefined,
			},
			sessions: {
				data: {
					sessions: [
						{
							id: "scratch-worker-1",
							projectId: "scratch",
							harness: "codex",
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

		expect(result.current.data?.[0]).toMatchObject({
			id: "scratch",
			kind: "scratch",
		});
		expect(result.current.data?.[0].sessions[0]).toMatchObject({
			id: "scratch-worker-1",
			branch: undefined,
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
		expect(result.current.data?.[0].sessions[0].isTerminated).toBe(true);
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
		expect(result.current.data?.[0].sessions[0].isTerminated).toBe(true);
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

// Owned cloud sessions come from the control-plane registry (durable). The merge
// must surface them regardless of local-project presence or live-fetch success,
// so a created cloud session never vanishes on reconnect/restart.
describe("useWorkspaceQuery cloud-session merge", () => {
	const ownedRef = {
		sessionId: "runbookai-1",
		localProjectId: "runbookai",
		projectId: "runbookai",
		harness: "claude-code",
		kind: "worker",
		sandboxId: "sb-1",
		previewUrl: "https://3001-abc.daytonaproxy01.net",
		status: "ready",
		displayName: "add logger",
	};
	const liveDto = {
		id: "runbookai-1",
		kind: "worker",
		harness: "claude-code",
		displayName: "add logger",
		status: "needs_input",
		activity: { state: "blocked", lastActivityAt: "2026-07-29T10:00:00Z" },
		isTerminated: false,
		createdAt: "2026-07-29T09:00:00Z",
		updatedAt: "2026-07-29T10:00:00Z",
		branch: "ao/runbookai-1/root",
		terminalHandleId: "runbookai-1",
		prs: [],
	};

	// Route every GET the merge makes. `statusResult` decides the live per-session
	// fetch: a value resolves it, "throw" simulates an unreachable sandbox.
	function routeCloud(opts: { projects: unknown[]; owned?: unknown[]; statusResult?: unknown | "throw" }) {
		getMock.mockImplementation(async (url: string) => {
			if (url === "/api/v1/projects") return { data: { projects: opts.projects }, error: undefined };
			if (url === "/api/v1/sessions") return { data: { sessions: [] }, error: undefined };
			if (url === "/api/v1/cloud/sessions") return { data: { sessions: opts.owned ?? [] }, error: undefined };
			if (url.includes("/status")) {
				if (opts.statusResult === "throw") throw new Error("sandbox unreachable");
				return { data: { session: opts.statusResult }, error: undefined };
			}
			throw new Error(`unexpected GET ${url}`);
		});
	}

	it("shows an owned cloud session under its local project (live fetch resolves)", async () => {
		routeCloud({
			projects: [{ id: "runbookai", name: "runbookai", path: "/p" }],
			owned: [ownedRef],
			statusResult: liveDto,
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const proj = result.current.data?.find((w) => w.id === "runbookai");
		const card = proj?.sessions.find((s) => s.id === "cloud-sb-1");
		expect(card?.title).toBe("add logger");
		expect(card?.activity?.state).toBe("blocked");
		// Not duplicated into a synthetic Cloud group.
		expect(result.current.data?.some((w) => w.id === "cloud-sessions")).toBe(false);
	});

	it("materializes an owned cloud session under the Cloud group when its local project is not loaded", async () => {
		routeCloud({ projects: [], owned: [ownedRef], statusResult: liveDto });

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const cloud = result.current.data?.find((w) => w.id === "cloud-sessions");
		expect(cloud?.name).toBe("Cloud");
		expect(cloud?.sessions.map((s) => s.id)).toContain("cloud-sb-1");
	});

	it("keeps an owned cloud session on the board via a fallback card when the live fetch fails", async () => {
		routeCloud({
			projects: [{ id: "runbookai", name: "runbookai", path: "/p" }],
			owned: [ownedRef],
			statusResult: "throw",
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const proj = result.current.data?.find((w) => w.id === "runbookai");
		const card = proj?.sessions.find((s) => s.id === "cloud-sb-1");
		expect(card).toBeDefined();
		expect(card?.title).toBe("add logger");
		expect(card?.kind).toBe("worker");
		expect(card?.status).toBe("unknown");
	});

	it("does not create a Cloud group when there are no owned cloud sessions", async () => {
		routeCloud({ projects: [{ id: "runbookai", name: "runbookai", path: "/p" }], owned: [] });

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data?.some((w) => w.id === "cloud-sessions")).toBe(false);
	});

	it("signed OUT with a control plane configured: no cloud fetch, only local sessions", async () => {
		controlPlaneUrlMock.mockReturnValue("https://cp.example.com");
		setCloudSignedIn(false);
		// Local project + a would-be owned cloud session that must NOT be fetched.
		routeCloud({
			projects: [{ id: "runbookai", name: "runbookai", path: "/p" }],
			owned: [ownedRef],
			statusResult: liveDto,
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		// Local project renders; no cloud card; the cloud list was never queried.
		expect(result.current.data?.some((w) => w.id === "runbookai")).toBe(true);
		expect(result.current.data?.some((w) => w.id === "cloud-sessions")).toBe(false);
		const proj = result.current.data?.find((w) => w.id === "runbookai");
		expect(proj?.sessions.some((s) => s.id === "cloud-sb-1")).toBe(false);
		expect(getMock).not.toHaveBeenCalledWith("/api/v1/cloud/sessions");
	});

	it("shows a shared session under 'Shared with me' when its live view resolves", async () => {
		localStorage.setItem(
			"ao.sharedSessions",
			JSON.stringify([
				{
					v: 1,
					previewUrl: "https://3001-live.daytonaproxy01.net",
					sandboxId: "shX",
					sessionId: "runbookai-1",
					harness: "claude-code",
					projectName: "runbookai",
					mode: "readonly",
				},
			]),
		);
		postMock.mockResolvedValue({ data: { ok: true, status: 200, json: { session: liveDto } }, error: undefined });
		routeCloud({ projects: [], owned: [] });

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const shared = result.current.data?.find((w) => w.id === "shared-with-me");
		expect(shared?.name).toBe("Shared with me");
		expect(shared?.sessions.map((s) => s.id)).toContain("shared-shX");
	});

	function importDeadShare(sandboxId: string) {
		localStorage.setItem(
			"ao.sharedSessions",
			JSON.stringify([
				{
					v: 1,
					previewUrl: "https://3001-dead.daytonaproxy01.net",
					sandboxId,
					sessionId: "runbookai-1",
					harness: "claude-code",
					projectName: "runbookai",
					mode: "readonly",
				},
			]),
		);
		postMock.mockResolvedValue({ data: { ok: false, status: 502 }, error: undefined });
		routeCloud({ projects: [], owned: [] });
	}

	it("shows NO card on a single shared-sandbox failure (debounced, not yet ended)", async () => {
		importDeadShare("shBlip");
		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		// One failure is below the threshold: no card (SessionView's connecting
		// escape covers it) and no premature "ended" archive.
		expect(result.current.data?.some((w) => w.id === "shared-with-me")).toBe(false);
	});

	it("archives a shared session as an ended card once the failure threshold is reached (consistent with terminated)", async () => {
		importDeadShare("shDead");
		// Pre-seed the debounce to one below threshold so this single failing merge
		// trips it deterministically (avoids racing react-query refetch timing).
		__seedSharedFailuresForTest("shDead", 2);

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => {
			const card = result.current.data
				?.find((w) => w.id === "shared-with-me")
				?.sessions.find((s) => s.id === "shared-shDead");
			expect(card?.status).toBe("terminated");
		});
		const card = result.current.data
			?.find((w) => w.id === "shared-with-me")
			?.sessions.find((s) => s.id === "shared-shDead");
		expect(card?.isTerminated).toBe(true);
		expect(card?.cloudPreviewUrl).toBeUndefined(); // no live URL → terminal won't reattach
	});

	it("signed IN with a control plane configured: cloud sessions fetched and shown", async () => {
		controlPlaneUrlMock.mockReturnValue("https://cp.example.com");
		setCloudSignedIn(true);
		routeCloud({
			projects: [{ id: "runbookai", name: "runbookai", path: "/p" }],
			owned: [ownedRef],
			statusResult: liveDto,
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const proj = result.current.data?.find((w) => w.id === "runbookai");
		expect(proj?.sessions.some((s) => s.id === "cloud-sb-1")).toBe(true);
		expect(getMock).toHaveBeenCalledWith("/api/v1/cloud/sessions");
	});
});
