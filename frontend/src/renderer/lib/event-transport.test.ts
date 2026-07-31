import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	onStatusMock,
	removeStatusMock,
	getApiBaseUrlMock,
	hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
} = vi.hoisted(() => ({
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	hasTrustedApiBaseUrlMock: vi.fn(() => true),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
}));

vi.mock("./bridge", () => ({
	aoBridge: {
		daemon: { onStatus: onStatusMock },
	},
}));

vi.mock("./api-client", () => ({
	getApiBaseUrl: getApiBaseUrlMock,
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrl: subscribeApiBaseUrlMock,
}));

import { createEventTransport } from "./event-transport";
import { getEventsConnectionState, setEventsConnectionState } from "./events-connection";

class EventSourceStub {
	static instances: EventSourceStub[] = [];
	url: string;
	closed = false;
	readyState = 0; // CONNECTING
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: (() => void) | null = null;
	listeners: string[] = [];
	handlers: Record<string, () => void> = {};
	constructor(url: string) {
		this.url = url;
		EventSourceStub.instances.push(this);
	}
	addEventListener(type: string, handler: () => void) {
		this.listeners.push(type);
		this.handlers[type] = handler;
	}
	emit(type: string) {
		this.handlers[type]?.();
	}
	close() {
		this.closed = true;
		this.readyState = 2; // CLOSED
	}
}

function fakeQueryClient() {
	return { invalidateQueries: vi.fn() } as unknown as Parameters<typeof createEventTransport>[0];
}

beforeEach(() => {
	EventSourceStub.instances = [];
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	setEventsConnectionState("idle");
	(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
});

afterEach(() => {
	delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("createEventTransport", () => {
	it("opens a single SSE connection to the current base URL on connect", () => {
		createEventTransport(fakeQueryClient()).connect();

		expect(EventSourceStub.instances).toHaveLength(1);
		expect(EventSourceStub.instances[0].url).toBe("http://127.0.0.1:3001/api/v1/events");
		// All CDC event types plus onmessage are wired up.
		expect(EventSourceStub.instances[0].listeners).toContain("session_updated");
		expect(EventSourceStub.instances[0].onmessage).toBeTypeOf("function");
	});

	it("invalidates the pipelines-enabled capability probe on a daemon status change", () => {
		const queryClient = fakeQueryClient();
		createEventTransport(queryClient).connect();
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		onStatusHandler();

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pipelines-enabled"] });
	});

	it("does not reconnect when a daemon status keeps the same base URL", () => {
		createEventTransport(fakeQueryClient()).connect();
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		onStatusHandler();

		expect(EventSourceStub.instances).toHaveLength(1);
	});

	it("closes the old connection and reconnects when the base URL changes", () => {
		createEventTransport(fakeQueryClient()).connect();
		const first = EventSourceStub.instances[0];
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:3099");
		onStatusHandler();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(2);
		expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:3099/api/v1/events");
	});

	it("closes the source and skips reconnecting when the base URL is untrusted", () => {
		createEventTransport(fakeQueryClient()).connect();
		const first = EventSourceStub.instances[0];
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		hasTrustedApiBaseUrlMock.mockReturnValue(false);
		onStatusHandler();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(1);
		expect(getEventsConnectionState()).toBe("disconnected");
	});

	it("debounces workspace and SCM summary invalidation after a status change", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

			onStatusHandler();
			// The pipelines-enabled re-probe fires synchronously (it is a cheap,
			// one-shot capability check); workspace/SCM invalidation is debounced.
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pipelines-enabled"] });
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspaces"] });
			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-scm-summary"] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidates the pipeline query family on a pipeline_* event, debounced", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			const source = EventSourceStub.instances[0];
			// All four pipeline event types are subscribed alongside the CDC ones.
			expect(source.listeners).toContain("pipeline_run_updated");
			expect(source.listeners).toContain("pipeline_stage_run_updated");
			expect(source.listeners).toContain("pipeline_artifact_updated");
			expect(source.listeners).toContain("pipeline_definition_changed");

			source.emit("pipeline_run_updated");
			expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
			vi.advanceTimersByTime(200);

			const call = (queryClient.invalidateQueries as ReturnType<typeof vi.fn>).mock.calls.find(
				(args) => typeof (args[0] as { predicate?: unknown })?.predicate === "function",
			);
			expect(call).toBeTruthy();
			const predicate = (call![0] as { predicate: (q: { queryKey: readonly unknown[] }) => boolean }).predicate;
			expect(predicate({ queryKey: ["pipeline-runs", "proj-1"] })).toBe(true);
			expect(predicate({ queryKey: ["pipeline-run", "run-1"] })).toBe(true);
			expect(predicate({ queryKey: ["workspaces"] })).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("tears down the source and the daemon listener on disconnect", () => {
		const disconnect = createEventTransport(fakeQueryClient()).connect();

		disconnect();

		expect(EventSourceStub.instances[0].closed).toBe(true);
		expect(removeStatusMock).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when EventSource is unavailable", () => {
		delete (globalThis as unknown as { EventSource?: unknown }).EventSource;

		expect(() => createEventTransport(fakeQueryClient()).connect()).not.toThrow();
		expect(EventSourceStub.instances).toHaveLength(0);
	});

	it("marks the stream connected on open and disconnected on error", () => {
		createEventTransport(fakeQueryClient()).connect();
		const source = EventSourceStub.instances[0];

		source.readyState = 1; // OPEN
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");

		source.readyState = 0; // CONNECTING — browser is auto-retrying
		source.onerror?.();
		expect(getEventsConnectionState()).toBe("disconnected");

		source.readyState = 1;
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");
	});

	it("rebuilds a source the browser abandoned after the retry delay", () => {
		vi.useFakeTimers();
		try {
			createEventTransport(fakeQueryClient()).connect();
			const source = EventSourceStub.instances[0];

			source.readyState = 2; // CLOSED — EventSource gave up for good
			source.onerror?.();

			expect(EventSourceStub.instances).toHaveLength(1);
			vi.advanceTimersByTime(5_000);
			expect(EventSourceStub.instances).toHaveLength(2);
			expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:3001/api/v1/events");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects when the API base URL changes out-of-band", () => {
		createEventTransport(fakeQueryClient()).connect();
		expect(subscribeApiBaseUrlMock).toHaveBeenCalledTimes(1);
		const onBaseUrlChange = subscribeApiBaseUrlMock.mock.calls[0][0] as () => void;
		const first = EventSourceStub.instances[0];

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:4555");
		onBaseUrlChange();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(2);
		expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:4555/api/v1/events");
	});

	it("resets the connection state and unsubscribes on disconnect", () => {
		const disconnect = createEventTransport(fakeQueryClient()).connect();
		const source = EventSourceStub.instances[0];
		source.readyState = 1;
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");

		disconnect();

		expect(getEventsConnectionState()).toBe("idle");
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});
});
