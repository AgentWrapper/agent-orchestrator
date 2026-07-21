import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchRecentNotifications,
	markAllCachedNotificationsRead,
	markCachedNotificationRead,
	markAllNotificationsRead,
	markNotificationRead,
	recentNotificationsQueryKey,
} from "../lib/notifications";

export function useNotificationsQuery() {
	return useQuery({
		queryKey: recentNotificationsQueryKey,
		queryFn: fetchRecentNotifications,
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
		},
	});
}
