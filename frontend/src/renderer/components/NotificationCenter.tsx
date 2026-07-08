import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, Check, CheckCheck, ExternalLink, GitMerge, GitPullRequest, XCircle } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
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
		void aoBridge.notifications.setBadge(unreadCount);
	}, [unreadCount]);

	useEffect(() => {
		return aoBridge.notifications.onClick((id) => {
			const current = queryClient.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey) ?? [];
			const notification = current.find((item) => item.id === id);
			if (notification) openTarget(notification);
		});
	}, [openTarget, queryClient]);

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

	return (
		<DropdownMenu onOpenChange={(open) => { if (open) setActionError(null); }}>
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
			<DropdownMenuContent align="end" className="w-[320px] p-0" sideOffset={8}>
				<div className="flex items-center justify-between gap-3 border-b border-border px-2.5 py-1.5">
					<DropdownMenuLabel className="px-0 py-0 text-[12px]">Notifications</DropdownMenuLabel>
					<button
						aria-label="Mark all notifications read"
						className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
						disabled={unreadCount === 0 || markAllRead.isPending}
						onClick={() => void markAll()}
						type="button"
					>
						<CheckCheck className="h-3 w-3" aria-hidden="true" />
						Mark all
					</button>
				</div>
				{actionError ? (
					<div className="border-b border-border px-2.5 py-1.5 text-[11px] text-error">{actionError}</div>
				) : null}
				{notificationsQuery.isError && unreadCount === 0 ? (
					<div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">Could not load notifications.</div>
				) : unreadCount === 0 ? (
					<div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">No unread notifications.</div>
				) : (
					<div className="max-h-[360px] overflow-y-auto p-0.5">
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
	const icon = notificationIcon(notification.type);
	return (
		<div className="grid grid-cols-[14px_minmax(0,1fr)_auto] gap-2 rounded-md px-2.5 py-2.5">
			<div className="flex items-start justify-center pt-[5px]">
				{icon.type === "dot" ? (
					<span
						className="h-[7px] w-[7px] shrink-0 rounded-full"
						style={{ background: icon.color }}
						aria-hidden="true"
					/>
				) : (
					<icon.Component
						className={cn(
							"h-3.5 w-3.5 shrink-0",
							notification.type === "ready_to_merge" && "text-success",
							notification.type === "pr_merged" && "text-accent",
							notification.type === "pr_closed_unmerged" && "text-error",
						)}
						aria-hidden="true"
					/>
				)}
			</div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-1.5">
					<p className="truncate text-[12px] font-semibold leading-[1.4] text-foreground">{notification.title}</p>
					<span className="shrink-0 text-[10px] text-passive">{formatTimeCompact(notification.createdAt)}</span>
				</div>
				{notification.body ? (
					<p className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.5] text-muted-foreground">{notification.body}</p>
				) : null}
			</div>
			<div className="flex items-start gap-0.5">
				<button
					aria-label="Open notification target"
					className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
					onClick={() => onOpen(notification)}
					title="Open target"
					type="button"
				>
					<ExternalLink className="h-3 w-3" aria-hidden="true" />
				</button>
				<button
					aria-label="Mark notification read"
					className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
					disabled={disabled}
					onClick={() => void onMarkRead(notification.id)}
					title="Mark read"
					type="button"
				>
					<Check className="h-3 w-3" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

type IconSpec =
	| { type: "dot"; color: string }
	| { type: "component"; Component: React.ComponentType<React.SVGProps<SVGSVGElement>> };

function notificationIcon(type: string): IconSpec {
	switch (type) {
		case "needs_input":
			return { type: "dot", color: "var(--amber)" };
		case "ready_to_merge":
			return { type: "component", Component: GitPullRequest };
		case "pr_merged":
			return { type: "component", Component: GitMerge };
		case "pr_closed_unmerged":
			return { type: "component", Component: XCircle };
		default:
			return { type: "component", Component: Bell };
	}
}
