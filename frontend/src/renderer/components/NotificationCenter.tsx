import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
	Bell,
	BellRing,
	CheckCheck,
	CircleAlert,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	Inbox,
	LoaderCircle,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMarkAllNotificationsReadMutation, useNotificationsQuery } from "../hooks/useNotificationsQuery";
import { useRestoreSession } from "../hooks/useRestoreSession";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { aoBridge } from "../lib/bridge";
import { formatTimeCompact } from "../lib/format-time";
import {
	createNotificationsTransport,
	getCachedNotifications,
	getCachedUnreadCount,
	keepLatestNotificationsPage,
	type NotificationDTO,
	type NotificationsCache,
	recentNotificationsQueryKey,
	unreadNotificationsQueryKey,
} from "../lib/notifications";
import { useUiStore } from "../stores/ui-store";
import { captureRendererEvent } from "../lib/telemetry";
import { cn } from "../lib/utils";
import { TopbarButton } from "./TopbarButton";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type NotificationCenterProps = {
	style?: React.CSSProperties;
};

function useNotificationTargetNavigation() {
	const navigate = useNavigate();
	const openSession = useCallback(
		(notification: NotificationDTO) => {
			const sessionId = notification.target.sessionId || notification.sessionId;
			if (!sessionId) return;
			void captureRendererEvent("ao.renderer.notification_opened", { target: "session" });
			if (notification.projectId) {
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId: notification.projectId, sessionId },
				});
				return;
			}
			void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
		},
		[navigate],
	);

	const openPrimary = useCallback(
		(notification: NotificationDTO) => {
			if (notification.target.kind === "pr" && notification.target.prUrl) {
				void captureRendererEvent("ao.renderer.notification_opened", { target: "pr" });
				window.open(notification.target.prUrl, "_blank", "noopener,noreferrer");
				return;
			}
			openSession(notification);
		},
		[openSession],
	);

	return { openPrimary, openSession };
}

function useSessionTerminationLookup(): { sessionsReady: boolean; terminatedIds: Set<string> } {
	const { data: workspaces, isPending } = useWorkspaceQuery();
	const terminatedIds = useMemo(() => {
		const ids = new Set<string>();
		for (const workspace of workspaces ?? []) {
			for (const session of workspace.sessions) {
				if (session.isTerminated === true || session.status === "terminated") {
					ids.add(session.id);
				}
			}
		}
		return ids;
	}, [workspaces]);
	// Until workspace facts land, treat sessions as not-yet-openable so a
	// terminated row cannot navigate for one frame before restore appears.
	return { sessionsReady: !isPending, terminatedIds };
}

export function NotificationRuntime() {
	const queryClient = useQueryClient();
	const { openPrimary } = useNotificationTargetNavigation();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const routeSessionIdRef = useRef(params.sessionId);
	routeSessionIdRef.current = params.sessionId;

	// Being on the session route is not the same as watching the agent: its pane
	// renders one terminal at a time, so a shell or reviewer tab hides the agent
	// while the route is unchanged. Only report the session whose agent terminal
	// is the one on screen. Read the store imperatively — this feeds a getter for
	// the long-lived SSE connection, which needs the current value, not a render.
	const getVisibleAgentSessionId = useCallback(() => {
		const sessionId = routeSessionIdRef.current;
		if (!sessionId) return undefined;
		return useUiStore.getState().visibleTerminalKindBySession[sessionId] === "worker" ? sessionId : undefined;
	}, []);

	useEffect(
		() => createNotificationsTransport(queryClient, getVisibleAgentSessionId).connect(),
		[getVisibleAgentSessionId, queryClient],
	);

	useEffect(() => {
		return aoBridge.notifications.onClick((id) => {
			const unread = queryClient.getQueryData<NotificationsCache>(unreadNotificationsQueryKey);
			const recent = queryClient.getQueryData<NotificationsCache>(recentNotificationsQueryKey);
			const notification = [...getCachedNotifications(unread), ...getCachedNotifications(recent)].find(
				(item) => item.id === id,
			);
			if (notification) openPrimary(notification);
		});
	}, [openPrimary, queryClient]);

	return null;
}

export function NotificationCenter({ style }: NotificationCenterProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [actionError, setActionError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	// Opening marks unread as read, which would drop the highlight under the
	// cursor. Keep the open-time unread ids highlighted until the panel closes.
	const [highlightedIds, setHighlightedIds] = useState<Set<string>>(() => new Set());
	const [restoringSessionId, setRestoringSessionId] = useState<string | undefined>();
	const unreadQuery = useNotificationsQuery("unread");
	const allQuery = useNotificationsQuery("all", open);
	const markAllRead = useMarkAllNotificationsReadMutation();
	const restoreSession = useRestoreSession();
	const { sessionsReady, terminatedIds } = useSessionTerminationLookup();
	const notifications = useMemo(() => getCachedNotifications(allQuery.data), [allQuery.data]);
	const unreadCount = getCachedUnreadCount(unreadQuery.data);
	const { openPrimary, openSession } = useNotificationTargetNavigation();
	const markAllMutate = markAllRead.mutateAsync;

	const pendingUnread = useMemo(
		() => getCachedNotifications(unreadQuery.data).filter((item) => item.status === "unread"),
		[unreadQuery.data],
	);
	const pendingRef = useRef(pendingUnread);
	pendingRef.current = pendingUnread;
	const pendingKey = pendingUnread.map((item) => item.id).join("|");
	const acknowledgedKeyRef = useRef("");
	const fullAckDoneRef = useRef(false);

	// Opening the panel is the acknowledgement. Mark every unread row on the
	// server once (empty ids) so badge/history stay consistent past the first
	// loaded page; the all-list still shows those rows. Later arrivals while the
	// panel stays open are acknowledged by the ids that actually appeared.
	useEffect(() => {
		if (!open) {
			setHighlightedIds(new Set());
			acknowledgedKeyRef.current = "";
			fullAckDoneRef.current = false;
			return;
		}
		if (unreadQuery.isLoading) return;

		const acknowledge = (ids: string[]) => {
			setActionError(null);
			void captureRendererEvent("ao.renderer.notification_mark_read_requested", { scope: "all" });
			void markAllMutate(ids)
				.then(() => captureRendererEvent("ao.renderer.notification_mark_read_succeeded", { scope: "all" }))
				.catch((error: unknown) => {
					void captureRendererEvent("ao.renderer.notification_mark_read_failed", { scope: "all" });
					fullAckDoneRef.current = false;
					acknowledgedKeyRef.current = "";
					setActionError(error instanceof Error ? error.message : t("notify.couldNotMarkAllRead"));
				});
		};

		if (!fullAckDoneRef.current && unreadCount > 0) {
			fullAckDoneRef.current = true;
			acknowledgedKeyRef.current = pendingKey;
			const pending = pendingRef.current;
			if (pending.length > 0) {
				setHighlightedIds(new Set(pending.map((item) => item.id)));
			}
			acknowledge([]);
			return;
		}

		if (pendingKey === "" || acknowledgedKeyRef.current === pendingKey) return;
		acknowledgedKeyRef.current = pendingKey;
		const pending = pendingRef.current;
		setHighlightedIds((current) => {
			const next = new Set(current);
			let changed = false;
			for (const item of pending) {
				if (next.has(item.id)) continue;
				next.add(item.id);
				changed = true;
			}
			return changed ? next : current;
		});
		acknowledge(pending.map((item) => item.id));
	}, [markAllMutate, open, pendingKey, t, unreadCount, unreadQuery.isLoading]);

	const setPanelOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			keepLatestNotificationsPage(queryClient, unreadNotificationsQueryKey);
			keepLatestNotificationsPage(queryClient, recentNotificationsQueryKey);
		}
	};

	const openSessionAndDismiss = (notification: NotificationDTO) => {
		openSession(notification);
		setPanelOpen(false);
	};

	const openPrimaryAndDismiss = (notification: NotificationDTO) => {
		openPrimary(notification);
		setPanelOpen(false);
	};

	const restoreAndOpen = async (notification: NotificationDTO) => {
		const sessionId = notification.target.sessionId || notification.sessionId;
		if (!sessionId || restoringSessionId) return;
		setRestoringSessionId(sessionId);
		setActionError(null);
		try {
			const result = await restoreSession(sessionId);
			if (result.status === "success") {
				openSession(notification);
				setPanelOpen(false);
				return;
			}
			setActionError(result.status === "not_resumable" ? t("notify.restoreUnavailable") : result.message);
		} finally {
			setRestoringSessionId(undefined);
		}
	};

	const loadEarlierOnScroll = (event: React.UIEvent<HTMLDivElement>) => {
		const list = event.currentTarget;
		const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
		if (remaining > 80 || !allQuery.hasNextPage || allQuery.isFetchingNextPage) return;
		void allQuery.fetchNextPage();
	};

	const isEmpty = notifications.length === 0;

	return (
		<Popover onOpenChange={setPanelOpen} open={open}>
			<PopoverTrigger asChild>
				<TopbarButton
					aria-label={unreadCount > 0 ? t("notify.unreadCount", { count: unreadCount }) : t("notify.bell")}
					className="relative"
					style={style}
					variant="icon"
				>
					{unreadCount > 0 ? (
						<BellRing className="size-5 fill-current text-foreground" aria-hidden="true" />
					) : (
						<Bell className="size-5" aria-hidden="true" />
					)}
					{unreadCount > 0 ? (
						<span className="pointer-events-none absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] font-semibold leading-4 text-background shadow-sm">
							{unreadCount > 99 ? "99+" : unreadCount}
						</span>
					) : null}
				</TopbarButton>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label={t("notify.title")}
				className="w-notification-width max-w-[calc(100vw-1rem)] overflow-hidden rounded-panel border-border-strong p-0 shadow-xl"
				sideOffset={8}
			>
				<div className="border-b border-border bg-[var(--color-overlay-subtle)] px-4 py-3.5">
					<p className="text-subtitle font-semibold tracking-tight text-foreground">{t("notify.title")}</p>
				</div>

				{actionError ? (
					<div className="border-b border-border bg-error/5 px-4 py-2 text-caption text-error">{actionError}</div>
				) : null}
				{allQuery.isError && isEmpty ? (
					<NotificationEmpty icon={CircleAlert} message={t("notify.loadFailed")} />
				) : allQuery.isLoading && isEmpty ? (
					<NotificationEmpty icon={Inbox} message={t("notify.loading")} />
				) : isEmpty ? (
					<NotificationEmpty icon={CheckCheck} message={t("notify.emptyAll")} />
				) : (
					<div
						aria-busy={allQuery.isFetchingNextPage}
						className="max-h-notification-max-height overflow-y-auto overscroll-contain py-1.5"
						onScroll={loadEarlierOnScroll}
						role="list"
					>
						{notifications.map((notification) => {
							const sessionId = notification.target.sessionId || notification.sessionId;
							const terminated = Boolean(sessionId) && terminatedIds.has(sessionId);
							return (
								<NotificationItem
									highlighted={highlightedIds.has(notification.id) || notification.status === "unread"}
									key={notification.id}
									notification={notification}
									onOpenPrimary={openPrimaryAndDismiss}
									onOpenSession={openSessionAndDismiss}
									onRestore={() => void restoreAndOpen(notification)}
									restoring={restoringSessionId === sessionId}
									restoreDisabled={restoringSessionId !== undefined}
									sessionsReady={sessionsReady}
									terminated={terminated}
								/>
							);
						})}
						{allQuery.isFetchNextPageError ? (
							<div
								aria-live="polite"
								className="flex items-center justify-center gap-2 px-4 py-3 text-caption text-error"
							>
								{t("notify.earlierLoadFailed")}
								<button
									className="font-medium underline underline-offset-2 hover:text-foreground"
									onClick={() => void allQuery.fetchNextPage()}
									type="button"
								>
									{t("notify.retry")}
								</button>
							</div>
						) : allQuery.isFetchingNextPage ? (
							<div
								aria-live="polite"
								className="flex items-center justify-center gap-2 px-4 py-3 text-caption text-passive"
							>
								<LoaderCircle className="size-icon-md animate-spin" aria-hidden="true" />
								{t("notify.loadingEarlier")}
							</div>
						) : null}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function NotificationEmpty({ icon: Icon, message }: { icon: typeof Bell; message: string }) {
	return (
		<div className="grid min-h-40 place-items-center px-4 py-10 text-center">
			<div>
				<div className="mx-auto grid size-control-xl place-items-center rounded-full border border-border bg-surface text-passive">
					<Icon className={cn("size-icon-base", Icon === LoaderCircle && "animate-spin")} aria-hidden="true" />
				</div>
				<p className="mt-2.5 text-control text-muted-foreground">{message}</p>
			</div>
		</div>
	);
}

/**
 * The whole row is the click target for live sessions. Terminated sessions are
 * not navigable — restore is the only session action. PR titles stay a real
 * link so a PR row can open the PR without a separate icon button.
 */
function NotificationItem({
	highlighted,
	notification,
	onOpenPrimary,
	onOpenSession,
	onRestore,
	restoring,
	restoreDisabled,
	sessionsReady,
	terminated,
}: {
	highlighted: boolean;
	notification: NotificationDTO;
	onOpenPrimary: (notification: NotificationDTO) => void;
	onOpenSession: (notification: NotificationDTO) => void;
	onRestore: () => void;
	restoring: boolean;
	restoreDisabled: boolean;
	sessionsReady: boolean;
	terminated: boolean;
}) {
	const { t } = useTranslation();
	const Icon = notificationIcon(notification.type);
	const isPR = notification.target.kind === "pr" && Boolean(notification.target.prUrl);
	const sessionId = notification.target.sessionId || notification.sessionId;
	const canOpenSession = Boolean(sessionId) && sessionsReady && !terminated;
	const openRow = () => {
		if (canOpenSession) onOpenSession(notification);
	};
	return (
		<div role="listitem">
			<div
				className={cn(
					"group grid grid-cols-notification gap-3 px-4 py-3 text-left transition-[background-color,opacity] duration-fast",
					canOpenSession ? "cursor-pointer hover:bg-interactive-hover" : "cursor-default",
					!highlighted && "opacity-55 hover:opacity-80",
				)}
				onClick={openRow}
				onKeyDown={(event) => {
					if (!canOpenSession) return;
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					openRow();
				}}
				role={canOpenSession ? "button" : undefined}
				tabIndex={canOpenSession ? 0 : undefined}
				title={canOpenSession ? t("notify.openSessionTitle") : undefined}
			>
				<div
					className={cn(
						"mt-0.5 grid size-notification-icon place-items-center rounded-md bg-surface",
						notificationIconClass(notification.type),
					)}
				>
					<Icon className="size-icon-base" aria-hidden="true" />
				</div>
				<div className="min-w-0">
					<div className="flex min-w-0 items-start gap-2">
						{isPR ? (
							<a
								className={cn(
									"inline-flex min-w-0 items-start gap-1 text-left text-control leading-snug text-foreground underline decoration-border-strong underline-offset-3 transition-colors hover:text-accent hover:decoration-accent/60",
									highlighted && "font-medium",
								)}
								href={notification.target.prUrl}
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
									onOpenPrimary(notification);
								}}
								rel="noreferrer"
								target="_blank"
								title={t("notify.openPR")}
							>
								<span className="break-words">{notification.title}</span>
								<ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
							</a>
						) : (
							<span
								className={cn(
									"min-w-0 break-words text-control leading-snug text-foreground",
									highlighted && "font-medium",
								)}
							>
								{notification.title}
							</span>
						)}
						<time className="ml-auto shrink-0 font-mono text-[9px] text-passive" dateTime={notification.createdAt}>
							{formatTimeCompact(notification.createdAt)}
						</time>
					</div>
					{notification.body ? (
						<p className="mt-0.5 whitespace-pre-wrap break-words text-caption leading-snug text-muted-foreground">
							{notification.body}
						</p>
					) : null}
				</div>
				{terminated && sessionId ? (
					<button
						aria-label={t("shell.restoreSession")}
						className="mt-0.5 grid size-control-md place-items-center rounded-md text-passive transition-colors hover:bg-interactive-active hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
						disabled={restoreDisabled}
						onClick={(event) => {
							event.stopPropagation();
							onRestore();
						}}
						title={restoring ? t("shell.restoringSession") : t("shell.restoreSession")}
						type="button"
					>
						<RotateCcw className={cn("size-icon-md", restoring && "animate-spin")} aria-hidden="true" />
					</button>
				) : null}
			</div>
		</div>
	);
}

function notificationIcon(type: string) {
	switch (type) {
		case "needs_input":
			return CircleAlert;
		case "ready_to_merge":
			return GitPullRequest;
		case "pr_merged":
			return GitMerge;
		case "pr_closed_unmerged":
			return XCircle;
		default:
			return Bell;
	}
}

function notificationIconClass(type: string): string {
	switch (type) {
		case "needs_input":
			return "text-warning";
		case "ready_to_merge":
			return "text-success";
		case "pr_merged":
			return "text-accent";
		case "pr_closed_unmerged":
			return "text-error";
		default:
			return "text-muted-foreground";
	}
}
