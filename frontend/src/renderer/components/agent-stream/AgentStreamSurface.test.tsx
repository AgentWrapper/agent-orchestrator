import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentStreamSurface } from "./AgentStreamSurface";
import { AgentStreamTimeline, groupStreamMessages } from "./AgentStreamTimeline";
import { createAgentSessionStreamState } from "../../lib/agent-stream";
import type { UseAgentStreamResult } from "../../hooks/useAgentStream";
import type { StreamMessage } from "../../types/streamMessages";

function mockAgentStream(partial: Partial<UseAgentStreamResult> = {}): UseAgentStreamResult {
	return {
		messages: [],
		stream: createAgentSessionStreamState(),
		streaming: false,
		error: "",
		connection: "idle",
		pushEvents: vi.fn(),
		respondToPermission: vi.fn().mockResolvedValue(undefined),
		requestCancel: vi.fn(),
		reset: vi.fn(),
		...partial,
	};
}

describe("groupStreamMessages", () => {
	it("pairs tool_use with tool_result", () => {
		const messages: StreamMessage[] = [
			{ role: "assistant", content: "hi", partial: false },
			{ role: "tool_use", content: "Read", toolUseId: "t1", toolName: "Read", partial: true },
			{ role: "tool_result", content: "ok", toolUseId: "t1", toolResult: "ok", partial: false },
		];
		const items = groupStreamMessages(messages);
		expect(items).toHaveLength(2);
		expect(items[0].kind).toBe("text");
		expect(items[1].kind).toBe("tool");
		if (items[1].kind === "tool") {
			expect(items[1].call?.toolUseId).toBe("t1");
			expect(items[1].result?.toolResult).toBe("ok");
		}
	});
});

describe("AgentStreamTimeline", () => {
	it("renders assistant text and thinking", () => {
		render(
			<AgentStreamTimeline
				messages={[
					{ role: "thinking", content: "plan", isThinking: true, partial: true },
					{ role: "assistant", content: "Hello", partial: true },
				]}
				streaming
			/>,
		);
		expect(screen.getByTestId("stream-thinking")).toHaveTextContent("plan");
		expect(screen.getByTestId("stream-assistant")).toHaveTextContent("Hello");
	});

	it("renders tool card status", () => {
		render(
			<AgentStreamTimeline
				messages={[
					{
						role: "tool_use",
						content: "shell",
						toolUseId: "t1",
						toolName: "Bash",
						toolStatus: "completed",
						partial: false,
					},
					{
						role: "tool_result",
						content: "done",
						toolUseId: "t1",
						toolResult: "done",
						partial: false,
					},
				]}
			/>,
		);
		expect(screen.getByTestId("stream-tool")).toHaveAttribute("data-tool-status", "completed");
		fireEvent.click(screen.getByRole("button", { name: /Bash/i }));
		expect(screen.getByText("done")).toBeTruthy();
	});
});

describe("AgentStreamSurface", () => {
	it("shows permission panel and forwards option clicks", async () => {
		const respondToPermission = vi.fn().mockResolvedValue(undefined);
		const stream = {
			...createAgentSessionStreamState(),
			phase: "waiting_permission" as const,
			permission: {
				requestId: "req-1",
				title: "Allow shell?",
				options: [{ optionId: "allow", label: "Allow once", kind: "allow_once" as const }],
			},
		};
		render(
			<AgentStreamSurface
				agentStream={mockAgentStream({
					stream,
					streaming: true,
					respondToPermission,
				})}
			/>,
		);
		expect(screen.getByTestId("agent-activity-panel")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
		expect(respondToPermission).toHaveBeenCalledWith("req-1", "allow");
	});

	it("renders stop while streaming", () => {
		const requestCancel = vi.fn();
		render(
			<AgentStreamSurface
				agentStream={mockAgentStream({
					streaming: true,
					stream: { phase: "running", lastSequence: 1 },
					requestCancel,
				})}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(requestCancel).toHaveBeenCalled();
	});
});
