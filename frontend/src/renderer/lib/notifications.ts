import type { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { aoBridge } from "./bridge";
import { apiClient, apiErrorMessage, getApiBaseUrl, subscribeApiBaseUrl } from "./api-client";

export type NotificationDTO = components["schemas"]["NotificationResponse"];

export const unreadNotificationsQueryKey = ["notifications", "unread"] as const;

const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;

export async function fetchUnreadNotifications(): Promise<NotificationDTO[]> {
	const { data, error } = await apiClient.GET("/api/v1/notifications", {
		params: { query: { status: "unread", limit: 100 } },
	});
	if (error) throw new Error(apiErrorMessage(error, "Could not load notifications"));
	return sortNotifications(data?.notifications ?? []);
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

export async function markAllNotificationsRead(): Promise<NotificationDTO[]> {
	const { data, error } = await apiClient.POST("/api/v1/notifications/read-all");
	if (error) throw new Error(apiErrorMessage(error, "Could not mark notifications read"));
	return data?.notifications ?? [];
}

export function mergeUnreadNotification(queryClient: QueryClient, notification: NotificationDTO): boolean {
	let inserted = false;
	queryClient.setQueryData<NotificationDTO[]>(unreadNotificationsQueryKey, (current = []) => {
		if (current.some((item) => item.id === notification.id)) return current;
		inserted = true;
		return sortNotifications([notification, ...current]);
	});
	return inserted;
}

export function removeUnreadNotification(queryClient: QueryClient, id: string): void {
	queryClient.setQueryData<NotificationDTO[]>(unreadNotificationsQueryKey, (current = []) =>
		current.filter((item) => item.id !== id),
	);
}

export function clearUnreadNotifications(queryClient: QueryClient): void {
	queryClient.setQueryData<NotificationDTO[]>(unreadNotificationsQueryKey, []);
}

export function createNotificationsTransport(queryClient: QueryClient) {
	return {
		connect() {
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let source: EventSource | undefined;
			let sourceBaseUrl: string | undefined;

			const invalidateUnread = () => {
				void queryClient.invalidateQueries({ queryKey: unreadNotificationsQueryKey });
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
					source.onopen = invalidateUnread;
					source.onerror = () => {
						if (source?.readyState === EVENTSOURCE_CLOSED) scheduleRetry();
					};
					source.addEventListener("notification_created", (event) => {
						const notification = parseNotificationEvent(event);
						if (!notification) return;
						const inserted = mergeUnreadNotification(queryClient, notification);
						if (inserted) {
							void aoBridge.notifications.show({
								id: notification.id,
								title: notification.title,
								body: notification.body || undefined,
								type: notification.type,
							});
						}
					});
				} catch {
					source = undefined;
				}
			};

			const removeDaemonListener = aoBridge.daemon.onStatus(() => {
				connectSource();
				invalidateUnread();
			});
			const removeBaseUrlListener = subscribeApiBaseUrl(() => {
				connectSource();
				invalidateUnread();
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
	return [...notifications].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
