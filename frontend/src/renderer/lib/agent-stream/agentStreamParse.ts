/**
 * Parse and validate normalized agent-stream envelopes from the daemon.
 *
 * The renderer never speaks raw ACP. Events arrive as JSON (SSE `data:` frames
 * or HTTP poll payloads) and must match AgentStreamEvent before reduce.
 */

import type { AgentPermissionResponse, AgentStreamEvent } from "../../types/agentStreamTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentStreamEvent(value: unknown): AgentStreamEvent | null {
	if (
		!isRecord(value) ||
		typeof value.sessionId !== "string" ||
		!Number.isSafeInteger(value.sequence) ||
		Number(value.sequence) < 0
	) {
		return null;
	}
	if (typeof value.type !== "string") return null;

	switch (value.type) {
		case "text_delta":
			return typeof value.itemId === "string" && typeof value.delta === "string"
				? (value as unknown as AgentStreamEvent)
				: null;
		case "thinking_update":
			return typeof value.itemId === "string" &&
				typeof value.text === "string" &&
				(value.mode === undefined || value.mode === "delta" || value.mode === "replace")
				? (value as unknown as AgentStreamEvent)
				: null;
		case "tool_call":
			return typeof value.toolCallId === "string" && typeof value.title === "string"
				? (value as unknown as AgentStreamEvent)
				: null;
		case "tool_update":
			return typeof value.toolCallId === "string" &&
				["pending", "in_progress", "completed", "failed"].includes(String(value.status))
				? (value as unknown as AgentStreamEvent)
				: null;
		case "plan":
			return Array.isArray(value.entries) &&
				value.entries.every(
					(entry) =>
						isRecord(entry) &&
						typeof entry.id === "string" &&
						typeof entry.title === "string" &&
						["pending", "in_progress", "completed", "blocked"].includes(String(entry.status)),
				)
				? (value as unknown as AgentStreamEvent)
				: null;
		case "status":
			return ["starting", "running", "waiting", "idle"].includes(String(value.status))
				? (value as unknown as AgentStreamEvent)
				: null;
		case "permission_request":
			return isRecord(value.request) &&
				typeof value.request.requestId === "string" &&
				typeof value.request.title === "string" &&
				Array.isArray(value.request.options) &&
				value.request.options.length > 0 &&
				value.request.options.every(
					(option) =>
						isRecord(option) &&
						typeof option.optionId === "string" &&
						typeof option.label === "string" &&
						["allow_once", "allow_always", "reject_once", "reject_always"].includes(
							String(option.kind),
						),
				)
				? (value as unknown as AgentStreamEvent)
				: null;
		case "done":
		case "cancelled":
			return value as unknown as AgentStreamEvent;
		case "error":
			return typeof value.message === "string" ? (value as unknown as AgentStreamEvent) : null;
		default:
			return null;
	}
}

/**
 * Provisional daemon route for permission responses.
 * Backend must implement this (or supersede with OpenAPI) before live ACP chat.
 *
 * POST /api/v1/sessions/{sessionId}/agent-stream/permissions/{requestId}
 * body: { optionId: string }
 */
export const AGENT_STREAM_PERMISSION_PATH =
	"/api/v1/sessions/{sessionId}/agent-stream/permissions/{requestId}" as const;

/**
 * Provisional SSE path for sequenced agent-stream events.
 * GET /api/v1/sessions/{sessionId}/agent-stream
 * event: agent_stream
 * data: AgentStreamEvent JSON
 */
export const AGENT_STREAM_SSE_PATH = "/api/v1/sessions/{sessionId}/agent-stream" as const;

export type PermissionRespondFn = (response: AgentPermissionResponse) => Promise<void>;

/**
 * Default permission responder via daemon HTTP.
 * Throws a clear error when the route is unavailable so the UI can keep the prompt open.
 */
export async function respondToAgentPermission(
	response: AgentPermissionResponse,
	fetchImpl: typeof fetch = fetch,
	baseUrl?: string,
): Promise<void> {
	const root = (baseUrl ?? "").replace(/\/+$/, "");
	const path = `/api/v1/sessions/${encodeURIComponent(response.sessionId)}/agent-stream/permissions/${encodeURIComponent(response.requestId)}`;
	const url = root ? `${root}${path}` : path;
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ optionId: response.optionId }),
	});
	if (!res.ok) {
		let detail = res.statusText;
		try {
			const body = (await res.json()) as { error?: { message?: string }; message?: string };
			detail = body.error?.message ?? body.message ?? detail;
		} catch {
			// ignore JSON parse failures
		}
		throw new Error(detail || `Permission response failed (${res.status})`);
	}
}
