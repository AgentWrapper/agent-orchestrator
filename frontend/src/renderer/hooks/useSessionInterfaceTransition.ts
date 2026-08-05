import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage, hasTrustedApiBaseUrl } from "../lib/api-client";
import { conversationQueryKey } from "./useConversation";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type SessionInterfaceTransition = components["schemas"]["SessionInterfaceTransition"];
export type SessionInterfaceTransitionStatus =
	components["schemas"]["SessionInterfaceTransitionStatusResponse"];
export type SessionInterfaceTransitionPolicy = "drain" | "interrupt";
export type SessionInterfaceMode = "chat" | "tui";

const activePhases = new Set<SessionInterfaceTransition["phase"]>([
	"requested",
	"preflighting",
	"draining",
	"source_stopping",
	"source_stopped",
	"target_starting",
	"activating",
]);

const cancellablePhases = new Set<SessionInterfaceTransition["phase"]>([
	"requested",
	"preflighting",
	"draining",
]);

export function interfaceTransitionIsActive(transition?: SessionInterfaceTransition): boolean {
	return Boolean(transition && activePhases.has(transition.phase));
}

export function interfaceTransitionIsCancellable(transition?: SessionInterfaceTransition): boolean {
	return Boolean(transition && cancellablePhases.has(transition.phase));
}

export function sessionInterfaceTransitionQueryKey(sessionId: string) {
	return ["session-interface-transition", sessionId] as const;
}

/**
 * One bounded durable row drives every client. Polling is intentionally only
 * eager while a handoff is active; idle sessions do not create background
 * traffic and the existing session CDC stream still refreshes the committed
 * mode in the workspace model.
 */
export function useSessionInterfaceTransition(sessionId: string | undefined) {
	const queryClient = useQueryClient();
	const settledRef = useRef<string>("");
	const query = useQuery({
		queryKey: sessionInterfaceTransitionQueryKey(sessionId ?? ""),
		enabled: Boolean(sessionId && hasTrustedApiBaseUrl()),
		queryFn: async () => {
			const { data, error } = await apiClient.GET(
				"/api/v1/sessions/{sessionId}/interface-transition",
				{ params: { path: { sessionId: sessionId as string } } },
			);
			if (error) throw error;
			return data as SessionInterfaceTransitionStatus;
		},
		refetchInterval: (state) =>
			interfaceTransitionIsActive(state.state.data?.transition) ? 250 : false,
		retry: 1,
	});

	const start = useMutation({
		mutationFn: async (input: {
			targetMode: SessionInterfaceMode;
			policy: SessionInterfaceTransitionPolicy;
		}) => {
			const { data, error } = await apiClient.POST(
				"/api/v1/sessions/{sessionId}/interface-transition",
				{
					params: { path: { sessionId: sessionId as string } },
					body: input,
				},
			);
			if (error) throw error;
			return data;
		},
		onSuccess: () => {
			if (sessionId) {
				void queryClient.invalidateQueries({
					queryKey: sessionInterfaceTransitionQueryKey(sessionId),
				});
			}
		},
	});

	const cancel = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.DELETE(
				"/api/v1/sessions/{sessionId}/interface-transition",
				{ params: { path: { sessionId: sessionId as string } } },
			);
			if (error) throw error;
		},
		onSuccess: () => {
			if (sessionId) {
				void queryClient.invalidateQueries({
					queryKey: sessionInterfaceTransitionQueryKey(sessionId),
				});
			}
		},
	});

	const transition = query.data?.transition;
	useEffect(() => {
		if (!sessionId || !transition || interfaceTransitionIsActive(transition)) return;
		if (settledRef.current === transition.id) return;
		settledRef.current = transition.id;
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId) });
	}, [queryClient, sessionId, transition]);

	return {
		status: query.data,
		transition,
		isLoading: query.isLoading,
		statusError: query.error ? apiErrorMessage(query.error) : undefined,
		start: start.mutateAsync,
		starting: start.isPending,
		startError: start.error ? apiErrorMessage(start.error) : undefined,
		resetStartError: start.reset,
		cancel: cancel.mutateAsync,
		cancelling: cancel.isPending,
		cancelError: cancel.error ? apiErrorMessage(cancel.error) : undefined,
	};
}
