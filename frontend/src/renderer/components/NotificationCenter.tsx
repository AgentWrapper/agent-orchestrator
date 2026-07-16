import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, Check, CheckCheck, CircleAlert, ExternalLink, GitMerge, GitPullRequest, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useMarkAllNotificationsReadMutation,
	useMarkNotificationReadMutation,
	useNotificationsQuery,
} from "../hooks/useNotificationsQuery";
import { aoBridge } from "../lib/bridge";
import { formatTimeCompact } from "../lib/format-time";
import {
	createNotificationsTransport,
	localizeNotification,
	type NotificationDTO,
	unreadNotificationsQueryKey,
} from "../lib/notifications";
import { captureRendererEvent } from "../lib/telemetry";
import { cn } from "../lib/utils";
import { TopbarButton } from "./TopbarButton";
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

function useNotificationTargetNavigation() {
	const navigate = useNavigate();
	return useCallback(
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
}

export function NotificationRuntime() {
	const queryClient = useQueryClient();
	const openTarget = useNotificationTargetNavigation();

	useEffect(() => createNotificationsTransport(queryClient).connect(), [queryClient]);

	useEffect(() => {
		return aoBridge.notifications.onClick((id) => {
			const current = queryClient.getQueryData<NotificationDTO[]>(unreadNotificationsQueryKey) ?? [];
			const notification = current.find((item) => item.id === id);
			if (notification) openTarget(notification);
		});
	}, [openTarget, queryClient]);

	return null;
}

export function NotificationCenter({ style }: NotificationCenterProps) {
	const { i18n, t } = useTranslation();
	const notificationsQuery = useNotificationsQuery();
	const markRead = useMarkNotificationReadMutation();
	const markAllRead = useMarkAllNotificationsReadMutation();
	const [actionError, setActionError] = useState<"one" | "all" | null>(null);
	const notifications = useMemo(() => notificationsQuery.data ?? [], [notificationsQuery.data]);
	const unreadCount = notifications.length;
	const openTarget = useNotificationTargetNavigation();

	const markOneRead = async (id: string) => {
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_mark_read_requested", { scope: "single" });
		try {
			await markRead.mutateAsync(id);
			void captureRendererEvent("ao.renderer.notification_mark_read_succeeded", { scope: "single" });
		} catch {
			void captureRendererEvent("ao.renderer.notification_mark_read_failed", { scope: "single" });
			setActionError("one");
		}
	};

	const markAll = async () => {
		setActionError(null);
		void captureRendererEvent("ao.renderer.notification_mark_read_requested", { scope: "all" });
		try {
			await markAllRead.mutateAsync();
			void captureRendererEvent("ao.renderer.notification_mark_read_succeeded", { scope: "all" });
		} catch {
			void captureRendererEvent("ao.renderer.notification_mark_read_failed", { scope: "all" });
			setActionError("all");
		}
	};
	const locale = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<TopbarButton
					aria-label={
						unreadCount > 0 ? t("notifications.center.unreadCount", { count: unreadCount }) : t("notifications.center.title")
					}
					className="relative"
					style={style}
					variant="icon"
				>
					<Bell className="size-icon-lg fill-current" aria-hidden="true" />
					{unreadCount > 0 ? (
						<span className="pointer-events-none absolute right-0.75 top-0.5 font-mono text-caption font-semibold leading-none text-warning">
							{unreadCount > 99 ? "99+" : unreadCount}
						</span>
					) : null}
				</TopbarButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-notification-width p-0" sideOffset={8}>
				<div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
					<DropdownMenuLabel className="px-0 py-0">{t("notifications.center.title")}</DropdownMenuLabel>
					<button
						aria-label={t("notifications.center.markAllAria")}
						className="inline-flex h-control-md items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
						disabled={unreadCount === 0 || markAllRead.isPending}
						onClick={() => void markAll()}
						type="button"
					>
						<CheckCheck className="size-icon-md" aria-hidden="true" />
						{t("notifications.center.markAll")}
					</button>
				</div>
				{actionError ? (
					<div className="border-b border-border px-3 py-2 text-xs text-error">
						{t(actionError === "one" ? "notifications.center.markOneFailed" : "notifications.center.markAllFailed")}
					</div>
				) : null}
				{notificationsQuery.isError && unreadCount === 0 ? (
					<div className="px-3 py-8 text-center text-control text-muted-foreground">
						{t("notifications.center.loadFailed")}
					</div>
				) : unreadCount === 0 ? (
					<div className="px-3 py-8 text-center text-control text-muted-foreground">
						{t("notifications.center.empty")}
					</div>
				) : (
					<div className="max-h-notification-max-height overflow-y-auto p-1">
						{notifications.map((notification, index) => (
							<div key={notification.id}>
								<NotificationItem
									disabled={markRead.isPending}
									notification={notification}
									presentation={localizeNotification(notification, t)}
									locale={locale}
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
	presentation,
	locale,
	onMarkRead,
	onOpen,
}: {
	disabled: boolean;
	notification: NotificationDTO;
	presentation: NotificationDTO;
	locale: "en" | "zh-CN";
	onMarkRead: (id: string) => Promise<void>;
	onOpen: (notification: NotificationDTO) => void;
}) {
	const { t } = useTranslation();
	const Icon = notificationIcon(notification.type);
	return (
		<div className="grid grid-cols-notification gap-2 rounded-md px-2 py-2.5">
			<div
				className={cn(
					"mt-0.5 grid size-control-sm place-items-center rounded-md border",
					notification.type === "needs_input" && "border-warning/40 text-warning",
					notification.type === "ready_to_merge" && "border-success/40 text-success",
					notification.type === "pr_merged" && "border-accent-dim text-accent",
					notification.type === "pr_closed_unmerged" && "border-error/40 text-error",
				)}
			>
				<Icon className="size-icon-md" aria-hidden="true" />
			</div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<p className="truncate text-control font-medium leading-row text-foreground">{presentation.title}</p>
					<span className="shrink-0 text-caption text-passive">
						{formatTimeCompact(notification.createdAt, locale)}
					</span>
				</div>
				{presentation.body ? (
					<p className="mt-0.5 line-clamp-2 text-xs leading-row text-muted-foreground">{presentation.body}</p>
				) : null}
			</div>
			<div className="flex items-start gap-1">
				<button
					aria-label={t("notifications.center.openTarget")}
					className="grid size-control-md place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
					onClick={() => onOpen(notification)}
					title={t("notifications.center.openTargetTitle")}
					type="button"
				>
					<ExternalLink className="size-icon-md" aria-hidden="true" />
				</button>
				<button
					aria-label={t("notifications.center.markRead")}
					className="grid size-control-md place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
					disabled={disabled}
					onClick={() => void onMarkRead(notification.id)}
					title={t("notifications.center.markReadTitle")}
					type="button"
				>
					<Check className="size-icon-md" aria-hidden="true" />
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
