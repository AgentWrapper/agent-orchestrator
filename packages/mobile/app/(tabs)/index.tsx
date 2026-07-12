import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { attentionOf, type DashboardSession } from "../../lib/api";
import { ProjectSwitcher } from "../../lib/ProjectSwitcher";
import { SessionCard } from "../../lib/SessionCard";
import { useApp, useVisibleSessions } from "../../lib/store";
import { attentionMeta, theme } from "../../lib/theme";
import { Button, ConnectionPill, EmptyState, ScreenHeader, SectionHeader } from "../../lib/ui";

type Section = { key: string; label: string; color: string; order: number; data: DashboardSession[] };

function groupByAttention(sessions: DashboardSession[]): Section[] {
	const buckets = new Map<string, DashboardSession[]>();
	for (const s of sessions) {
		const key = attentionOf(s);
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key)!.push(s);
	}
	return [...buckets.entries()]
		.map(([key, data]) => {
			const meta = attentionMeta[key] ?? {
				label: key,
				color: theme.textTertiary,
				order: 99,
			};
			return { key, label: meta.label, color: meta.color, order: meta.order, data };
		})
		.sort((a, b) => a.order - b.order);
}

export default function FleetScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { configured, loading, error, connection, config, refresh } = useApp();
	const sessions = useVisibleSessions();
	const [refreshing, setRefreshing] = useState(false);

	const sections = useMemo(() => groupByAttention(sessions), [sessions]);

	const counts = useMemo(() => {
		let working = 0,
			needsYou = 0,
			mergeable = 0;
		for (const s of sessions) {
			const a = attentionOf(s);
			if (a === "working") working++;
			else if (a === "respond" || a === "action") needsYou++;
			else if (a === "merge") mergeable++;
		}
		return { working, needsYou, mergeable };
	}, [sessions]);

	const onRefresh = useCallback(async () => {
		setRefreshing(true);
		await refresh();
		setRefreshing(false);
	}, [refresh]);

	if (!configured) {
		return (
			<View style={styles.screen}>
				<View style={{ height: insets.top }} />
				<EmptyState
					icon="server"
					title="Connect to AO"
					message="Point the app at your Agent Orchestrator server to start controlling your fleet."
					action={<Button title="Configure server" icon="settings" onPress={() => router.push("/settings")} />}
				/>
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			<View style={{ height: insets.top }} />
			<ScreenHeader title="Kanban" subtitle={config?.host} right={<ConnectionPill status={connection} />} />

			<View style={styles.stats}>
				<Stat n={counts.working} label="working" color={theme.orange} />
				<Stat n={counts.needsYou} label="need you" color={theme.amber} />
				<Stat n={counts.mergeable} label="mergeable" color={theme.green} />
			</View>

			<ProjectSwitcher />

			{loading && sessions.length === 0 ? (
				<View style={styles.center}>
					<ActivityIndicator color={theme.blue} />
				</View>
			) : (
				<SectionList
					sections={sections}
					keyExtractor={(item) => `${item.projectId}:${item.id}`}
					contentContainerStyle={{ paddingBottom: 120 }}
					stickySectionHeadersEnabled={false}
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.blue} />}
					renderSectionHeader={({ section }) => (
						<SectionHeader
							label={(section as Section).label}
							color={(section as Section).color}
							count={(section as Section).data.length}
						/>
					)}
					renderItem={({ item }) => <SessionCard session={item} showProject />}
					ListEmptyComponent={
						error ? (
							<EmptyState
								icon="wifi-off"
								title="Couldn't reach server"
								message={error}
								action={<Button title="Retry" icon="refresh-cw" variant="ghost" onPress={onRefresh} />}
							/>
						) : (
							<EmptyState
								icon="moon"
								title="No active agents"
								message="Spawn a worker to put your fleet to work."
								action={<Button title="New agent" icon="plus" onPress={() => router.push("/spawn")} />}
							/>
						)
					}
				/>
			)}

			{/* Spawn FAB */}
			<Pressable
				onPress={() => router.push("/spawn")}
				style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]}
			>
				<Feather name="plus" size={24} color="#06101f" />
			</Pressable>
		</View>
	);
}

function Stat({ n, label, color }: { n: number; label: string; color: string }) {
	return (
		<View style={styles.stat}>
			<Text style={[styles.statN, { color: n > 0 ? color : theme.textFaint }]}>{n}</Text>
			<Text style={styles.statLabel}>{label}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	center: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 },
	stats: {
		flexDirection: "row",
		gap: 10,
		paddingHorizontal: 16,
		paddingTop: 4,
		paddingBottom: 14,
	},
	stat: {
		flex: 1,
		backgroundColor: theme.bgElevated,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		paddingVertical: 12,
		paddingHorizontal: 14,
	},
	statN: { fontSize: 24, fontWeight: "800", fontFamily: theme.fontMono },
	statLabel: { color: theme.textTertiary, fontSize: 11, fontWeight: "600", marginTop: 2 },
	fab: {
		position: "absolute",
		right: 18,
		bottom: 24,
		width: 56,
		height: 56,
		borderRadius: 28,
		backgroundColor: theme.blue,
		alignItems: "center",
		justifyContent: "center",
		shadowColor: "#000",
		shadowOpacity: 0.4,
		shadowRadius: 12,
		shadowOffset: { width: 0, height: 4 },
		elevation: 8,
	},
});
