import { Feather } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import {
	getNotifications,
	markAllNotificationsRead,
	markNotificationRead,
	type NotificationRecord,
} from "../lib/api";
import type { Theme } from "../lib/theme";
import { haptics } from "../lib/haptics";
import { notificationTarget, notificationVisual, relativeTime } from "../lib/notificationView";
import { useApp } from "../lib/store";
import { Dot, EmptyState } from "../lib/ui";
import { useTheme, useThemedStyles } from "../lib/ThemeProvider";

const PAGE_SIZE = 50;

// The durable record of what the daemon has notified about. Push only reaches a
// phone that was reachable at the time; this list is what the user can come back
// to afterwards.
export default function NotificationsScreen() {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const router = useRouter();
	const { config } = useApp();
	const [items, setItems] = useState<NotificationRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (mode: "initial" | "refresh") => {
			if (!config) return;
			if (mode === "refresh") setRefreshing(true);
			setError(null);
			try {
				const page = await getNotifications(config, { status: "all", limit: PAGE_SIZE });
				setItems(page.notifications);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Could not load notifications.");
			} finally {
				setLoading(false);
				setRefreshing(false);
			}
		},
		[config],
	);

	useEffect(() => {
		void load("initial");
	}, [load]);

	// Optimistic: the row should stop looking unread the instant it's tapped, and
	// a failed PATCH is not worth interrupting navigation over.
	function open(n: NotificationRecord) {
		setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, status: "read" } : x)));
		if (config && n.status === "unread") {
			markNotificationRead(config, n.id).catch(() => {});
		}
		router.navigate(notificationTarget(n));
	}

	async function markAll() {
		if (!config) return;
		haptics.tap();
		setItems((prev) => prev.map((x) => ({ ...x, status: "read" })));
		try {
			await markAllNotificationsRead(config);
		} catch {
			// Put the truth back on screen rather than leaving a lie there.
			void load("refresh");
		}
	}

	const unread = items.filter((n) => n.status === "unread").length;

	return (
		<View style={styles.screen}>
			<Stack.Screen
				options={{
					title: "Notifications",
					headerBackTitle: "Settings",
					headerRight: () =>
						unread > 0 ? (
							<Pressable onPress={markAll} hitSlop={10}>
								<Text style={styles.headerAction}>Mark all read</Text>
							</Pressable>
						) : null,
				}}
			/>

			{loading ? (
				<View style={styles.center}>
					<ActivityIndicator color={t.blue} />
				</View>
			) : (
				<FlatList
					data={items}
					keyExtractor={(n) => n.id}
					refreshing={refreshing}
					onRefresh={() => load("refresh")}
					contentContainerStyle={items.length === 0 ? { flexGrow: 1 } : { paddingVertical: 8 }}
					ItemSeparatorComponent={() => <View style={styles.separator} />}
					ListEmptyComponent={
						<EmptyState
							icon={error ? "alert-circle" : "bell"}
							title={error ? "Couldn't load notifications" : "Nothing yet"}
							message={
								error ?? "Alerts about agents that need you and PRs that are ready will show up here."
							}
						/>
					}
					renderItem={({ item }) => <NotificationRow item={item} onPress={() => open(item)} />}
				/>
			)}
		</View>
	);
}

function NotificationRow({ item, onPress }: { item: NotificationRecord; onPress: () => void }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const v = notificationVisual(t, item.type);
	const unread = item.status === "unread";
	return (
		<Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
			<View style={[styles.iconTile, { backgroundColor: t.bgSubtle }]}>
				<Feather name={v.icon} size={15} color={v.color} />
			</View>
			<View style={{ flex: 1 }}>
				<View style={styles.titleRow}>
					<Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>
						{item.title || v.label}
					</Text>
					{unread ? <Dot color={t.blue} size={7} /> : null}
					<Text style={styles.time}>{relativeTime(item.createdAt)}</Text>
				</View>
				{item.body ? (
					<Text style={styles.body} numberOfLines={2}>
						{item.body}
					</Text>
				) : null}
			</View>
			<Feather name="chevron-right" size={16} color={t.textFaint} />
		</Pressable>
	);
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
	screen: { flex: 1, backgroundColor: t.bgBase },
	center: { flex: 1, alignItems: "center", justifyContent: "center" },
	headerAction: { color: t.blue, fontSize: 15, fontWeight: "600" },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: t.borderSubtle, marginLeft: 58 },
	row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
	rowPressed: { backgroundColor: t.bgElevated },
	iconTile: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
	titleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
	title: { color: t.textSecondary, fontSize: 15, fontWeight: "600", flexShrink: 1 },
	titleUnread: { color: t.textPrimary },
	time: { color: t.textFaint, fontSize: 12, marginLeft: "auto" },
	body: { color: t.textTertiary, fontSize: 13, lineHeight: 18, marginTop: 3 },
});
