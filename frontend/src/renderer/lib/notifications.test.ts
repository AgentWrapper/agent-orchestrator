import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO, NotificationsCache } from "./notifications";

const {
	apiGetMock,
	getApiBaseUrlMock,
	onStatusMock,
	removeStatusMock,
	showNotificationMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
} = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	showNotificationMock: vi.fn(),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: { GET: apiGetMock },
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

import {
	createNotificationsTransport,
	fetchNotificationsPage,
	getCachedNotifications,
	getCachedUnreadCount,
	keepLatestNotificationsPage,
	markAllCachedNotificationsRead,
	markCachedNotificationRead,
	mergeUnreadNotification,
	NOTIFICATION_PAGE_SIZE,
	recentNotificationsQueryKey,
	unreadNotificationsQueryKey,
} from "./notifications";

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
		type: "needs_input",
		title: "checkout-flow needs input",
		body: "The agent is waiting for your response.",
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
	apiGetMock.mockReset();
	EventSourceStub.instances = [];
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	showNotificationMock.mockReset().mockResolvedValue(undefined);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
});

afterEach(() => {
	delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("notification cache helpers", () => {
	it.each([
		{ cursor: "previous", nextCursor: "older", status: "all" as const, unreadCount: 4 },
		{ cursor: "", nextCursor: undefined, status: "unread" as const, unreadCount: 1 },
	])("requests a bounded $status page", async ({ cursor, nextCursor, status, unreadCount }) => {
		apiGetMock.mockResolvedValue({
			data: { notifications: [notification()], nextCursor, unreadCount },
		});

		await expect(fetchNotificationsPage(status, cursor)).resolves.toEqual({
			notifications: [notification()],
			nextCursor,
			unreadCount,
		});

		expect(apiGetMock).toHaveBeenCalledWith("/api/v1/notifications", {
			params: {
				query: {
					cursor: cursor || undefined,
					limit: NOTIFICATION_PAGE_SIZE,
					status,
				},
			},
		});
	});

	it("merges unread notifications by id", () => {
		const qc = queryClient();

		expect(mergeUnreadNotification(qc, notification())).toBe(true);
		expect(mergeUnreadNotification(qc, notification())).toBe(false);

		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toHaveLength(1);
		expect(getCachedUnreadCount(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toBe(1);
	});

	it("removes acknowledged notifications from Unread and keeps them in All", () => {
		const qc = queryClient();
		const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
		mergeUnreadNotification(qc, notification());
		qc.setQueryData<NotificationsCache>(recentNotificationsQueryKey, {
			pageParams: [""],
			pages: [{ notifications: [notification()], unreadCount: 1 }],
		});
		markCachedNotificationRead(qc, notification({ status: "read" }));

		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toEqual([]);
		expect(getCachedUnreadCount(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toBe(0);
		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(recentNotificationsQueryKey))).toEqual([
			expect.objectContaining({ id: "ntf_1", status: "read" }),
		]);
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: unreadNotificationsQueryKey,
			exact: true,
			refetchType: "active",
		});

		mergeUnreadNotification(qc, notification({ id: "ntf_2" }));
		markAllCachedNotificationsRead(qc);
		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toEqual([]);
		expect(getCachedUnreadCount(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toBe(0);
	});

	it("deduplicates and updates notifications across cached pages", () => {
		const qc = queryClient();
		qc.setQueryData<NotificationsCache>(unreadNotificationsQueryKey, {
			pageParams: ["", "older"],
			pages: [
				{ notifications: [notification({ id: "new" })], nextCursor: "older", unreadCount: 2 },
				{ notifications: [notification({ id: "old" })], unreadCount: 2 },
			],
		});

		expect(mergeUnreadNotification(qc, notification({ id: "old", title: "updated" }))).toBe(false);
		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toHaveLength(2);
		expect(
			getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey)).find(
				(item) => item.id === "old",
			)?.title,
		).toBe("updated");
		expect(getCachedUnreadCount(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toBe(2);
	});

	it("caps and rebases the cache when live events grow the newest page past 100", () => {
		const qc = queryClient();
		const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
		const firstPage = Array.from({ length: NOTIFICATION_PAGE_SIZE }, (_, index) =>
			notification({ id: `ntf_${index + 1}` }),
		);
		qc.setQueryData<NotificationsCache>(unreadNotificationsQueryKey, {
			pageParams: [""],
			pages: [{ notifications: firstPage, unreadCount: firstPage.length }],
		});

		mergeUnreadNotification(qc, notification({ id: "ntf_live" }));

		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toHaveLength(
			NOTIFICATION_PAGE_SIZE,
		);
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: unreadNotificationsQueryKey,
			exact: true,
			refetchType: "active",
		});
	});

	it("drops older pages after the panel closes while keeping the latest page", () => {
		const qc = queryClient();
		qc.setQueryData<NotificationsCache>(unreadNotificationsQueryKey, {
			pageParams: ["", "older"],
			pages: [
				{ notifications: [notification({ id: "new" })], nextCursor: "older", unreadCount: 2 },
				{ notifications: [notification({ id: "old" })], unreadCount: 2 },
			],
		});

		keepLatestNotificationsPage(qc);

		const cache = qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey);
		expect(cache?.pages).toHaveLength(1);
		expect(getCachedNotifications(cache).map((item) => item.id)).toEqual(["new"]);
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
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: recentNotificationsQueryKey });
	});

	it("merges live notifications and shows one toast for a new id", () => {
		const qc = queryClient();
		createNotificationsTransport(qc).connect();
		const source = EventSourceStub.instances[0];

		source.dispatch("notification_created", notification());
		source.dispatch("notification_created", notification());

		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(unreadNotificationsQueryKey))).toHaveLength(1);
		expect(getCachedNotifications(qc.getQueryData<NotificationsCache>(recentNotificationsQueryKey))).toHaveLength(1);
		expect(showNotificationMock).toHaveBeenCalledTimes(1);
		expect(showNotificationMock).toHaveBeenCalledWith({
			id: "ntf_1",
			title: "checkout-flow needs input",
			body: "The agent is waiting for your response.",
		});
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
