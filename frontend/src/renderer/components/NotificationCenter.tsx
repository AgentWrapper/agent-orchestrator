import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, Check, CheckCheck, CircleAlert, ExternalLink, GitMerge, GitPullRequest, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	useMarkAllNotificationsReadMutation,
	useMarkNotificationReadMutation,
	useNotificationsQuery,
} from "../hooks/useNotificationsQuery";
import { aoBridge } from "../lib/bridge";
import { formatTimeCompact } from "../lib/format-time";
import { createNotificationsTransport, type NotificationDTO, unreadNotificationsQueryKey } from "../lib/notifications";
import { captureRendererEvent } from "../lib/telemetry";
import { cn } from "../lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type NotificationCenterProps = {
	style?: React.CSSProperties;
};

export function NotificationCenter({ style }: NotificationCenterProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const notificationsQuery = useNotificationsQuery();
	const markRead = useMarkNotificationReadMutation();
	const markAllRead = useMarkAllNotificationsReadMutation();
	const [actionError, setActionError] = useState<string | null>(null);
	const notifications = useMemo(() => notificationsQuery.data ?? [], [notificationsQuery.data]);
	const unreadCount = notifications.length;

	const openTarget = useCallback(
		(notification: NotificationDTO) => {
			const target = notification.target;
			if (target.kind === "pr" && target.prUrl) {
				void captureRendererEvent("ao.renderer.notification_opened", { target: "pr" });
				window.open(target.prUrl, "_blank", "noopener,noreferrer");
				return;
			}
			const sessionId = target.sessionId || notification.sessionId;
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

	useEffect(() => createNotificationsTransport(queryClient).connect(), [queryClient]);

	useEffect(() => {
		return aoBridge.notifications.onClick((id) => {
			const current = queryClient.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey) ?? [];
			const notification = current.find((item) => item.id === id);
			if (notification) openTarget(notification);
		});
	}, [openTarget, queryClient]);

	const markOneRead = async (id: string) => {
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_marked_read", { scope: "single" });
		try {
			await markRead.mutateAsync(id);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : "Could not mark notification read");
		}
	};

	const markAll = async () => {
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_marked_read", { scope: "all" });
		try {
			await markAllRead.mutateAsync();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : "Could not mark notifications read");
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
					className="dashboard-app-header__icon-btn relative"
					style={style}
					type="button"
				>
					<Bell className="h-[15px] w-[15px] fill-current" aria-hidden="true" />
					{unreadCount > 0 ? (
						<span className="pointer-events-none absolute right-[3px] top-[2px] font-mono text-[11px] font-semibold leading-none text-warning">
							{unreadCount > 99 ? "99+" : unreadCount}
						</span>
					) : null}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-[380px] p-0" sideOffset={8}>
				<div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
					<DropdownMenuLabel className="px-0 py-0">Notifications</DropdownMenuLabel>
					<button
						aria-label="Mark all notifications read"
						className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
						disabled={unreadCount === 0 || markAllRead.isPending}
						onClick={() => void markAll()}
						type="button"
					>
						<CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
						Mark all
					</button>
				</div>
				{actionError ? (
					<div className="border-b border-border px-3 py-2 text-[12px] text-error">{actionError}</div>
				) : null}
				{notificationsQuery.isError && unreadCount === 0 ? (
					<div className="px-3 py-8 text-center text-[13px] text-muted-foreground">Could not load notifications.</div>
				) : unreadCount === 0 ? (
					<div className="px-3 py-8 text-center text-[13px] text-muted-foreground">No unread notifications.</div>
				) : (
					<div className="max-h-[420px] overflow-y-auto p-1">
						{notifications.map((notification, index) => (
							<div key={notification.id}>
								<NotificationItem
									disabled={markRead.isPending}
									notification={notification}
									onMarkRead={markOneRead}
									onOpen={openTarget}
								/>
								{index < notifications.length - 1 ? <DropdownMenuSeparator className="my-0" /> : null}
							</div>
						))}
					</div>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function NotificationItem({
	disabled,
	notification,
	onMarkRead,
	onOpen,
}: {
	disabled: boolean;
	notification: NotificationDTO;
	onMarkRead: (id: string) => Promise<void>;
	onOpen: (notification: NotificationDTO) => void;
}) {
	const Icon = notificationIcon(notification.type);
	return (
		<div className="grid grid-cols-[26px_minmax(0,1fr)_auto] gap-2 rounded-md px-2 py-2.5">
			<div
				className={cn(
					"mt-0.5 grid h-6 w-6 place-items-center rounded-md border",
					notification.type === "needs_input" && "border-warning/40 text-warning",
					notification.type === "ready_to_merge" && "border-success/40 text-success",
					notification.type === "pr_merged" && "border-accent-dim text-accent",
					notification.type === "pr_closed_unmerged" && "border-error/40 text-error",
				)}
			>
				<Icon className="h-3.5 w-3.5" aria-hidden="true" />
			</div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<p className="truncate text-[13px] font-medium leading-5 text-foreground">{notification.title}</p>
					<span className="shrink-0 text-[11px] text-passive">{formatTimeCompact(notification.createdAt)}</span>
				</div>
				{notification.body ? (
					<p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-muted-foreground">{notification.body}</p>
				) : null}
			</div>
			<div className="flex items-start gap-1">
				<button
					aria-label="Open notification target"
					className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
					onClick={() => onOpen(notification)}
					title="Open target"
					type="button"
				>
					<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
				<button
					aria-label="Mark notification read"
					className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
					disabled={disabled}
					onClick={() => void onMarkRead(notification.id)}
					title="Mark read"
					type="button"
				>
					<Check className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
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
