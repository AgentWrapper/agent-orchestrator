import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import type { components } from "../../api/schema";
import { i18n } from "../i18n";
import { aoBridge } from "./bridge";
import { apiClient, apiErrorMessage, getApiBaseUrl, subscribeApiBaseUrl } from "./api-client";

export type NotificationDTO = components["schemas"]["NotificationResponse"];

export const unreadNotificationsQueryKey = ["notifications", "unread"] as const;

const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;

type ChangeRequestIdentity = { provider: "github" | "gitlab"; number: string };

function changeRequestIdentity(value: string): ChangeRequestIdentity | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		const github = url.pathname.match(/\/pull\/(\d+)(?:\/|$)/);
		if (github?.[1]) return { provider: "github", number: github[1] };
		const gitlab = url.pathname.match(/\/-\/merge_requests\/(\d+)(?:\/|$)/);
		if (gitlab?.[1]) return { provider: "gitlab", number: gitlab[1] };
	} catch {
		return null;
	}
	return null;
}

function changeRequestLabel(notification: NotificationDTO, t: TFunction): string {
	const identity = changeRequestIdentity(notification.target.prUrl || notification.prUrl);
	if (identity?.provider === "github") return t("notifications.references.githubPull", { number: identity.number });
	if (identity?.provider === "gitlab") return t("notifications.references.gitlabMerge", { number: identity.number });
	return t("notifications.references.changeRequest");
}

export function localizeNotification(notification: NotificationDTO, t: TFunction): NotificationDTO {
	switch (notification.type) {
		case "needs_input": {
			const session = notification.target.sessionId || notification.sessionId;
			return {
				...notification,
				title: t("notifications.types.needsInput.title", { session }),
				body: t("notifications.types.needsInput.body"),
			};
		}
		case "ready_to_merge":
			return {
				...notification,
				title: t("notifications.types.readyToMerge.title", { request: changeRequestLabel(notification, t) }),
				body: t("notifications.types.readyToMerge.body"),
			};
		case "pr_merged":
			return {
				...notification,
				title: t("notifications.types.merged.title", { request: changeRequestLabel(notification, t) }),
				body: t("notifications.types.merged.body"),
			};
		case "pr_closed_unmerged":
			return {
				...notification,
				title: t("notifications.types.closedUnmerged.title", { request: changeRequestLabel(notification, t) }),
				body: t("notifications.types.closedUnmerged.body"),
			};
		default:
			return notification;
	}
}

export async function fetchUnreadNotifications(): Promise<NotificationDTO[]> {
	const { data, error } = await apiClient.GET("/api/v1/notifications", {
		params: { query: { status: "unread", limit: 100 } },
	});
	if (error) throw new Error(apiErrorMessage(error, i18n.t("notifications.center.loadFailed")));
	return sortNotifications(data?.notifications ?? []);
}

export async function markNotificationRead(id: string): Promise<NotificationDTO> {
	const { data, error } = await apiClient.PATCH("/api/v1/notifications/{id}", {
		params: { path: { id } },
		body: { status: "read" },
	});
	if (error) throw new Error(apiErrorMessage(error, i18n.t("notifications.center.markOneFailed")));
	if (!data?.notification) throw new Error(i18n.t("notifications.center.markOneFailed"));
	return data.notification;
}

export async function markAllNotificationsRead(): Promise<NotificationDTO[]> {
	const { data, error } = await apiClient.POST("/api/v1/notifications/read-all");
	if (error) throw new Error(apiErrorMessage(error, i18n.t("notifications.center.markAllFailed")));
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
							const localized = localizeNotification(notification, i18n.t);
							void aoBridge.notifications.show({
								id: notification.id,
								title: localized.title,
								body: localized.body || undefined,
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
