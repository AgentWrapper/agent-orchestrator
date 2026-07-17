import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "../lib/api-client";
import { mockWorkspaces } from "../lib/mock-data";
import {
	type PRState,
	type PullRequestFacts,
	toAgentProvider,
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
const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

// Thrown when fetchWorkspaces runs before the daemon's API base URL is known.
// The port is discovered at runtime (only once the daemon reports ready), so
// before that there is no authoritative project list. Callers gate on
// hasTrustedApiBaseUrl(); this exists so a missed gate fails as an error rather
// than resolving to a *successful* empty list — which would flash the first-run
// onboarding page over existing projects (#2514).
export class ApiBaseUrlNotTrustedError extends Error {
	constructor() {
		super("workspace query ran before the daemon API base URL was trusted");
		this.name = "ApiBaseUrlNotTrustedError";
	}
}

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	if (usePreviewData) {
		return mockWorkspaces;
	}
	if (!hasTrustedApiBaseUrl()) {
		throw new ApiBaseUrlNotTrustedError();
	}

	const [{ data: projectsData, error: projectsError }, { data: sessionsData, error: sessionsError }] =
		await Promise.all([apiClient.GET("/api/v1/projects"), apiClient.GET("/api/v1/sessions")]);

	if (projectsError || sessionsError) throw projectsError ?? sessionsError;

	return (projectsData?.projects ?? []).map((project) => ({
		id: project.id,
		name: project.name,
		kind: project.kind === "workspace" ? "workspace" : "single_repo",
		path: project.path,
		orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
		sessions: (sessionsData?.sessions ?? [])
			.filter((session) => session.projectId === project.id)
			.map((session) => ({
				id: session.id,
				terminalHandleId: session.terminalHandleId,
				workspaceId: project.id,
				workspaceName: project.name,
				title: session.displayName ?? session.issueId ?? session.id,
				issueId: session.issueId,
				provider: toAgentProvider(session.harness),
				kind: session.kind === "orchestrator" ? "orchestrator" : session.kind === "worker" ? "worker" : undefined,
				branch: session.branch ?? `session/${session.id}`,
				status: toSessionStatus(session.status, session.isTerminated),
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				activity: toSessionActivity(session.activity),
				previewUrl: session.previewUrl,
				previewRevision: session.previewRevision,
				prs: (session.prs ?? []).map(toPullRequestFacts),
			})),
	}));
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
	// Gate the query on a trusted API base URL, tracked reactively so it flips on
	// the moment the daemon reports ready (setApiBaseUrl notifies subscribers).
	// While untrusted the query stays *pending* (never a successful empty list),
	// so SessionsBoard shows its loading shell instead of flashing onboarding
	// over projects that are about to load (#2514). Preview mode has no daemon and
	// serves mock data, so it is always enabled.
	const trusted = useSyncExternalStore(subscribeApiBaseUrl, hasTrustedApiBaseUrl, hasTrustedApiBaseUrl);
	return useQuery({ ...workspaceQueryOptions, enabled: usePreviewData || trusted });
}
