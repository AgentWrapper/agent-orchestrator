import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	fetchNotificationsPage,
	markAllCachedNotificationsRead,
	markCachedNotificationRead,
	markAllNotificationsRead,
	markNotificationRead,
	notificationsQueryKey,
	recentNotificationsQueryKey,
	type NotificationListStatus,
	unreadNotificationsQueryKey,
} from "../lib/notifications";

export function useNotificationsQuery(status: NotificationListStatus, enabled = true) {
	return useInfiniteQuery({
		queryKey: notificationsQueryKey(status),
		queryFn: ({ pageParam }) => fetchNotificationsPage(status, pageParam),
		initialPageParam: "",
		getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
		enabled,
		retry: 1,
	});
}

export function useMarkNotificationReadMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: markNotificationRead,
		onSuccess: (notification) => {
			markCachedNotificationRead(queryClient, notification);
		},
	});
}

export function useMarkAllNotificationsReadMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: markAllNotificationsRead,
		onSuccess: () => {
			markAllCachedNotificationsRead(queryClient);
			void queryClient.invalidateQueries({ queryKey: recentNotificationsQueryKey });
			void queryClient.invalidateQueries({ queryKey: unreadNotificationsQueryKey });
		},
	});
}
