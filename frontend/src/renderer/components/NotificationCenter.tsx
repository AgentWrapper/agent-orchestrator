import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	Bell,
	Check,
	CheckCheck,
	CircleAlert,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	Inbox,
	LoaderCircle,
	SquareTerminal,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	useMarkAllNotificationsReadMutation,
	useMarkNotificationReadMutation,
	useNotificationsQuery,
} from "../hooks/useNotificationsQuery";
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
import { captureRendererEvent } from "../lib/telemetry";
import { cn } from "../lib/utils";
import { TopbarButton } from "./TopbarButton";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type NotificationCenterProps = {
	style?: React.CSSProperties;
};

type NotificationView = "unread" | "all";

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

	useEffect(() => createNotificationsTransport(queryClient).connect(), [queryClient]);

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
	const queryClient = useQueryClient();
	const [actionError, setActionError] = useState<string | null>(null);
	const [view, setView] = useState<NotificationView>("unread");
	const [open, setOpen] = useState(false);
	const unreadQuery = useNotificationsQuery("unread");
	const allQuery = useNotificationsQuery("all", open && view === "all");
	const notificationsQuery = view === "unread" ? unreadQuery : allQuery;
	const markRead = useMarkNotificationReadMutation();
	const markAllRead = useMarkAllNotificationsReadMutation();
	const unread = useMemo(() => getCachedNotifications(unreadQuery.data), [unreadQuery.data]);
	const all = useMemo(() => getCachedNotifications(allQuery.data), [allQuery.data]);
	const unreadCount = getCachedUnreadCount(unreadQuery.data);
	const visibleNotifications = view === "unread" ? unread : all;
	const { openPrimary, openSession } = useNotificationTargetNavigation();

	const markOneRead = async (id: string) => {
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_mark_read_requested", { scope: "single" });
		try {
			await markRead.mutateAsync(id);
			void captureRendererEvent("ao.renderer.notification_mark_read_succeeded", { scope: "single" });
		} catch (error) {
			void captureRendererEvent("ao.renderer.notification_mark_read_failed", { scope: "single" });
			setActionError(error instanceof Error ? error.message : "Could not mark notification read");
		}
	};

	const markAll = async () => {
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_mark_read_requested", { scope: "all" });
		try {
			await markAllRead.mutateAsync();
			void captureRendererEvent("ao.renderer.notification_mark_read_succeeded", { scope: "all" });
		} catch (error) {
			void captureRendererEvent("ao.renderer.notification_mark_read_failed", { scope: "all" });
			setActionError(error instanceof Error ? error.message : "Could not mark notifications read");
		}
	};

	const setPanelOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			keepLatestNotificationsPage(queryClient, unreadNotificationsQueryKey);
			keepLatestNotificationsPage(queryClient, recentNotificationsQueryKey);
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

	const loadEarlierOnScroll = (event: React.UIEvent<HTMLDivElement>) => {
		const list = event.currentTarget;
		const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
		if (remaining > 80 || !notificationsQuery.hasNextPage || notificationsQuery.isFetchingNextPage) return;
		void notificationsQuery.fetchNextPage();
	};

	return (
		<Popover onOpenChange={setPanelOpen} open={open}>
			<PopoverTrigger asChild>
				<TopbarButton
					aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
					className="relative"
					style={style}
					variant="icon"
				>
					<Bell className={cn("size-icon-lg", unreadCount > 0 && "fill-current text-foreground")} aria-hidden="true" />
					{unreadCount > 0 ? (
						<span className="pointer-events-none absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] font-semibold leading-4 text-background shadow-sm">
							{unreadCount > 99 ? "99+" : unreadCount}
						</span>
					) : null}
				</TopbarButton>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label="Notifications"
				className="w-notification-width max-w-[calc(100vw-1rem)] overflow-hidden rounded-panel border-border-strong p-0 shadow-xl"
				sideOffset={8}
			>
				<div className="border-b border-border bg-[var(--color-overlay-subtle)] px-4 pt-3.5">
					<p className="text-subtitle font-semibold tracking-tight text-foreground">Notifications</p>
					<div className="mt-2 flex items-end justify-between gap-4">
						<div aria-label="Notification filters" className="flex items-end gap-5" role="tablist">
							<NotificationTab
								active={view === "unread"}
								count={unreadCount}
								label="Unread"
								onClick={() => setView("unread")}
							/>
							<NotificationTab active={view === "all"} label="All" onClick={() => setView("all")} />
						</div>
						<button
							aria-label="Mark all notifications read"
							className="mb-1 inline-flex h-control-sm items-center gap-1.5 rounded-md px-1.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
							disabled={unreadCount === 0 || markAllRead.isPending}
							onClick={() => void markAll()}
							type="button"
						>
							<CheckCheck className="size-icon-md" aria-hidden="true" />
							Mark all read
						</button>
					</div>
				</div>

				{actionError ? (
					<div className="border-b border-border bg-error/5 px-4 py-2 text-caption text-error">{actionError}</div>
				) : null}
				{notificationsQuery.isError && visibleNotifications.length === 0 ? (
					<NotificationEmpty icon={CircleAlert} message="Could not load notifications." />
				) : notificationsQuery.isLoading && visibleNotifications.length === 0 ? (
					<NotificationEmpty icon={Inbox} message="Loading notifications…" />
				) : visibleNotifications.length === 0 ? (
					<NotificationEmpty
						icon={view === "unread" && unreadCount > 0 ? LoaderCircle : view === "unread" ? CheckCheck : Inbox}
						message={
							view === "unread" && unreadCount > 0
								? "Loading unread notifications…"
								: view === "unread"
									? "You're all caught up."
									: "No notifications yet."
						}
					/>
				) : (
					<div
						aria-busy={notificationsQuery.isFetchingNextPage}
						className="max-h-notification-max-height overflow-y-auto overscroll-contain py-1.5"
						onScroll={loadEarlierOnScroll}
						role="list"
					>
						{visibleNotifications.map((notification) => (
							<NotificationItem
								disabled={markRead.isPending}
								key={notification.id}
								notification={notification}
								onMarkRead={markOneRead}
								onOpenPrimary={openAndDismiss}
								onOpenSession={openSessionAndDismiss}
							/>
						))}
						{notificationsQuery.isFetchNextPageError ? (
							<div
								aria-live="polite"
								className="flex items-center justify-center gap-2 px-4 py-3 text-caption text-error"
							>
								Couldn’t load earlier notifications.
								<button
									className="font-medium underline underline-offset-2 hover:text-foreground"
									onClick={() => void notificationsQuery.fetchNextPage()}
									type="button"
								>
									Retry
								</button>
							</div>
						) : notificationsQuery.isFetchingNextPage ? (
							<div
								aria-live="polite"
								className="flex items-center justify-center gap-2 px-4 py-3 text-caption text-passive"
							>
								<LoaderCircle className="size-icon-md animate-spin" aria-hidden="true" />
								Loading earlier notifications…
							</div>
						) : null}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function NotificationTab({
	active,
	count,
	label,
	onClick,
}: {
	active: boolean;
	count?: number;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-selected={active}
			className={cn(
				"relative inline-flex h-control-lg items-center gap-0.5 border-b-2 px-0.5 text-control font-medium transition-colors",
				active ? "border-foreground text-foreground" : "border-transparent text-passive hover:text-muted-foreground",
			)}
			onClick={onClick}
			role="tab"
			type="button"
		>
			{label}
			{typeof count === "number" && count > 0 ? (
				<span
					className={cn(
						"relative -top-1 grid min-w-4 place-items-center rounded-full px-1 font-mono text-[9px] leading-4",
						active ? "bg-foreground text-background" : "bg-surface text-muted-foreground",
					)}
				>
					{count > 99 ? "99+" : count}
				</span>
			) : null}
		</button>
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

function NotificationItem({
	disabled,
	notification,
	onMarkRead,
	onOpenPrimary,
	onOpenSession,
}: {
	disabled: boolean;
	notification: NotificationDTO;
	onMarkRead: (id: string) => Promise<void>;
	onOpenPrimary: (notification: NotificationDTO) => void;
	onOpenSession: (notification: NotificationDTO) => void;
}) {
	const Icon = notificationIcon(notification.type);
	const isUnread = notification.status === "unread";
	const isPR = notification.target.kind === "pr" && Boolean(notification.target.prUrl);
	return (
		<div
			className={cn(
				"group grid grid-cols-notification gap-3 px-4 py-3 transition-[background-color,opacity] duration-fast hover:bg-interactive-hover",
				!isUnread && "opacity-55 hover:opacity-80",
			)}
			role="listitem"
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
								event.preventDefault();
								onOpenPrimary(notification);
							}}
							rel="noreferrer"
							target="_blank"
							title="Open pull request"
						>
							<span className="break-words">{notification.title}</span>
							<ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
						</a>
					) : (
						<button
							className="min-w-0 break-words text-left text-control font-medium leading-snug text-foreground transition-colors hover:text-accent hover:underline"
							onClick={() => onOpenPrimary(notification)}
							title="Open session"
							type="button"
						>
							{notification.title}
						</button>
					)}
					<time className="shrink-0 font-mono text-[9px] text-passive" dateTime={notification.createdAt}>
						{formatTimeCompact(notification.createdAt)}
					</time>
				</div>
				{notification.body ? (
					<p className="mt-0.5 whitespace-pre-wrap break-words text-caption leading-snug text-muted-foreground">
						{notification.body}
					</p>
				) : null}
			</div>
			<div className="flex items-start gap-0.5">
				{isPR && notification.sessionId ? (
					<button
						aria-label="Open related session"
						className="grid size-control-md place-items-center rounded-md text-passive transition-colors hover:bg-interactive-active hover:text-foreground"
						onClick={() => onOpenSession(notification)}
						title="Open related session"
						type="button"
					>
						<SquareTerminal className="size-icon-md" aria-hidden="true" />
					</button>
				) : null}
				{isUnread ? (
					<button
						aria-label="Mark notification read"
						className="grid size-control-md place-items-center rounded-md text-passive transition-colors hover:bg-interactive-active hover:text-success disabled:pointer-events-none disabled:opacity-40"
						disabled={disabled}
						onClick={() => void onMarkRead(notification.id)}
						title="Mark as read"
						type="button"
					>
						<Check className="size-icon-md" aria-hidden="true" />
					</button>
				) : (
					<span aria-label="Read" className="grid size-control-md place-items-center text-passive" title="Read">
						<Check className="size-icon-md" aria-hidden="true" />
					</span>
				)}
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
