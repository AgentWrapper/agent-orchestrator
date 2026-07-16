import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import type { NotificationDTO } from "./notifications";

const {
	getApiBaseUrlMock,
	onStatusMock,
	removeStatusMock,
	showNotificationMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
} = vi.hoisted(() => ({
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	showNotificationMock: vi.fn(),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
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

import {
	createNotificationsTransport,
	localizeNotification,
	mergeUnreadNotification,
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
	it("merges unread notifications by id", () => {
		const qc = queryClient();
		const original = notification();

		expect(mergeUnreadNotification(qc, original)).toBe(true);
		expect(mergeUnreadNotification(qc, notification())).toBe(false);

		expect(qc.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey)).toEqual([original]);
		expect(qc.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey)?.[0]).toBe(original);
	});
});

describe("localizeNotification", () => {
	it.each(["needs_input", "ready_to_merge", "pr_merged", "pr_closed_unmerged"] as const)(
		"localizes %s without changing the source DTO",
		async (type) => {
			await i18n.changeLanguage("zh-CN");
			const source = notification({
				type,
				prUrl: type === "needs_input" ? "" : "https://github.com/acme/widgets/pull/42",
				target:
					type === "needs_input"
						? { kind: "session", sessionId: "mer-1" }
						: { kind: "pr", sessionId: "mer-1", prUrl: "https://github.com/acme/widgets/pull/42" },
			});
			const before = structuredClone(source);

			const localized = localizeNotification(source, i18n.t);

			expect(localized.title).not.toBe(source.title);
			expect(localized.body).not.toBe(source.body);
			expect(source).toEqual(before);
		},
	);

	it("uses only URL metadata for GitHub pull requests and GitLab merge requests", async () => {
		await i18n.changeLanguage("en");
		const github = localizeNotification(
			notification({
				type: "ready_to_merge",
				prUrl: "https://github.com/acme/widgets/pull/42/files",
				title: "secret external title",
				body: "secret external body",
			}),
			i18n.t,
		);
		expect(github.title).toBe("Pull request #42 is ready to merge");
		expect(github.title).not.toContain("secret");
		expect(github.body).not.toContain("secret");

		await i18n.changeLanguage("zh-CN");
		const gitlab = localizeNotification(
			notification({
				type: "pr_merged",
				prUrl: "https://gitlab.example.com/group/repo/-/merge_requests/7",
			}),
			i18n.t,
		);
		expect(gitlab.title).toBe("合并请求 !7 已合并");
	});

	it("does not infer identity from malformed URLs or stored English content", async () => {
		await i18n.changeLanguage("en");
		const localized = localizeNotification(
			notification({
				type: "pr_closed_unmerged",
				prUrl: "not-a-url",
				title: "PR #999 was closed without merging",
				body: "Pull request #999",
			}),
			i18n.t,
		);

		expect(localized.title).toBe("Change request was closed without merging");
		expect(localized.title).not.toContain("999");
	});

	it("preserves unknown notification types and external content", async () => {
		await i18n.changeLanguage("zh-CN");
		const source = notification({ type: "external_event" as NotificationDTO["type"], title: "External title", body: "外部正文" });

		expect(localizeNotification(source, i18n.t)).toBe(source);
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

	it("merges the raw DTO and shows one localized toast for a new id", async () => {
		await i18n.changeLanguage("zh-CN");
		const qc = queryClient();
		createNotificationsTransport(qc).connect();
		const source = EventSourceStub.instances[0];
		const incoming = notification();
		const localized = localizeNotification(incoming, i18n.t);

		source.dispatch("notification_created", incoming);
		source.dispatch("notification_created", incoming);

		expect(qc.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey)).toEqual([incoming]);
		expect(showNotificationMock).toHaveBeenCalledTimes(1);
		expect(showNotificationMock).toHaveBeenCalledWith({
			id: "ntf_1",
			title: localized.title,
			body: localized.body,
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
