import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { aoBridge } from "./bridge";
import { apiClient, apiErrorMessage, getApiBaseUrl, subscribeApiBaseUrl } from "./api-client";

export type NotificationDTO = components["schemas"]["NotificationResponse"];
export type NotificationsPage = components["schemas"]["ListNotificationsResponse"];
export type NotificationsCache = InfiniteData<NotificationsPage>;
export type NotificationListStatus = "unread" | "all" | "unresolved";

export const unreadNotificationsQueryKey = ["notifications", "history", "unread"] as const;
export const recentNotificationsQueryKey = ["notifications", "history", "all"] as const;
export const unresolvedNotificationsQueryKey = ["notifications", "history", "unresolved"] as const;
export const NOTIFICATION_PAGE_SIZE = 100;

const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;

/**
 * Only these two kinds describe something still waiting on the user, so only
 * they can sit in the unresolved list. `pr_merged` / `pr_closed_unmerged` report
 * something that already happened: worth seeing once, never worth resolving.
 * Mirrors NotificationType.NeedsResolution on the backend.
 */
const UNRESOLVABLE_TYPES = new Set(["needs_input", "ready_to_merge"]);

type NotificationsQueryKey =
	| typeof unreadNotificationsQueryKey
	| typeof recentNotificationsQueryKey
	| typeof unresolvedNotificationsQueryKey;

export function notificationsQueryKey(status: NotificationListStatus): NotificationsQueryKey {
	if (status === "unread") return unreadNotificationsQueryKey;
	if (status === "unresolved") return unresolvedNotificationsQueryKey;
	return recentNotificationsQueryKey;
}

function isUnresolved(notification: NotificationDTO): boolean {
	return UNRESOLVABLE_TYPES.has(notification.type) && !notification.resolvedAt;
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
		unresolvedCount: data?.unresolvedCount ?? notifications.filter(isUnresolved).length,
	};
}

/**
 * Fired when the panel opens — seeing the notifications is the acknowledgement.
 *
 * Scoped to the ids actually rendered. Acknowledging every unread row on the
 * server would strand anything past the loaded page: the panel never held a
 * cursor for it, and terminal types are not reachable through Unresolved.
 */
export async function markAllNotificationsRead(ids: string[]): Promise<number> {
	const { data, error } = await apiClient.POST("/api/v1/notifications/read-all", { body: { ids } });
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

function mergeUnresolvedNotification(queryClient: QueryClient, notification: NotificationDTO): void {
	if (!isUnresolved(notification)) return;
	mergeNotificationIntoCache(queryClient, unresolvedNotificationsQueryKey, notification);
	rebaseOversizedFirstPage(queryClient, unresolvedNotificationsQueryKey);
}

/**
 * AO resolved the issue behind a notification, so it drops out of the
 * unresolved list without the user acknowledging anything. The seen state is a
 * separate axis and is deliberately left untouched here.
 */
export function applyResolvedNotification(queryClient: QueryClient, notification: NotificationDTO): void {
	queryClient.setQueryData<NotificationsCache>(unresolvedNotificationsQueryKey, (current) => {
		if (!current) return current;
		return {
			...current,
			pages: current.pages.map((page) => ({
				...page,
				notifications: page.notifications.filter((item) => item.id !== notification.id),
				unresolvedCount: Math.max(0, page.unresolvedCount - 1),
			})),
		};
	});
	for (const queryKey of [unreadNotificationsQueryKey, recentNotificationsQueryKey] as const) {
		queryClient.setQueryData<NotificationsCache>(queryKey, (current) => {
			if (!current) return current;
			return {
				...current,
				pages: current.pages.map((page) => ({
					...page,
					notifications: page.notifications.map((item) => (item.id === notification.id ? notification : item)),
					unresolvedCount: Math.max(0, page.unresolvedCount - 1),
				})),
			};
		});
	}
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
						unresolvedCount: isUnresolved(notification) ? 1 : 0,
					},
				],
			};
		}

		const existing = getCachedNotifications(current).find((item) => item.id === notification.id);
		const unreadDelta = (notification.status === "unread" ? 1 : 0) - (existing?.status === "unread" ? 1 : 0);
		const unresolvedDelta =
			(isUnresolved(notification) ? 1 : 0) - (existing && isUnresolved(existing) ? 1 : 0);
		const pages = current.pages.map((page) => ({
			...page,
			notifications: page.notifications.map((item) => (item.id === notification.id ? notification : item)),
			unreadCount: Math.max(0, page.unreadCount + unreadDelta),
			unresolvedCount: Math.max(0, page.unresolvedCount + unresolvedDelta),
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

/**
 * Marks exactly the acknowledged ids read, in place.
 *
 * Deliberately keeps the pages and their `nextCursor` intact. Resetting the
 * unread cache to a single empty page would throw away the cursor to rows the
 * panel had not loaded yet, and with the server having acknowledged only these
 * ids, those rows would be unreachable for the rest of the session.
 */
export function markAllCachedNotificationsRead(queryClient: QueryClient, ids: string[]): void {
	const acknowledged = new Set(ids);
	if (acknowledged.size === 0) return;
	for (const queryKey of [unreadNotificationsQueryKey, recentNotificationsQueryKey] as const) {
		queryClient.setQueryData<NotificationsCache>(queryKey, (current) => {
			if (!current) return current;
			return {
				...current,
				pages: current.pages.map((page) => {
					let cleared = 0;
					const notifications = page.notifications.map((item) => {
						if (!acknowledged.has(item.id) || item.status === "read") return item;
						cleared++;
						return { ...item, status: "read" as const };
					});
					return { ...page, notifications, unreadCount: Math.max(0, page.unreadCount - cleared) };
				}),
			};
		});
	}
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

export function getCachedUnresolvedCount(cache: NotificationsCache | undefined): number {
	return cache?.pages[0]?.unresolvedCount ?? getCachedNotifications(cache).filter(isUnresolved).length;
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

/**
 * A `needs_input` toast is redundant only when the user can already see the
 * prompt, which takes three things: the agent's terminal for that session is
 * the one on screen, this window is visible, and this window has focus.
 *
 * Each check covers a way "looks visible" lies. Visibility alone is not enough
 * — on Windows and Linux an unfocused or fully covered Electron window still
 * reports `visibilityState === "visible"`. The route alone is not enough
 * either: the session pane renders one terminal at a time, so an open shell or
 * reviewer tab hides the agent while the URL still names that session. The
 * caller resolves that, passing the session only while its agent pane shows.
 *
 * Only `needs_input` is suppressed. PR outcomes (`ready_to_merge`,
 * `pr_merged`, `pr_closed_unmerged`) are not visible in the terminal pane, so
 * they still deserve a toast even for the session in the foreground.
 */
function suppressToastForWatchedSession(
	notification: NotificationDTO,
	visibleAgentSessionId: string | undefined,
): boolean {
	if (notification.type !== "needs_input") return false;
	if (!notification.sessionId || notification.sessionId !== visibleAgentSessionId) return false;
	return document.visibilityState === "visible" && document.hasFocus();
}

export function createNotificationsTransport(
	queryClient: QueryClient,
	/** The session whose agent terminal is currently on screen, if any. */
	getVisibleAgentSessionId: () => string | undefined = () => undefined,
) {
	return {
		connect() {
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let source: EventSource | undefined;
			let sourceBaseUrl: string | undefined;

			const invalidateNotifications = () => {
				void queryClient.invalidateQueries({ queryKey: unreadNotificationsQueryKey });
				void queryClient.invalidateQueries({ queryKey: recentNotificationsQueryKey });
				void queryClient.invalidateQueries({ queryKey: unresolvedNotificationsQueryKey });
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
						mergeUnresolvedNotification(queryClient, notification);
						if (inserted && !suppressToastForWatchedSession(notification, getVisibleAgentSessionId())) {
							void aoBridge.notifications.show({
								id: notification.id,
								title: notification.title,
								body: notification.body || undefined,
							});
						}
					});
					// AO closed the underlying issue (the session got its input, the
					// PR stopped waiting on a merge). Drop the row live so an open
					// panel never shows something the user already dealt with.
					source.addEventListener("notification_resolved", (event) => {
						const notification = parseNotificationEvent(event);
						if (!notification) return;
						applyResolvedNotification(queryClient, notification);
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
