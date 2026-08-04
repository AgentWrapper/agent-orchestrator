/**
 * Live agent-stream state for one session.
 *
 * Applies batched, sequenced AgentStreamEvent values through the pure reducer.
 * Transport is optional: when the daemon SSE route is unavailable the hook still
 * exposes `pushEvents` for tests and for a future composition with snapshot poll.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	createAgentSessionStreamState,
	createAgentStreamBatcher,
	isAgentStreamActive,
	reduceAgentStreamEvent,
	requestAgentStreamCancellation,
	resolveAgentStreamPermission,
	connectAgentStream,
	respondToAgentPermission,
	type AgentStreamTransport,
} from "../lib/agent-stream";
import type {
	AgentPermissionResponse,
	AgentSessionStreamState,
	AgentStreamEvent,
} from "../types/agentStreamTypes";
import type { StreamMessage } from "../types/streamMessages";
import { getApiBaseUrl, hasTrustedApiBaseUrl } from "../lib/api-client";

export type AgentStreamConnectionState = "idle" | "connecting" | "open" | "disconnected" | "unavailable";

export interface UseAgentStreamOptions {
	sessionId: string | undefined;
	/** When false, do not open SSE (fixture / unit-test mode). Default true. */
	connect?: boolean;
	/** Seed messages (e.g. from a durable snapshot). */
	initialMessages?: StreamMessage[];
	/** Inject permission responder (tests). */
	respondPermission?: (response: AgentPermissionResponse) => Promise<void>;
}

export interface UseAgentStreamResult {
	messages: StreamMessage[];
	stream: AgentSessionStreamState;
	streaming: boolean;
	error: string;
	connection: AgentStreamConnectionState;
	/** Apply one or more already-parsed events (bypasses SSE). */
	pushEvents: (events: AgentStreamEvent[]) => void;
	respondToPermission: (requestId: string, optionId: string) => Promise<void>;
	requestCancel: () => void;
	/** Reset timeline + stream state (new turn / session switch). */
	reset: (messages?: StreamMessage[]) => void;
}

export function useAgentStream(options: UseAgentStreamOptions): UseAgentStreamResult {
	const { sessionId, connect = true, initialMessages = [], respondPermission } = options;
	const [messages, setMessages] = useState<StreamMessage[]>(initialMessages);
	const [stream, setStream] = useState<AgentSessionStreamState>(createAgentSessionStreamState);
	const [error, setError] = useState("");
	const [connection, setConnection] = useState<AgentStreamConnectionState>("idle");

	const messagesRef = useRef(messages);
	const streamRef = useRef(stream);
	messagesRef.current = messages;
	streamRef.current = stream;

	const applyEvents = useCallback((events: AgentStreamEvent[]) => {
		let nextMessages = messagesRef.current;
		let nextStream = streamRef.current;
		let nextError = "";
		for (const event of events) {
			const reduced = reduceAgentStreamEvent(nextMessages, nextStream, event);
			if (reduced.ignored) continue;
			nextMessages = reduced.messages;
			nextStream = reduced.stream;
			if (reduced.error) nextError = reduced.error;
		}
		messagesRef.current = nextMessages;
		streamRef.current = nextStream;
		setMessages(nextMessages);
		setStream(nextStream);
		if (nextError) setError(nextError);
	}, []);

	const batcherRef = useRef<ReturnType<typeof createAgentStreamBatcher> | null>(null);
	if (!batcherRef.current) {
		batcherRef.current = createAgentStreamBatcher({
			onFlush: (_sessionId, events) => applyEvents(events),
		});
	}

	const pushEvents = useCallback((events: AgentStreamEvent[]) => {
		const batcher = batcherRef.current;
		if (!batcher) return;
		for (const event of events) batcher.push(event);
	}, []);

	// SSE transport when session is set and connect is requested.
	useEffect(() => {
		if (!sessionId || !connect) {
			setConnection(sessionId ? "idle" : "idle");
			return;
		}
		if (!hasTrustedApiBaseUrl()) {
			setConnection("unavailable");
			return;
		}

		let transport: AgentStreamTransport | null = null;
		transport = connectAgentStream({
			sessionId,
			baseUrl: getApiBaseUrl(),
			onEvent: (event) => batcherRef.current?.push(event),
			onConnectionChange: (state) => {
				setConnection(state === "open" ? "open" : state === "connecting" ? "connecting" : "disconnected");
			},
		});
		if (!transport) {
			setConnection("unavailable");
			return;
		}

		return () => {
			transport?.dispose();
			batcherRef.current?.flush(sessionId);
		};
	}, [sessionId, connect]);

	useEffect(() => {
		return () => {
			batcherRef.current?.dispose();
			batcherRef.current = null;
		};
	}, []);

	const respondToPermission = useCallback(
		async (requestId: string, optionId: string) => {
			if (!sessionId) throw new Error("No session");
			const payload: AgentPermissionResponse = { sessionId, requestId, optionId };
			if (respondPermission) {
				await respondPermission(payload);
			} else {
				await respondToAgentPermission(payload, fetch, getApiBaseUrl());
			}
			const next = resolveAgentStreamPermission(streamRef.current, requestId);
			streamRef.current = next;
			setStream(next);
		},
		[sessionId, respondPermission],
	);

	const requestCancel = useCallback(() => {
		const next = requestAgentStreamCancellation(streamRef.current);
		streamRef.current = next;
		setStream(next);
	}, []);

	const reset = useCallback((seed: StreamMessage[] = []) => {
		messagesRef.current = seed;
		streamRef.current = createAgentSessionStreamState();
		setMessages(seed);
		setStream(streamRef.current);
		setError("");
	}, []);

	return {
		messages,
		stream,
		streaming: isAgentStreamActive(stream),
		error,
		connection,
		pushEvents,
		respondToPermission,
		requestCancel,
		reset,
	};
}
