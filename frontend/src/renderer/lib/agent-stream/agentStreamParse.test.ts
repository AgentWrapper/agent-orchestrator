import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseAgentStreamEvent,
	respondToAgentPermission,
} from "./agentStreamParse";

describe("parseAgentStreamEvent", () => {
	it("accepts normalized events without provider-specific fields", () => {
		expect(
			parseAgentStreamEvent({
				type: "tool_call",
				sessionId: "session-1",
				sequence: 3,
				toolCallId: "call-1",
				title: "Read configuration",
				source: { kind: "native-acp-v1" },
			}),
		).toEqual(expect.objectContaining({ type: "tool_call", toolCallId: "call-1" }));
	});

	it("rejects malformed permission prompts and unsupported events", () => {
		expect(
			parseAgentStreamEvent({
				type: "permission_request",
				sessionId: "session-1",
				sequence: 4,
				request: { requestId: "request-1", title: "Approve?", options: [] },
			}),
		).toBeNull();
		expect(
			parseAgentStreamEvent({ type: "codex_output", sessionId: "session-1", sequence: 5 }),
		).toBeNull();
	});
});

describe("respondToAgentPermission", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs optionId to the provisional daemon route", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({}),
		});
		await respondToAgentPermission(
			{ sessionId: "session-1", requestId: "request-1", optionId: "allow-once" },
			fetchImpl as unknown as typeof fetch,
			"http://127.0.0.1:3001",
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:3001/api/v1/sessions/session-1/agent-stream/permissions/request-1",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ optionId: "allow-once" }),
			}),
		);
	});

	it("throws when the daemon rejects the choice", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			json: async () => ({ error: { message: "route not implemented" } }),
		});
		await expect(
			respondToAgentPermission(
				{ sessionId: "s", requestId: "r", optionId: "allow" },
				fetchImpl as unknown as typeof fetch,
				"http://127.0.0.1:3001",
			),
		).rejects.toThrow(/route not implemented/);
	});
});
