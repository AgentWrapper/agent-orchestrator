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
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMarkAllNotificationsReadMutation, useNotificationsQuery } from "../hooks/useNotificationsQuery";
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
	unresolvedNotificationsQueryKey,
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
	// Opening the panel IS the acknowledgement, so the unread cache empties out
	// from under the render. Freeze what was unseen at open time and show that
	// for as long as the panel stays open, or rows would vanish mid-read.
	const [unseen, setUnseen] = useState<NotificationDTO[]>([]);
	const unreadQuery = useNotificationsQuery("unread");
	const unresolvedQuery = useNotificationsQuery("unresolved", open);
	const markAllRead = useMarkAllNotificationsReadMutation();
	const unread = useMemo(() => getCachedNotifications(unreadQuery.data), [unreadQuery.data]);
	// A brand-new needs-input row is both unseen and unresolved. Show it once,
	// under Unseen: that is the section the user is here for.
	const unresolved = useMemo(() => {
		const shownAsUnseen = new Set(unseen.map((item) => item.id));
		return getCachedNotifications(unresolvedQuery.data).filter((item) => !shownAsUnseen.has(item.id));
	}, [unresolvedQuery.data, unseen]);
	const unreadCount = getCachedUnreadCount(unreadQuery.data);
	const { openPrimary, openSession } = useNotificationTargetNavigation();
	const markAllMutate = markAllRead.mutateAsync;

	// Capture what is unseen, then acknowledge it. The captured list only grows
	// while the panel is open — acknowledging empties the unread cache, and a row
	// must not disappear out from under the cursor.
	//
	// Acknowledge only what is still unread, and only by id. Scrolling loads the
	// next page, which lands here and gets acknowledged in turn — so nothing is
	// cleared on the server that the panel has not actually shown.
	//
	// Keyed on the ids rather than the array: the query hands back a fresh array
	// on every render, which as a dependency would re-acknowledge forever.
	const pending = useMemo(() => unread.filter((item) => item.status === "unread"), [unread]);
	const pendingRef = useRef(pending);
	pendingRef.current = pending;
	const pendingKey = pending.map((item) => item.id).join("|");
	const acknowledgedKeyRef = useRef("");
	useEffect(() => {
		if (!open) {
			setUnseen([]);
			acknowledgedKeyRef.current = "";
			return;
		}
		if (pendingKey === "" || acknowledgedKeyRef.current === pendingKey) return;
		acknowledgedKeyRef.current = pendingKey;
		const acknowledging = pendingRef.current;
		setUnseen((current) => {
			const known = new Set(current.map((item) => item.id));
			const added = acknowledging.filter((item) => !known.has(item.id));
			return added.length === 0 ? current : [...added, ...current];
		});
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_mark_read_requested", { scope: "all" });
		void markAllMutate(acknowledging.map((item) => item.id))
			.then(() => captureRendererEvent("ao.renderer.notification_mark_read_succeeded", { scope: "all" }))
			.catch((error: unknown) => {
				void captureRendererEvent("ao.renderer.notification_mark_read_failed", { scope: "all" });
				setActionError(error instanceof Error ? error.message : t("notify.couldNotMarkAllRead"));
			});
	}, [markAllMutate, open, pendingKey, t]);

	const setPanelOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			keepLatestNotificationsPage(queryClient, unreadNotificationsQueryKey);
			keepLatestNotificationsPage(queryClient, recentNotificationsQueryKey);
			keepLatestNotificationsPage(queryClient, unresolvedNotificationsQueryKey);
		}
	};

	const openAndDismiss = (notification: NotificationDTO) => {
		openPrimary(notification);
		setPanelOpen(false);
	};

	const openSessionAndDismiss = (notification: NotificationDTO) => {
		openSession(notification);
		setPanelOpen(false);
	};

	// One viewport over both sections. Unseen renders first, so its older pages
	// are what "more" means until it runs out; then unresolved keeps going.
	const pagingQuery = unreadQuery.hasNextPage ? unreadQuery : unresolvedQuery;
	const isLoading =
		(unreadQuery.isLoading && unseen.length === 0) || (unresolvedQuery.isLoading && unresolved.length === 0);
	// Each section owns its own failure. Collapsing both into one verdict let a
	// failed query hide behind the other's success and render "all caught up"
	// for data that was never loaded.
	const unseenFailed = unreadQuery.isError;
	const unresolvedFailed = unresolvedQuery.isError;
	const isError = unseenFailed && unresolvedFailed;
	const isEmpty = unseen.length === 0 && unresolved.length === 0 && !unseenFailed && !unresolvedFailed;

	const loadEarlierOnScroll = (event: React.UIEvent<HTMLDivElement>) => {
		const list = event.currentTarget;
		const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
		if (remaining > 80 || !pagingQuery.hasNextPage || pagingQuery.isFetchingNextPage) return;
		void pagingQuery.fetchNextPage();
	};

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
				{isError && isEmpty ? (
					<NotificationEmpty icon={CircleAlert} message={t("notify.loadFailed")} />
				) : isLoading && isEmpty ? (
					<NotificationEmpty icon={Inbox} message={t("notify.loading")} />
				) : isEmpty ? (
					<NotificationEmpty icon={CheckCheck} message={t("notify.emptyUnread")} />
				) : (
					<div
						aria-busy={pagingQuery.isFetchingNextPage}
						className="max-h-notification-max-height overflow-y-auto overscroll-contain py-1.5"
						onScroll={loadEarlierOnScroll}
						role="list"
					>
						{unseen.length > 0 || unseenFailed ? (
							<NotificationSectionHeading count={unseen.length} label={t("notify.unseen")} />
						) : null}
						{unseenFailed ? (
							<NotificationSectionError
									message={t("notify.unseenLoadFailed")}
									onRetry={() => void unreadQuery.refetch()}
									retryLabel={t("notify.retryUnseen")}
								/>
						) : null}
						{unseen.map((notification) => (
							<NotificationItem
								key={notification.id}
								notification={notification}
								onOpenPrimary={openAndDismiss}
								onOpenSession={openSessionAndDismiss}
							/>
						))}
						{unresolved.length > 0 || unresolvedFailed ? (
							<NotificationSectionHeading count={unresolved.length} label={t("notify.unresolved")} />
						) : null}
						{unresolvedFailed ? (
							<NotificationSectionError
								message={t("notify.unresolvedLoadFailed")}
								onRetry={() => void unresolvedQuery.refetch()}
								retryLabel={t("notify.retryUnresolved")}
							/>
						) : null}
						{unresolved.map((notification) => (
							<NotificationItem
								key={notification.id}
								notification={notification}
								onOpenPrimary={openAndDismiss}
								onOpenSession={openSessionAndDismiss}
							/>
						))}
						{pagingQuery.isFetchNextPageError ? (
							<div
								aria-live="polite"
								className="flex items-center justify-center gap-2 px-4 py-3 text-caption text-error"
							>
								{t("notify.earlierLoadFailed")}
								<button
									className="font-medium underline underline-offset-2 hover:text-foreground"
									onClick={() => void pagingQuery.fetchNextPage()}
									type="button"
								>
									{t("notify.retry")}
								</button>
							</div>
						) : pagingQuery.isFetchingNextPage ? (
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

/**
 * One section failed while the other loaded. Say so in place rather than
 * letting the panel imply the missing data is simply absent.
 */
function NotificationSectionError({
	message,
	onRetry,
	retryLabel,
}: {
	message: string;
	onRetry: () => void;
	retryLabel: string;
}) {
	const { t } = useTranslation();
	return (
		<div aria-live="polite" className="flex items-center gap-2 px-4 py-2 text-caption text-error" role="alert">
			<CircleAlert className="size-icon-md shrink-0" aria-hidden="true" />
			{message}
			<button
				aria-label={retryLabel}
				className="font-medium underline underline-offset-2 hover:text-foreground"
				onClick={onRetry}
				type="button"
			>
				{t("notify.retry")}
			</button>
		</div>
	);
}

function NotificationSectionHeading({ count, label }: { count: number; label: string }) {
	return (
		<div className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-caption font-medium uppercase tracking-wide text-passive">
			{label}
			<span className="grid min-w-4 place-items-center rounded-full bg-surface px-1 font-mono text-[9px] normal-case leading-4 text-muted-foreground">
				{count > 99 ? "99+" : count}
			</span>
		</div>
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
 * The whole row is the click target — the hover highlight has always implied
 * that, and precision-clicking the title was the actual bug. It navigates to the
 * session for every notification type; the PR title stays a real link on top of
 * it, so a PR row offers both destinations without a separate icon button.
 */
function NotificationItem({
	notification,
	onOpenPrimary,
	onOpenSession,
}: {
	notification: NotificationDTO;
	onOpenPrimary: (notification: NotificationDTO) => void;
	onOpenSession: (notification: NotificationDTO) => void;
}) {
	const { t } = useTranslation();
	const Icon = notificationIcon(notification.type);
	const isPR = notification.target.kind === "pr" && Boolean(notification.target.prUrl);
	const sessionId = notification.target.sessionId || notification.sessionId;
	const openRow = () => {
		if (sessionId) onOpenSession(notification);
	};
	return (
		<div role="listitem">
			<div
				className={cn(
					"group grid grid-cols-notification gap-3 px-4 py-3 text-left transition-[background-color] duration-fast",
					sessionId ? "cursor-pointer hover:bg-interactive-hover" : "cursor-default",
				)}
				onClick={openRow}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					openRow();
				}}
				role={sessionId ? "button" : undefined}
				tabIndex={sessionId ? 0 : undefined}
				title={sessionId ? t("notify.openSessionTitle") : undefined}
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
								className="inline-flex min-w-0 items-start gap-1 text-left text-control font-medium leading-snug text-foreground underline decoration-border-strong underline-offset-3 transition-colors hover:text-accent hover:decoration-accent/60"
								href={notification.target.prUrl}
								onClick={(event) => {
									// The row owns the session; the link owns the PR.
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
							<span className="min-w-0 break-words text-control font-medium leading-snug text-foreground">
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
