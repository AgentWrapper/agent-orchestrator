import { type QueryClient, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";

type TerminateSessionOptions = {
	onSuccess?: (session: WorkspaceSession) => void;
};

export const terminateSessionMutationKey = ["terminate-session"] as const;

type TerminateSessionMutationState = {
	error: unknown;
	session?: WorkspaceSession;
	status: "error" | "idle" | "pending" | "success";
	submittedAt: number;
};

function useTerminateSessionMutations() {
	return useMutationState<TerminateSessionMutationState>({
		filters: { mutationKey: terminateSessionMutationKey },
		select: (mutation) => ({
			error: mutation.state.error,
			session: mutation.state.variables as WorkspaceSession | undefined,
			status: mutation.state.status,
			submittedAt: mutation.state.submittedAt,
		}),
	});
}

function summarizeBySession(mutations: TerminateSessionMutationState[]) {
	const summaries = new Map<
		string,
		{ isPending: boolean; latest: TerminateSessionMutationState; session: WorkspaceSession }
	>();
	for (const mutation of mutations) {
		if (!mutation.session) continue;
		const current = summaries.get(mutation.session.id);
		if (!current) {
			summaries.set(mutation.session.id, {
				isPending: mutation.status === "pending",
				latest: mutation,
				session: mutation.session,
			});
			continue;
		}
		current.isPending ||= mutation.status === "pending";
		if (mutation.submittedAt >= current.latest.submittedAt) current.latest = mutation;
	}
	return [...summaries.values()];
}

export function useTerminateSession(options: TerminateSessionOptions = {}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: terminateSessionMutationKey,
		mutationFn: async (session: WorkspaceSession) => {
			void captureRendererEvent("ao.renderer.session_kill_requested", { project_id: session.workspaceId });
			const { error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: session.id } },
			});
			if (error) {
				const fallback = response ? `Failed to terminate session (${response.status})` : "Failed to terminate session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async (_data, session) => {
			void captureRendererEvent("ao.renderer.session_kill_succeeded", { project_id: session.workspaceId });
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			options.onSuccess?.(session);
		},
		onError: (_error, session) => {
			void captureRendererEvent("ao.renderer.session_kill_failed", { project_id: session.workspaceId });
		},
	});
}

export function useTerminateSessionState(sessionId: string) {
	const summary = summarizeBySession(useTerminateSessionMutations()).find(({ session }) => session.id === sessionId);

	return {
		error:
			!summary?.isPending && summary?.latest.status === "error" && summary.latest.error instanceof Error
				? summary.latest.error.message
				: null,
		isPending: summary?.isPending ?? false,
	};
}

export function useProjectTerminateSessionStates(workspaceId: string | undefined) {
	return summarizeBySession(useTerminateSessionMutations())
		.filter(({ isPending, latest, session }) => {
			return session.workspaceId === workspaceId && (isPending || latest.status === "error");
		})
		.sort((a, b) => b.latest.submittedAt - a.latest.submittedAt)
		.map(({ isPending, latest, session }) => ({
			error: !isPending && latest.error instanceof Error ? latest.error.message : null,
			isPending,
			session,
		}));
}

export function clearTerminateSessionState(queryClient: QueryClient, sessionId: string) {
	const mutationCache = queryClient.getMutationCache();
	for (const mutation of mutationCache.findAll({ mutationKey: terminateSessionMutationKey })) {
		const target = mutation.state.variables as WorkspaceSession | undefined;
		if (target?.id === sessionId && mutation.state.status !== "pending") {
			mutationCache.remove(mutation);
		}
	}
}
