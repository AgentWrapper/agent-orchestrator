import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	RefreshControl,
	ScrollView,
	SectionList,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { attentionOf, sessionTitle, type DashboardSession } from "../../lib/api";
import { ProjectSwitcher } from "../../lib/ProjectSwitcher";
import { BoardColumn, WideContainer, useBreakpoint } from "../../lib/responsive";
import { SessionCard } from "../../lib/SessionCard";
import { useApp, useVisibleSessions } from "../../lib/store";
import { attentionMeta, theme, type AttentionLevel } from "../../lib/theme";
import { Button, ConnectionPill, EmptyState, ScreenHeader, SectionHeader } from "../../lib/ui";

type Section = { key: string; label: string; color: string; order: number; data: DashboardSession[] };
type BoardLane = { key: string; label: string; color: string; levels: AttentionLevel[] };

const BOARD_LANES: BoardLane[] = [
	{ key: "working", label: "Working", color: theme.orange, levels: ["working"] },
	{ key: "needs-you", label: "Needs you", color: theme.amber, levels: ["action", "respond", "review"] },
	{ key: "in-review", label: "In review", color: theme.textTertiary, levels: ["pending"] },
	{ key: "ready", label: "Ready to merge", color: theme.green, levels: ["merge"] },
];

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

function groupForBoard(sessions: DashboardSession[]) {
	const lanes = new Map<string, DashboardSession[]>(BOARD_LANES.map((lane) => [lane.key, []]));
	const done: DashboardSession[] = [];

	for (const s of sessions) {
		const attention = attentionOf(s);
		if (attention === "done") {
			done.push(s);
			continue;
		}
		const lane = BOARD_LANES.find((candidate) => candidate.levels.includes(attention));
		lanes.get(lane?.key ?? "working")!.push(s);
	}

	return { lanes, done };
}

export default function FleetScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const wide = useBreakpoint() === "wide";
	const { configured, loading, error, connection, config, refresh } = useApp();
	const sessions = useVisibleSessions();
	const [refreshing, setRefreshing] = useState(false);
	const [doneExpanded, setDoneExpanded] = useState(false);

	const sections = useMemo(() => groupByAttention(sessions), [sessions]);
	const board = useMemo(() => groupForBoard(sessions), [sessions]);

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

	const stats = (
		<View style={styles.stats}>
			<Stat n={counts.working} label="working" color={theme.orange} />
			<Stat n={counts.needsYou} label="need you" color={theme.amber} />
			<Stat n={counts.mergeable} label="mergeable" color={theme.green} />
		</View>
	);

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

			{wide ? <WideContainer>{stats}</WideContainer> : stats}

			{wide ? (
				<WideContainer>
					<ProjectSwitcher />
				</WideContainer>
			) : (
				<ProjectSwitcher />
			)}

			{loading && sessions.length === 0 ? (
				<View style={styles.center}>
					<ActivityIndicator color={theme.blue} />
				</View>
			) : wide ? (
				<WideContainer style={styles.wideContent}>
					{error ? (
						<EmptyState
							icon="wifi-off"
							title="Couldn't reach server"
							message={error}
							action={<Button title="Retry" icon="refresh-cw" variant="ghost" onPress={onRefresh} />}
						/>
					) : (
						<>
							<View style={styles.board}>
								{BOARD_LANES.map((lane) => {
									const laneSessions = board.lanes.get(lane.key) ?? [];
									return (
										<BoardColumn key={lane.key} label={lane.label} color={lane.color} count={laneSessions.length}>
											{laneSessions.map((session) => (
												<SessionCard key={`${session.projectId}:${session.id}`} session={session} showProject />
											))}
										</BoardColumn>
									);
								})}
							</View>
							{board.done.length > 0 ? (
								<View style={styles.doneBar}>
									<Pressable
										accessibilityRole="button"
										accessibilityState={{ expanded: doneExpanded }}
										onPress={() => setDoneExpanded((v) => !v)}
										style={({ pressed }) => [styles.doneToggle, pressed && styles.doneTogglePressed]}
									>
										<Feather
											name="chevron-right"
											size={14}
											color={theme.textTertiary}
											style={[styles.doneChevron, doneExpanded && styles.doneChevronExpanded]}
										/>
										<Text style={styles.doneLabel}>DONE / TERMINATED</Text>
										<Text style={styles.doneCount}>{board.done.length}</Text>
									</Pressable>
									{doneExpanded ? (
										<ScrollView style={styles.doneListScroll} contentContainerStyle={styles.doneList}>
											{board.done.map((session) => (
												<Pressable
													key={`${session.projectId}:${session.id}`}
													onPress={() =>
														router.push({
															pathname: "/session/[id]",
															params: { id: session.id, projectId: session.projectId },
														})
													}
													style={({ pressed }) => [styles.doneItem, pressed && styles.doneItemPressed]}
												>
													<Text style={styles.doneItemTitle} numberOfLines={1}>
														{sessionTitle(session)}
													</Text>
												</Pressable>
											))}
										</ScrollView>
									) : null}
								</View>
							) : null}
						</>
					)}
				</WideContainer>
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
	wideContent: {
		flex: 1,
		minHeight: 0,
		paddingHorizontal: 16,
		paddingBottom: 12,
	},
	board: {
		flex: 1,
		minHeight: 0,
		flexDirection: "row",
		gap: 8,
	},
	doneBar: {
		marginTop: 8,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		backgroundColor: theme.bgColumn,
		overflow: "hidden",
	},
	doneToggle: {
		minHeight: 46,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 14,
	},
	doneTogglePressed: { backgroundColor: theme.bgElevatedHover },
	doneChevron: { transform: [{ rotate: "0deg" }] },
	doneChevronExpanded: { transform: [{ rotate: "90deg" }] },
	doneLabel: {
		flex: 1,
		color: theme.textSecondary,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.2,
	},
	doneCount: {
		color: theme.textTertiary,
		fontSize: 12,
		fontWeight: "700",
		fontFamily: theme.fontMono,
	},
	doneList: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		paddingHorizontal: 12,
		paddingBottom: 12,
	},
	doneListScroll: { maxHeight: 160 },
	doneItem: {
		maxWidth: 260,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		backgroundColor: theme.bgElevated,
		paddingHorizontal: 10,
		paddingVertical: 7,
	},
	doneItemPressed: { backgroundColor: theme.bgElevatedHover, borderColor: theme.borderDefault },
	doneItemTitle: { color: theme.textSecondary, fontSize: 12 },
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
