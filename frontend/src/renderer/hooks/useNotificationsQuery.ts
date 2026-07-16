import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchNotifications,
	markCachedNotificationRead,
	markCachedNotificationsRead,
	markAllNotificationsRead,
	markNotificationRead,
	notificationsQueryKey,
} from "../lib/notifications";

export function useNotificationsQuery() {
	return useQuery({
		queryKey: notificationsQueryKey,
		queryFn: fetchNotifications,
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
		onSuccess: (notifications) => {
			markCachedNotificationsRead(queryClient, notifications);
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}
