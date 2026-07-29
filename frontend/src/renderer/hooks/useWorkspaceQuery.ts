import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";
import { cloudDevReady, fetchCloudDevJSON } from "../lib/cloud-dev";
import { mockWorkspaces } from "../lib/mock-data";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { captureRendererEvent } from "../lib/telemetry";
import { useUiStore } from "../stores/ui-store";
import {
	type PRState,
	type PullRequestFacts,
	toAgentProvider,
	toProjectKind,
	toSessionActivity,
	toSessionStatus,
	type WorkspaceSummary,
} from "../types/workspace";

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
const reportedUnknownSessionFields = new Set<string>();

function reportUnknownSessionField(field: "status" | "activity", value?: string): void {
	const reason = value ? "unrecognized" : "missing";
	const key = `${field}:${reason}`;
	if (reportedUnknownSessionFields.has(key)) return;
	reportedUnknownSessionFields.add(key);
	void captureRendererEvent("ao.renderer.session_state_unknown", { field, reason });
}

// e2e seam (dev:web only): the Playwright fake-agent harness injects
// `window.__aoFakeAgent` (see e2e/support/fake-bridge.ts) to drive a
// deterministic, mutable session timeline off the SSE refetch path. Compiled
// out of the packaged build — the packaged renderer never sets VITE_NO_ELECTRON
// and always hits the real daemon.
type FakeAgentSeam = { snapshot: () => WorkspaceSummary[] };

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	if (usesPreviewWorkspaceData) {
		const fake =
			typeof window !== "undefined"
				? (window as unknown as { __aoFakeAgent?: FakeAgentSeam }).__aoFakeAgent
				: undefined;
		return fake ? fake.snapshot() : mockWorkspaces;
	}
	if (!hasTrustedApiBaseUrl()) {
		throw new Error("AO daemon API is not ready");
	}

	const [{ data: projectsData, error: projectsError }, { data: sessionsData, error: sessionsError }] =
		await Promise.all([apiClient.GET("/api/v1/projects"), apiClient.GET("/api/v1/sessions")]);

	if (projectsError || sessionsError) throw projectsError ?? sessionsError;

	const local = mapWorkspaceSummaries(projectsData?.projects ?? [], sessionsData?.sessions ?? []);
	const cloudDev = useUiStore.getState().cloudDev;
	if (!cloudDevReady(cloudDev)) return local;
	try {
		const [cloudProjectsData, cloudSessionsData] = await Promise.all([
			fetchCloudDevJSON<components["schemas"]["ListProjectsResponse"]>(cloudDev, "/api/v1/projects"),
			fetchCloudDevJSON<components["schemas"]["ListSessionsResponse"]>(cloudDev, "/api/v1/sessions"),
		]);
		return [
			...local,
			...mapWorkspaceSummaries(cloudProjectsData.projects ?? [], cloudSessionsData.sessions ?? [], {
				cloud: true,
			}),
		];
	} catch (error) {
		void captureRendererEvent("ao.renderer.cloud_dev_fetch_failed", {
			error_category: error instanceof TypeError ? "network_error" : "request_error",
		});
		return local;
	}
}

function mapWorkspaceSummaries(
	projects: components["schemas"]["ProjectSummary"][],
	sessions: components["schemas"]["ControllersSessionView"][],
	options: { cloud?: boolean } = {},
): WorkspaceSummary[] {
	return projects.map((project) => {
		const kind = toProjectKind(project.kind);
		return {
			id: project.id,
			name: options.cloud ? `${project.name} (Cloud)` : project.name,
			kind,
			path: project.path,
			orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
			sessions: sessions
				.filter((session) => session.projectId === project.id)
				.map((session) => {
					const status = toSessionStatus(session.status, session.isTerminated);
					const scmStatus = session.scmStatus ? toSessionStatus(session.scmStatus) : undefined;
					const activity = toSessionActivity(session.activity);
					if (status === "unknown") reportUnknownSessionField("status", session.status);
					if (!activity || activity.state === "unknown") {
						reportUnknownSessionField("activity", session.activity?.state);
					}
					return {
						id: session.id,
						terminalHandleId: options.cloud ? undefined : session.terminalHandleId,
						workspaceId: project.id,
						workspaceName: options.cloud ? `${project.name} (Cloud)` : project.name,
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
					};
				}),
		};
	});
}

// Shared so route loaders can prefetch via queryClient.ensureQueryData (paired
// with the router's defaultPreload: "intent") and the hook reads the same cache.
export const workspaceQueryOptions = {
	queryKey: workspaceQueryKey,
	queryFn: fetchWorkspaces,
	retry: 1,
	refetchInterval: 15_000,
};

export function useWorkspaceQuery() {
	return useQuery(workspaceQueryOptions);
}
