import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { aoBridge } from "./bridge";
import { apiClient, apiErrorMessage, getApiBaseUrl, subscribeApiBaseUrl } from "./api-client";

export type NotificationDTO = components["schemas"]["NotificationResponse"];
export type NotificationsPage = components["schemas"]["ListNotificationsResponse"];
export type NotificationsCache = InfiniteData<NotificationsPage>;
export type NotificationListStatus = "unread" | "all";

export const unreadNotificationsQueryKey = ["notifications", "history", "unread"] as const;
export const recentNotificationsQueryKey = ["notifications", "history", "all"] as const;
export const NOTIFICATION_PAGE_SIZE = 100;

const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;

type NotificationsQueryKey = typeof unreadNotificationsQueryKey | typeof recentNotificationsQueryKey;

export function notificationsQueryKey(status: NotificationListStatus): NotificationsQueryKey {
	return status === "unread" ? unreadNotificationsQueryKey : recentNotificationsQueryKey;
}

export async function fetchNotificationsPage(status: NotificationListStatus, cursor = ""): Promise<NotificationsPage> {
	const { data, error } = await apiClient.GET("/api/v1/notifications", {
		params: {
			query: {
				status,
				limit: NOTIFICATION_PAGE_SIZE,
				cursor: cursor || undefined,
			},
		},
	});
	if (error) throw new Error(apiErrorMessage(error, "Could not load notifications"));
	const notifications = sortNotifications(data?.notifications ?? []);
	return {
		notifications,
		nextCursor: data?.nextCursor,
		unreadCount: data?.unreadCount ?? notifications.filter((item) => item.status === "unread").length,
	};
}

export async function markNotificationRead(id: string): Promise<NotificationDTO> {
	const { data, error } = await apiClient.PATCH("/api/v1/notifications/{id}", {
		params: { path: { id } },
		body: { status: "read" },
	});
	if (error) throw new Error(apiErrorMessage(error, "Could not mark notification read"));
	if (!data?.notification) throw new Error("Notification update returned no notification");
	return data.notification;
}

export async function markAllNotificationsRead(): Promise<number> {
	const { data, error } = await apiClient.POST("/api/v1/notifications/read-all");
	if (error) throw new Error(apiErrorMessage(error, "Could not mark notifications read"));
	return data?.updatedCount ?? 0;
}

export function mergeUnreadNotification(queryClient: QueryClient, notification: NotificationDTO): boolean {
	if (notification.status !== "unread") return false;
	const inserted = mergeNotificationIntoCache(queryClient, unreadNotificationsQueryKey, notification);
	rebaseOversizedFirstPage(queryClient, unreadNotificationsQueryKey);
	return inserted;
}

function mergeRecentNotification(queryClient: QueryClient, notification: NotificationDTO): boolean {
	const inserted = mergeNotificationIntoCache(queryClient, recentNotificationsQueryKey, notification);
	rebaseOversizedFirstPage(queryClient, recentNotificationsQueryKey);
	return inserted;
}

function mergeNotificationIntoCache(
	queryClient: QueryClient,
	queryKey: NotificationsQueryKey,
	notification: NotificationDTO,
): boolean {
	let inserted = false;
	queryClient.setQueryData<NotificationsCache>(queryKey, (current) => {
		if (!current || current.pages.length === 0) {
			inserted = true;
			return {
				pageParams: [""],
				pages: [
					{
						notifications: [notification],
						unreadCount: notification.status === "unread" ? 1 : 0,
					},
				],
			};
		}

		const existing = getCachedNotifications(current).find((item) => item.id === notification.id);
		const unreadDelta = (notification.status === "unread" ? 1 : 0) - (existing?.status === "unread" ? 1 : 0);
		const pages = current.pages.map((page) => ({
			...page,
			notifications: page.notifications.map((item) => (item.id === notification.id ? notification : item)),
			unreadCount: Math.max(0, page.unreadCount + unreadDelta),
		}));

		if (existing) {
			return { ...current, pages };
		}

		inserted = true;
		pages[0] = {
			...pages[0],
			notifications: sortNotifications([notification, ...pages[0].notifications]),
		};
		return { ...current, pages };
	});
	return inserted;
}

export function markCachedNotificationRead(queryClient: QueryClient, notification: NotificationDTO): void {
	removeReadNotificationFromUnreadCache(queryClient, notification.id);
	updateReadNotificationInRecentCache(queryClient, notification);
	void queryClient.invalidateQueries({
		queryKey: unreadNotificationsQueryKey,
		exact: true,
		refetchType: "active",
	});
}

export function markAllCachedNotificationsRead(queryClient: QueryClient): void {
	queryClient.setQueryData<NotificationsCache>(unreadNotificationsQueryKey, (current) => {
		if (!current) return current;
		return {
			pageParams: [""],
			pages: [{ notifications: [], unreadCount: 0 }],
		};
	});
	queryClient.setQueryData<NotificationsCache>(recentNotificationsQueryKey, (current) => {
		if (!current) return current;
		return {
			...current,
			pages: current.pages.map((page) => ({
				...page,
				notifications: page.notifications.map((item) => (item.status === "read" ? item : { ...item, status: "read" })),
				unreadCount: 0,
			})),
		};
	});
}

export function getCachedNotifications(cache: NotificationsCache | undefined): NotificationDTO[] {
	if (!cache) return [];
	const byID = new Map<string, NotificationDTO>();
	for (const page of cache.pages) {
		for (const notification of page.notifications) {
			if (!byID.has(notification.id)) byID.set(notification.id, notification);
		}
	}
	return sortNotifications([...byID.values()]);
}

export function getCachedUnreadCount(cache: NotificationsCache | undefined): number {
	return (
		cache?.pages[0]?.unreadCount ?? getCachedNotifications(cache).filter((item) => item.status === "unread").length
	);
}

export function keepLatestNotificationsPage(
	queryClient: QueryClient,
	queryKey: NotificationsQueryKey = unreadNotificationsQueryKey,
): void {
	queryClient.setQueryData<NotificationsCache>(queryKey, (current) => {
		if (!current || current.pages.length <= 1) return current;
		return {
			pages: [current.pages[0]],
			pageParams: [current.pageParams[0]],
		};
	});
	rebaseOversizedFirstPage(queryClient, queryKey);
}

export function createNotificationsTransport(queryClient: QueryClient) {
	return {
		connect() {
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let source: EventSource | undefined;
			let sourceBaseUrl: string | undefined;

			const invalidateNotifications = () => {
				void queryClient.invalidateQueries({ queryKey: unreadNotificationsQueryKey });
				void queryClient.invalidateQueries({ queryKey: recentNotificationsQueryKey });
			};

			const scheduleRetry = () => {
				if (retryTimer) return;
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					connectSource();
				}, SSE_RETRY_MS);
			};

			const connectSource = () => {
				if (typeof EventSource === "undefined") return;
				const baseUrl = getApiBaseUrl();
				if (source && sourceBaseUrl === baseUrl && source.readyState !== EVENTSOURCE_CLOSED) return;
				source?.close();
				source = undefined;
				sourceBaseUrl = baseUrl;
				try {
					source = new EventSource(`${baseUrl.replace(/\/+$/, "")}/api/v1/notifications/stream`);
					source.onopen = invalidateNotifications;
					source.onerror = () => {
						if (source?.readyState === EVENTSOURCE_CLOSED) scheduleRetry();
					};
					source.addEventListener("notification_created", (event) => {
						const notification = parseNotificationEvent(event);
						if (!notification) return;
						const inserted = mergeUnreadNotification(queryClient, notification);
						mergeRecentNotification(queryClient, notification);
						if (inserted) {
							void aoBridge.notifications.show({
								id: notification.id,
								title: notification.title,
								body: notification.body || undefined,
							});
						}
					});
				} catch {
					source = undefined;
				}
			};

			const removeDaemonListener = aoBridge.daemon.onStatus(() => {
				connectSource();
				invalidateNotifications();
			});
			const removeBaseUrlListener = subscribeApiBaseUrl(() => {
				connectSource();
				invalidateNotifications();
			});
			connectSource();

			return () => {
				if (retryTimer) clearTimeout(retryTimer);
				removeDaemonListener();
				removeBaseUrlListener();
				source?.close();
			};
		},
	};
}

function parseNotificationEvent(event: Event): NotificationDTO | null {
	const data = (event as MessageEvent<string>).data;
	if (typeof data !== "string" || data === "") return null;
	try {
		return JSON.parse(data) as NotificationDTO;
	} catch {
		return null;
	}
}

function sortNotifications(notifications: NotificationDTO[]): NotificationDTO[] {
	return [...notifications].sort((a, b) => {
		const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
		return byTime || b.id.localeCompare(a.id);
	});
}

function removeReadNotificationFromUnreadCache(queryClient: QueryClient, id: string): void {
	queryClient.setQueryData<NotificationsCache>(unreadNotificationsQueryKey, (current) => {
		if (!current) return current;
		return {
			...current,
			pages: current.pages.map((page) => ({
				...page,
				notifications: page.notifications.filter((item) => item.id !== id),
				unreadCount: Math.max(0, page.unreadCount - 1),
			})),
		};
	});
}

function updateReadNotificationInRecentCache(queryClient: QueryClient, notification: NotificationDTO): void {
	queryClient.setQueryData<NotificationsCache>(recentNotificationsQueryKey, (current) => {
		if (!current) return current;
		const existing = getCachedNotifications(current).find((item) => item.id === notification.id);
		return {
			...current,
			pages: current.pages.map((page) => ({
				...page,
				notifications: page.notifications.map((item) => (item.id === notification.id ? notification : item)),
				unreadCount: Math.max(0, page.unreadCount - (existing?.status === "read" ? 0 : 1)),
			})),
		};
	});
}

function rebaseOversizedFirstPage(queryClient: QueryClient, queryKey: NotificationsQueryKey): void {
	const cache = queryClient.getQueryData<NotificationsCache>(queryKey);
	if (!cache || cache.pages[0]?.notifications.length <= NOTIFICATION_PAGE_SIZE) return;
	const query = queryClient.getQueryCache().find({ queryKey, exact: true });
	if (!query?.isActive()) {
		queryClient.setQueryData<NotificationsCache>(queryKey, (current) => {
			if (!current?.pages[0]) return current;
			return {
				...current,
				pages: [
					{
						...current.pages[0],
						notifications: current.pages[0].notifications.slice(0, NOTIFICATION_PAGE_SIZE),
					},
					...current.pages.slice(1),
				],
			};
		});
	}
	void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
}
