import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "./notifications";

const {
	getApiBaseUrlMock,
	onStatusMock,
	removeStatusMock,
	showNotificationMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
	hasElectronBridgeMock,
} = vi.hoisted(() => ({
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	showNotificationMock: vi.fn(),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
	hasElectronBridgeMock: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: {},
	apiErrorMessage: () => "Request failed",
	getApiBaseUrl: getApiBaseUrlMock,
	subscribeApiBaseUrl: subscribeApiBaseUrlMock,
}));

vi.mock("./bridge", () => ({
	aoBridge: {
		daemon: { onStatus: onStatusMock },
		notifications: { show: showNotificationMock },
	},
}));

vi.mock("./runtime-environment", () => ({
	hasElectronBridge: hasElectronBridgeMock,
}));

import { createNotificationsTransport, mergeUnreadNotification, unreadNotificationsQueryKey } from "./notifications";

class EventSourceStub {
	static instances: EventSourceStub[] = [];
	url: string;
	closed = false;
	readyState = 0;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	listeners = new Map<string, (event: MessageEvent<string>) => void>();

	constructor(url: string) {
		this.url = url;
		EventSourceStub.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener) {
		this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
	}

	dispatch(type: string, data: unknown) {
		this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
	}

	close() {
		this.closed = true;
		this.readyState = 2;
	}
}

function notification(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
	return {
		id: "ntf_1",
		sessionId: "mer-1",
		projectId: "mer",
		prUrl: "",
		headSha: "",
		type: "needs_input",
		subject: { kind: "session", id: "mer-1" },
		title: "checkout-flow needs input",
		body: "The agent is waiting for your response.",
		sensitive: false,
		changedPaths: [],
		status: "unread",
		createdAt: "2026-06-16T10:00:00Z",
		target: { kind: "session", sessionId: "mer-1" },
		...overrides,
	};
}

function queryClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
	EventSourceStub.instances = [];
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	showNotificationMock.mockReset().mockResolvedValue(undefined);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	hasElectronBridgeMock.mockReset().mockReturnValue(true);
	(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
});

afterEach(() => {
	delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("notification cache helpers", () => {
	it("merges unread notifications by id", () => {
		const qc = queryClient();

		expect(mergeUnreadNotification(qc, notification())).toBe(true);
		expect(mergeUnreadNotification(qc, notification())).toBe(false);

		expect(qc.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey)).toHaveLength(1);
	});
});

describe("createNotificationsTransport", () => {
	it("opens the notification stream and invalidates unread notifications on open", () => {
		const qc = queryClient();
		const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

		createNotificationsTransport(qc).connect();
		EventSourceStub.instances[0].onopen?.();

		expect(EventSourceStub.instances).toHaveLength(1);
		expect(EventSourceStub.instances[0].url).toBe("http://127.0.0.1:3001/api/v1/notifications/stream");
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: unreadNotificationsQueryKey });
	});

	it("merges live notifications and shows one toast for a new id", () => {
		const qc = queryClient();
		createNotificationsTransport(qc).connect();
		const source = EventSourceStub.instances[0];

		source.dispatch("notification_created", notification());
		source.dispatch("notification_created", notification());

		expect(qc.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey)).toHaveLength(1);
		expect(showNotificationMock).toHaveBeenCalledTimes(1);
		expect(showNotificationMock).toHaveBeenCalledWith({
			id: "ntf_1",
			title: "checkout-flow needs input",
			body: "The agent is waiting for your response.",
		});
	});

	it("keeps browser-mode notifications in NotificationCenter without native toasts", () => {
		hasElectronBridgeMock.mockReturnValue(false);
		const qc = queryClient();
		createNotificationsTransport(qc).connect();
		const source = EventSourceStub.instances[0];

		source.dispatch("notification_created", notification());

		expect(qc.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey)).toHaveLength(1);
		expect(showNotificationMock).not.toHaveBeenCalled();
	});

	it("reconnects when the API base URL changes", () => {
		createNotificationsTransport(queryClient()).connect();
		const onBaseUrlChange = subscribeApiBaseUrlMock.mock.calls[0][0] as () => void;
		const first = EventSourceStub.instances[0];

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:4555");
		onBaseUrlChange();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(2);
		expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:4555/api/v1/notifications/stream");
	});
});
