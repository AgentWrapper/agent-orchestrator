import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";
import {
	refreshCloudSessions,
	getCloudSessions,
	boardIdForRef,
	SHARED_PROJECT_ID,
	SHARED_PROJECT_NAME,
	CLOUD_PROJECT_ID,
	CLOUD_PROJECT_NAME,
	type CloudSessionRef,
} from "../lib/cloud-sessions";
import { mockWorkspaces } from "../lib/mock-data";
import { captureRendererEvent } from "../lib/telemetry";
import {
	type PRState,
	type PullRequestFacts,
	toAgentProvider,
	toProjectKind,
	toSessionActivity,
	toSessionStatus,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../types/workspace";

type SessionView = components["schemas"]["ControllersSessionView"];

function toPullRequestFacts(pr: components["schemas"]["SessionPRFacts"]): PullRequestFacts {
	return {
		url: pr.url,
		number: pr.number,
		state: pr.state as PRState,
		ci: pr.ci,
		review: pr.review,
		mergeability: pr.mergeability,
		reviewComments: pr.reviewComments,
		updatedAt: pr.updatedAt,
	};
}

export const workspaceQueryKey = ["workspaces"] as const;
const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";
const reportedUnknownSessionFields = new Set<string>();

function reportUnknownSessionField(field: "status" | "activity", value?: string): void {
	const reason = value ? "unrecognized" : "missing";
	const key = `${field}:${reason}`;
	if (reportedUnknownSessionFields.has(key)) return;
	reportedUnknownSessionFields.add(key);
	void captureRendererEvent("ao.renderer.session_state_unknown", { field, reason });
}

// Shared shaping: a daemon session DTO → WorkspaceSession. Used for both local
// sessions and cloud sessions fetched from a sandbox daemon (cloudPreviewUrl set
// for the latter, which is the ONLY difference — it routes the terminal mux).
function toWorkspaceSession(
	session: SessionView,
	projectId: string,
	projectName: string,
	cloud?: { previewUrl: string; boardId: string; readonly?: boolean },
): WorkspaceSession {
	const status = toSessionStatus(session.status, session.isTerminated);
	const scmStatus = session.scmStatus ? toSessionStatus(session.scmStatus) : undefined;
	const activity = toSessionActivity(session.activity);
	if (status === "unknown") reportUnknownSessionField("status", session.status);
	if (!activity || activity.state === "unknown") reportUnknownSessionField("activity", session.activity?.state);
	return {
		// Cloud sessions get a globally-unique board id (sandbox-namespaced); the
		// terminal still opens the sandbox's REAL handle (terminalHandleId below).
		id: cloud ? cloud.boardId : session.id,
		terminalHandleId: session.terminalHandleId,
		workspaceId: projectId,
		workspaceName: projectName,
		title: session.displayName ?? session.issueId ?? session.id,
		issueId: session.issueId,
		provider: toAgentProvider(session.harness),
		kind: session.kind === "orchestrator" ? "orchestrator" : session.kind === "worker" ? "worker" : undefined,
		branch: session.branch || undefined,
		status,
		scmStatus,
		isTerminated: session.isTerminated,
		terminateOnPrMerge: session.terminateOnPrMerge ?? false,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		activity,
		previewUrl: session.previewUrl,
		previewRevision: session.previewRevision,
		prs: (session.prs ?? []).map(toPullRequestFacts),
		cloudPreviewUrl: cloud?.previewUrl,
		readonly: cloud?.readonly,
	};
}

// e2e seam (dev:web only): the Playwright fake-agent harness injects
// `window.__aoFakeAgent` to drive a deterministic session timeline. Compiled out
// of the packaged build.
type FakeAgentSeam = { snapshot: () => WorkspaceSummary[] };

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	if (usePreviewData) {
		const fake =
			typeof window !== "undefined" ? (window as unknown as { __aoFakeAgent?: FakeAgentSeam }).__aoFakeAgent : undefined;
		return fake ? fake.snapshot() : mockWorkspaces;
	}
	if (!hasTrustedApiBaseUrl()) {
		return [];
	}

	const [{ data: projectsData, error: projectsError }, { data: sessionsData, error: sessionsError }] = await Promise.all([
		apiClient.GET("/api/v1/projects"),
		apiClient.GET("/api/v1/sessions"),
	]);

	if (projectsError || sessionsError) throw projectsError ?? sessionsError;

	const workspaces: WorkspaceSummary[] = (projectsData?.projects ?? []).map((project) => ({
		id: project.id,
		name: project.name,
		kind: toProjectKind(project.kind),
		path: project.path,
		orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
		sessions: (sessionsData?.sessions ?? [])
			.filter((session) => session.projectId === project.id)
			.map((session) => toWorkspaceSession(session, project.id, project.name)),
	}));

	await mergeCloudSessions(workspaces);
	return workspaces;
}

// Merge per-session cloud sandboxes into their LOCAL project's board, so a cloud
// worker is an ordinary card. Each cloud session's live view comes from its own
// sandbox daemon (via the Go daemon's cloud endpoints); the card carries
// cloudPreviewUrl so its terminal routes there. Best-effort per tick.
async function mergeCloudSessions(workspaces: WorkspaceSummary[]): Promise<void> {
	if (usePreviewData) return;
	await refreshCloudSessions();
	const refs = getCloudSessions();
	if (refs.length === 0) return;

	const byProject = new Map(workspaces.map((w) => [w.id, w]));

	// Lazily materialize a synthetic board group the first time a card needs it,
	// so an empty group never shows.
	const ensureGroup = (id: string, name: string): WorkspaceSummary => {
		let group = byProject.get(id);
		if (!group) {
			group = { id, name, path: "", sessions: [] };
			workspaces.push(group);
			byProject.set(id, group);
		}
		return group;
	};

	// Which board group a cloud session's card belongs to. Shared imports have no
	// local project, so they live under "Shared with me". An OWNED session goes
	// under its local project when that project is loaded; when it isn't (deleted,
	// on another machine, or an id mismatch) it falls back to the "Cloud" group.
	// The control plane is the durable source of owned sessions, so one must never
	// be silently dropped just because its local project isn't present.
	const groupFor = (ref: CloudSessionRef): WorkspaceSummary => {
		if (ref.shared) return ensureGroup(SHARED_PROJECT_ID, SHARED_PROJECT_NAME);
		return byProject.get(ref.localProjectId) ?? ensureGroup(CLOUD_PROJECT_ID, CLOUD_PROJECT_NAME);
	};

	await Promise.all(
		refs.map(async (ref) => {
			const target = groupFor(ref);
			const boardId = boardIdForRef(ref);
			if (target.sessions.some((s) => s.id === boardId)) return; // de-dupe by unique board id

			// Terminated (killed): sandbox is gone — render an archived card from
			// cached fields, exactly like a local terminated session. No live fetch.
			if (!ref.shared && ref.status === "terminated") {
				target.sessions.push(terminatedCard(ref, target.id, target.name, boardId));
				return;
			}
			// Still provisioning / failed → show a placeholder card (no sandbox
			// session exists yet). Owned sessions carry a status; shared are ready.
			if (!ref.shared && ref.status && ref.status !== "ready") {
				target.sessions.push(provisioningCard(ref, target.id, target.name, boardId));
				return;
			}
			// Live view from the sandbox. If it can't be fetched this tick (offline,
			// waking, slow), still render a card from the control-plane registry
			// fields — the durable source — so a cloud session persists across
			// reconnects/restarts instead of vanishing. The live view fills in detail
			// on the next successful tick.
			let dto: SessionView | undefined;
			try {
				dto = await fetchCloudSessionDto(ref);
			} catch {
				dto = undefined;
			}
			target.sessions.push(
				dto
					? toWorkspaceSession(dto, target.id, target.name, {
							previewUrl: ref.previewUrl,
							boardId,
							readonly: ref.readonly,
						})
					: cloudRefCard(ref, target.id, target.name, boardId),
			);
		}),
	);
}

// A card built from control-plane registry fields alone, used when the live
// sandbox view can't be fetched this tick. Keyed off the durable registry so an
// owned/shared cloud session stays on the board while its sandbox is briefly
// unreachable; the real activity/PR detail resolves once the fetch succeeds.
function cloudRefCard(ref: CloudSessionRef, projectId: string, projectName: string, boardId: string): WorkspaceSession {
	return {
		id: boardId,
		terminalHandleId: ref.sessionId,
		workspaceId: projectId,
		workspaceName: projectName,
		title: ref.displayName || `${ref.harness} (cloud)`,
		provider: toAgentProvider(ref.harness),
		kind: ref.kind === "orchestrator" ? "orchestrator" : "worker",
		status: "unknown",
		isTerminated: false,
		terminateOnPrMerge: false,
		updatedAt: "",
		activity: { state: "idle", lastActivityAt: "" },
		previewUrl: ref.previewUrl,
		cloudPreviewUrl: ref.previewUrl,
		readonly: ref.readonly,
		prs: [],
	};
}

// An archived card for a killed cloud session (sandbox deleted). Rendered from
// cached registry fields — matches a local terminated session's board presence.
function terminatedCard(ref: CloudSessionRef, projectId: string, projectName: string, boardId: string): WorkspaceSession {
	return {
		id: boardId,
		terminalHandleId: "",
		workspaceId: projectId,
		workspaceName: projectName,
		title: ref.displayName || `${ref.harness} (cloud)`,
		provider: toAgentProvider(ref.harness),
		kind: "worker",
		status: "terminated",
		isTerminated: true,
		terminateOnPrMerge: false,
		updatedAt: "",
		activity: { state: "exited", lastActivityAt: "" },
		prs: [],
	};
}

// A placeholder card for a cloud session whose sandbox is still provisioning
// (or failed). It has no terminal/actions — it flips to the real card once the
// sandbox session goes live.
function provisioningCard(ref: CloudSessionRef, projectId: string, projectName: string, boardId: string): WorkspaceSession {
	const failed = ref.status === "failed";
	return {
		id: boardId,
		terminalHandleId: "",
		workspaceId: projectId,
		workspaceName: projectName,
		title: ref.displayName || `${ref.harness} (cloud)`,
		provider: toAgentProvider(ref.harness),
		kind: "worker",
		status: failed ? "unknown" : "working",
		isTerminated: false,
		terminateOnPrMerge: false,
		updatedAt: "",
		activity: { state: failed ? "blocked" : "active", lastActivityAt: "" },
		prs: [],
		provisioning: !failed,
		provisionError: failed ? ref.error || "Provisioning failed" : undefined,
	};
}

// A cloud session's live view. Owned sessions go through the Go daemon's status
// endpoint (it holds the sandbox); SHARED sessions are fetched via the cloud
// proxy (the daemon relays to the owner's sandbox — the renderer can't call it
// directly because of the Daytona proxy's duplicate CORS header).
async function fetchCloudSessionDto(ref: CloudSessionRef): Promise<SessionView | undefined> {
	let raw: unknown;
	if (ref.shared) {
		// Shared sessions MUST use shared-proxy, not the owner proxy: the viewer is
		// often a different tenant and holds only a bare preview URL, which the
		// tenant-guarded /cloud/proxy rejects (403 on the control plane). shared-proxy
		// is GET-only and skips the ownership check. Kept in lockstep with
		// session-api.ts, which routes a shared session's actions the same way.
		const { data } = await apiClient.POST("/api/v1/cloud/shared-proxy", {
			body: { previewUrl: ref.previewUrl, method: "GET", path: `/api/v1/sessions/${ref.sessionId}` },
		});
		if (!data?.ok) return undefined;
		raw = data.json;
	} else {
		const { data } = await apiClient.GET("/api/v1/cloud/sessions/{sandboxId}/status", {
			params: { path: { sandboxId: ref.sandboxId } },
		});
		raw = data;
	}
	const dto = raw && typeof raw === "object" && "session" in raw ? (raw as { session?: unknown }).session : raw;
	return (dto as SessionView) || undefined;
}

// Shared so route loaders can prefetch via queryClient.ensureQueryData.
export const workspaceQueryOptions = {
	queryKey: workspaceQueryKey,
	queryFn: fetchWorkspaces,
	retry: 1,
	refetchInterval: 15_000,
};

export function useWorkspaceQuery() {
	return useQuery(workspaceQueryOptions);
}
