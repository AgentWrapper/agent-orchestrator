/**
 * SSE transport for normalized agent-stream events.
 *
 * Mirrors AO's workspace-file-events / CDC EventSource patterns: reconnect on
 * CLOSED, ignore malformed frames, never depend on ACP SDK.
 *
 * Backend contract (not yet on main OpenAPI — see docs/acp-renderer-streaming.md):
 *   GET {baseUrl}/api/v1/sessions/{sessionId}/agent-stream
 *   Named event: agent_stream (or default message) with JSON AgentStreamEvent body.
 */

import { getApiBaseUrl, hasTrustedApiBaseUrl } from "../api-client";
import type { AgentStreamEvent } from "../../types/agentStreamTypes";
import { parseAgentStreamEvent } from "./agentStreamParse";

const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;
export const AGENT_STREAM_EVENT_NAME = "agent_stream";

export type AgentStreamTransportHandlers = {
	onEvent: (event: AgentStreamEvent) => void;
	onConnectionChange?: (state: "connecting" | "open" | "disconnected") => void;
	onParseError?: (raw: string, error: unknown) => void;
};

export type AgentStreamTransport = {
	/** Close the stream and cancel reconnects. */
	dispose: () => void;
};

export type AgentStreamTransportOptions = AgentStreamTransportHandlers & {
	sessionId: string;
	/** Override base URL (tests). Defaults to trusted API base. */
	baseUrl?: string;
	/** Inject EventSource for tests. */
	EventSourceImpl?: typeof EventSource;
	/** Disable auto-reconnect (tests). */
	retryMs?: number;
};

function buildStreamUrl(baseUrl: string, sessionId: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/api/v1/sessions/${encodeURIComponent(sessionId)}/agent-stream`;
}

function handleMessageData(
	raw: string,
	handlers: AgentStreamTransportHandlers,
	sessionId: string,
): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		handlers.onParseError?.(raw, error);
		return;
	}
	// Allow envelopes that omit sessionId by filling from the subscription.
	if (typeof parsed === "object" && parsed !== null) {
		const record = parsed as { sessionId?: unknown };
		if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
			record.sessionId = sessionId;
		}
	}
	const event = parseAgentStreamEvent(parsed);
	if (!event) {
		handlers.onParseError?.(raw, new Error("invalid agent stream event"));
		return;
	}
	// Drop frames for other sessions if the daemon multiplexes (defensive).
	if (event.sessionId !== sessionId) return;
	handlers.onEvent(event);
}

/**
 * Open a sequenced agent-stream SSE subscription for one session.
 * Returns null when EventSource is unavailable or the API base is untrusted
 * (no daemon yet) — callers should treat that as transport not ready.
 */
export function connectAgentStream(options: AgentStreamTransportOptions): AgentStreamTransport | null {
	const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource;
	if (typeof EventSourceImpl === "undefined") return null;

	const baseUrl = options.baseUrl ?? (hasTrustedApiBaseUrl() ? getApiBaseUrl() : "");
	if (!baseUrl) {
		options.onConnectionChange?.("disconnected");
		return null;
	}

	const retryMs = options.retryMs ?? SSE_RETRY_MS;
	let disposed = false;
	let source: EventSource | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	const clearRetry = () => {
		if (retryTimer !== undefined) {
			clearTimeout(retryTimer);
			retryTimer = undefined;
		}
	};

	const attach = (es: EventSource) => {
		es.onopen = () => {
			if (!disposed) options.onConnectionChange?.("open");
		};
		es.onerror = () => {
			if (disposed) return;
			options.onConnectionChange?.("disconnected");
			if (es.readyState === EVENTSOURCE_CLOSED) {
				es.close();
				if (source === es) source = undefined;
				scheduleRetry();
			}
		};
		const onData = (ev: MessageEvent<string>) => {
			if (disposed || typeof ev.data !== "string") return;
			handleMessageData(ev.data, options, options.sessionId);
		};
		// Named event preferred; also listen to default message for simpler servers.
		es.addEventListener(AGENT_STREAM_EVENT_NAME, onData as EventListener);
		es.onmessage = onData;
	};

	const scheduleRetry = () => {
		if (disposed || retryMs <= 0 || retryTimer !== undefined) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			connect();
		}, retryMs);
	};

	const connect = () => {
		if (disposed) return;
		clearRetry();
		source?.close();
		options.onConnectionChange?.("connecting");
		const es = new EventSourceImpl(buildStreamUrl(baseUrl, options.sessionId));
		source = es;
		attach(es);
	};

	connect();

	return {
		dispose() {
			disposed = true;
			clearRetry();
			source?.close();
			source = undefined;
			options.onConnectionChange?.("disconnected");
		},
	};
}

/** Pure helper for tests: parse one SSE data payload. */
export function parseAgentStreamSseData(raw: string, sessionId: string): AgentStreamEvent | null {
	const handlers: { event?: AgentStreamEvent } = {};
	handleMessageData(
		raw,
		{
			onEvent: (event) => {
				handlers.event = event;
			},
		},
		sessionId,
	);
	return handlers.event ?? null;
}
