/**
 * Live conversation data for a Chat session.
 *
 * The daemon serves the snapshot already ordered by sequence, so this hook maps
 * the wire shape onto the view model and does not re-sort, re-derive turn state,
 * or decide which approvals are actionable. Those are daemon decisions.
 *
 * Polling for now. The mux conversation channel replaces the interval later; the
 * component contract does not change when it does, because both produce the same
 * snapshot.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import type {
	ActivityKind,
	ActivityStatus,
	ConversationActivity,
	ConversationItem,
	ConversationMessage,
	ConversationSnapshot,
	ControllerState,
	DecisionOption,
	MessageOrigin,
	MessageRole,
	SessionMode,
	TurnState,
} from "../types/conversation";

type WireSnapshot = components["schemas"]["ConversationSnapshotResponse"];
type WireMessage = components["schemas"]["ConversationMessageResponse"];
type WireActivity = components["schemas"]["ConversationActivityResponse"];

export function conversationQueryKey(sessionId: string) {
	return ["conversation", sessionId] as const;
}

/**
 * A turn is in flight while the agent is working, so the snapshot is refetched
 * quickly. An idle conversation does not need to be polled hard.
 */
const ACTIVE_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 5000;

export interface ConversationQueryResult {
	snapshot?: ConversationSnapshot;
	isLoading: boolean;
	/** Set when the session exists but has no chat conversation to show. */
	unavailable?: { code: string; message: string };
	error?: string;
}

export function useConversation(sessionId: string | undefined): ConversationQueryResult {
	const query = useQuery({
		queryKey: conversationQueryKey(sessionId ?? ""),
		enabled: Boolean(sessionId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/conversation", {
				params: { path: { sessionId: sessionId as string } },
			});
			if (error) throw error;
			return toSnapshot(data as WireSnapshot);
		},
		refetchInterval: (query) => {
			const snapshot = query.state.data;
			if (!snapshot) return IDLE_INTERVAL_MS;
			const busy =
				snapshot.controller.state === "busy" ||
				snapshot.turns.some((turn) => turn.state === "running" || turn.state === "queued");
			return busy ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
		},
	});

	if (query.error) {
		const code = apiErrorCode(query.error);
		// A session created in Terminal UI mode has no conversation, and never will:
		// the mode is immutable. That is a state to explain, not an error to retry.
		if (code === "SESSION_MODE_MISMATCH" || code === "CHAT_CONTROLLER_NOT_READY") {
			return {
				isLoading: false,
				unavailable: { code, message: apiErrorMessage(query.error) },
			};
		}
		return { isLoading: false, error: apiErrorMessage(query.error) };
	}

	return { snapshot: query.data, isLoading: query.isLoading };
}

/** Commands against a conversation. Each refetches the snapshot on success. */
export function useConversationCommands(sessionId: string | undefined) {
	const queryClient = useQueryClient();
	const invalidate = useCallback(() => {
		if (sessionId) {
			void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId) });
		}
	}, [queryClient, sessionId]);

	const send = useMutation({
		mutationFn: async (text: string) => {
			const { data, error } = await apiClient.POST(
				"/api/v1/sessions/{sessionId}/conversation/messages",
				{
					params: { path: { sessionId: sessionId as string } },
					// A stable id per attempt makes a retry idempotent: the daemon
					// answers `duplicate` instead of opening a second provider turn.
					body: { text, clientMessageId: crypto.randomUUID() },
				},
			);
			if (error) throw error;
			return data;
		},
		onSuccess: invalidate,
	});

	const resolve = useMutation({
		mutationFn: async (input: { requestId: string; decisionId: string }) => {
			const { error } = await apiClient.POST(
				"/api/v1/sessions/{sessionId}/conversation/approvals/{requestId}/resolve",
				{
					params: { path: { sessionId: sessionId as string, requestId: input.requestId } },
					body: { decisionId: input.decisionId },
				},
			);
			if (error) throw error;
		},
		onSuccess: invalidate,
	});

	const interrupt = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.POST(
				"/api/v1/sessions/{sessionId}/conversation/interrupt",
				{ params: { path: { sessionId: sessionId as string } } },
			);
			if (error) throw error;
		},
		onSuccess: invalidate,
	});

	return {
		send: (text: string) => send.mutate(text),
		resolve: (requestId: string, decisionId: string) => resolve.mutate({ requestId, decisionId }),
		interrupt: () => interrupt.mutate(),
		busy: send.isPending || resolve.isPending || interrupt.isPending,
		error:
			send.error || resolve.error || interrupt.error
				? apiErrorMessage(send.error ?? resolve.error ?? interrupt.error)
				: undefined,
	};
}

/* -------------------------------------------------------------------------- */

/**
 * Merge messages and activities into one ordered timeline.
 *
 * They are separate tables because they have different write patterns, but the
 * reader sees one sequence — which is why sequence is conversation-scoped rather
 * than per-table.
 */
function toSnapshot(wire: WireSnapshot): ConversationSnapshot {
	const items: ConversationItem[] = [
		...(wire.messages ?? []).map(toMessage),
		...(wire.activities ?? []).map(toActivity),
	].sort((a, b) => a.sequence - b.sequence);

	return {
		conversationId: wire.conversationId,
		sessionId: wire.sessionId,
		harness: wire.harness ?? "",
		mode: wire.mode as SessionMode,
		controller: { state: wire.controller as ControllerState },
		latestSequence: wire.latestSequence,
		turns: (wire.turns ?? []).map((turn) => ({
			id: turn.id,
			state: turn.state as TurnState,
			providerTurnId: turn.providerTurnId,
			errorMessage: turn.errorMessage,
			requestedAt: turn.requestedAt,
			startedAt: turn.startedAt ?? undefined,
			completedAt: turn.completedAt ?? undefined,
		})),
		items,
	};
}

function toMessage(wire: WireMessage): ConversationMessage {
	return {
		kind: "message",
		id: wire.id,
		turnId: wire.turnId,
		sequence: wire.sequence,
		revision: wire.revision,
		role: wire.role as MessageRole,
		origin: wire.origin as MessageOrigin,
		text: wire.text,
		streaming: wire.streaming,
		createdAt: wire.createdAt,
	};
}

function toActivity(wire: WireActivity): ConversationActivity {
	const detail = (wire.detail ?? {}) as Record<string, unknown>;
	return {
		kind: "activity",
		id: wire.id,
		turnId: wire.turnId,
		sequence: wire.sequence,
		revision: wire.revision,
		activityKind: wire.activityKind as ActivityKind,
		status: wire.status as ActivityStatus,
		summary: wire.summary,
		requestId: wire.requestId,
		// The provider's own offered decisions, carried through the detail payload.
		// Rendering from this is what keeps the card from drawing a button the
		// provider will reject.
		decisions: readDecisions(detail),
		detail: detail as ConversationActivity["detail"],
		createdAt: wire.createdAt,
	};
}

function readDecisions(detail: Record<string, unknown>): DecisionOption[] | undefined {
	const raw = detail.decisions;
	if (!Array.isArray(raw)) return undefined;
	const options: DecisionOption[] = [];
	for (const entry of raw) {
		if (entry && typeof entry === "object" && "id" in entry) {
			const option = entry as { id?: unknown; label?: unknown };
			if (typeof option.id === "string" && option.id !== "") {
				options.push({
					id: option.id,
					label: typeof option.label === "string" && option.label ? option.label : option.id,
				});
			}
		}
	}
	return options.length > 0 ? options : undefined;
}
