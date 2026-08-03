import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	fetchNotificationsPage,
	markAllCachedNotificationsRead,
	markAllNotificationsRead,
	notificationsQueryKey,
	recentNotificationsQueryKey,
	type NotificationListStatus,
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

/**
 * Opening the notification panel is the acknowledgement — there is no manual
 * "mark all read" control any more, so this mutation is fired on open.
 */
export function useMarkAllNotificationsReadMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: markAllNotificationsRead,
		onSuccess: (_updated, ids) => {
			markAllCachedNotificationsRead(queryClient, ids);
			// Deliberately no invalidate here: refetching would drop the loaded
			// pages, and with them the cursor to unseen rows the panel has not
			// reached yet. The cache is already correct for the ids we sent.
			void queryClient.invalidateQueries({ queryKey: recentNotificationsQueryKey });
		},
	});
}
