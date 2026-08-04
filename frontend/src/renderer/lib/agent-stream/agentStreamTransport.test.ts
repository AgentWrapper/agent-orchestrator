import { describe, expect, it, vi } from "vitest";
import {
	AGENT_STREAM_EVENT_NAME,
	connectAgentStream,
	parseAgentStreamSseData,
} from "./agentStreamTransport";

class EventSourceStub {
	static instances: EventSourceStub[] = [];
	url: string;
	onopen: ((ev: Event) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
	readyState = 0;
	closed = false;

	constructor(url: string) {
		this.url = url;
		EventSourceStub.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.(new Event("open"));
		});
	}

	addEventListener(type: string, listener: EventListener) {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener as (ev: MessageEvent) => void);
		this.listeners.set(type, set);
	}

	close() {
		this.closed = true;
		this.readyState = 2;
	}

	emit(type: string, data: string) {
		const ev = { data } as MessageEvent;
		if (type === "message") this.onmessage?.(ev);
		for (const listener of this.listeners.get(type) ?? []) listener(ev);
	}
}

describe("parseAgentStreamSseData", () => {
	it("parses JSON and fills missing sessionId", () => {
		const event = parseAgentStreamSseData(
			JSON.stringify({ type: "text_delta", sequence: 1, itemId: "a", delta: "hi" }),
			"session-1",
		);
		expect(event).toEqual(
			expect.objectContaining({ type: "text_delta", sessionId: "session-1", delta: "hi" }),
		);
	});

	it("returns null for garbage", () => {
		expect(parseAgentStreamSseData("not-json", "s")).toBeNull();
	});
});

describe("connectAgentStream", () => {
	it("subscribes to agent_stream frames and forwards parsed events", async () => {
		EventSourceStub.instances = [];
		const onEvent = vi.fn();
		const transport = connectAgentStream({
			sessionId: "session-1",
			baseUrl: "http://127.0.0.1:3001",
			EventSourceImpl: EventSourceStub as unknown as typeof EventSource,
			retryMs: 0,
			onEvent,
		});
		expect(transport).not.toBeNull();
		expect(EventSourceStub.instances[0].url).toBe(
			"http://127.0.0.1:3001/api/v1/sessions/session-1/agent-stream",
		);

		EventSourceStub.instances[0].emit(
			AGENT_STREAM_EVENT_NAME,
			JSON.stringify({
				type: "text_delta",
				sessionId: "session-1",
				sequence: 1,
				itemId: "r1",
				delta: "Hello",
			}),
		);
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "text_delta", delta: "Hello" }),
		);

		transport?.dispose();
		expect(EventSourceStub.instances[0].closed).toBe(true);
	});
});
