import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { attentionOf, type DashboardSession, type OrchestratorLink } from "../../lib/api";
import { CardGrid, WideContainer, useBreakpoint } from "../../lib/responsive";
import { useApp } from "../../lib/store";
import { attentionMeta, statusVisual, theme, type AttentionLevel, type StatusVisual } from "../../lib/theme";
import { Button, ConnectionPill, Dot, EmptyState, ScreenHeader } from "../../lib/ui";

const ZONE_ORDER: AttentionLevel[] = ["merge", "respond", "review", "pending", "working", "done"];

export default function OrchestratorScreen() {
	const insets = useSafeAreaInsets();
	const wide = useBreakpoint() === "wide";
	const { configured, connection, projects, sessions, orchestrators, refresh } = useApp();
	const [refreshing, setRefreshing] = useState(false);

	// Always show every project's orchestrator here - no per-project filtering.
	const visibleProjects = projects;

	const onRefresh = async () => {
		setRefreshing(true);
		await refresh();
		setRefreshing(false);
	};

	if (!configured) {
		return (
			<View style={styles.screen}>
				<View style={{ height: insets.top }} />
				<EmptyState icon="share-2" title="No server" message="Connect to AO in Settings." />
			</View>
		);
	}

	const cards = visibleProjects.map((p) => {
		const link = orchestrators.find((o) => o.projectId === p.id) ?? null;
		const workers = sessions.filter((s) => s.projectId === p.id && s.id !== link?.id);
		return (
			<OrchestratorCard
				key={p.id}
				projectId={p.id}
				projectName={p.name}
				link={link}
				workerCount={workers.length}
				zones={zoneCounts(workers)}
				wide={wide}
			/>
		);
	});

	return (
		<View style={styles.screen}>
			<View style={{ height: insets.top }} />
			<ScreenHeader
				title="Orchestrator"
				subtitle="Orchestrators direct your worker agents"
				right={<ConnectionPill status={connection} />}
			/>

			<ScrollView
				contentContainerStyle={wide ? styles.wideScrollContent : styles.scrollContent}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.blue} />}
			>
				{visibleProjects.length === 0 ? (
					<EmptyState icon="folder" title="No projects" message="Add a project in AO to get started." />
				) : wide ? (
					<WideContainer style={styles.wideGrid}>
						<CardGrid cardBasis={440} maxCardWidth={560}>
							{cards}
						</CardGrid>
					</WideContainer>
				) : (
					cards
				)}
			</ScrollView>
		</View>
	);
}

function zoneCounts(sessions: DashboardSession[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of sessions) {
		const a = attentionOf(s);
		out[a] = (out[a] ?? 0) + 1;
	}
	return out;
}

function OrchestratorCard({
	projectId,
	projectName,
	link,
	workerCount,
	zones,
	wide,
}: {
	projectId: string;
	projectName: string;
	link: OrchestratorLink | null;
	workerCount: number;
	zones: Record<string, number>;
	wide?: boolean;
}) {
	const router = useRouter();
	const { launchConductor } = useApp();
	const [busy, setBusy] = useState(false);

	// The link only appears when an orchestrator exists - so its presence means
	// it's openable. Some AO builds add hasRuntime/isTerminal; treat those as
	// "stopped" only when explicitly flagged, never on a missing field.
	const present = !!link?.id;
	const stopped = present && (link.hasRuntime === false || link.isTerminal === true);
	const open = present && !stopped;
	const v: StatusVisual = link?.status ? statusVisual(link.status) : { color: theme.blue, label: "Online" };

	const openTerminal = (id: string) => router.push({ pathname: "/session/[id]", params: { id, projectId } });

	const onLaunch = async (clean: boolean) => {
		setBusy(true);
		try {
			const l = await launchConductor(projectId, clean);
			if (l?.id) openTerminal(l.id);
		} catch (e) {
			Alert.alert("Could not launch", e instanceof Error ? e.message : "Unknown error");
		} finally {
			setBusy(false);
		}
	};

	return (
		<View style={[styles.card, wide && styles.cardWide]}>
			<View style={styles.head}>
				<View style={styles.orgIcon}>
					<Feather name="share-2" size={18} color={theme.blue} />
				</View>
				<View style={{ flex: 1 }}>
					<Text style={styles.projName}>{projectName}</Text>
					<View style={styles.statusRow}>
						<Dot
							color={open ? v.color : stopped ? theme.textTertiary : theme.textFaint}
							size={7}
							breathing={!!(open && v.breathing)}
						/>
						<Text
							style={[styles.statusText, { color: open ? v.color : stopped ? theme.textTertiary : theme.textFaint }]}
						>
							{open ? v.label : stopped ? "Stopped" : "Not started"}
						</Text>
						<Text style={styles.workers}>
							- {workerCount} worker{workerCount === 1 ? "" : "s"}
						</Text>
					</View>
				</View>
			</View>

			{workerCount > 0 ? (
				<View style={styles.zones}>
					{ZONE_ORDER.filter((z) => zones[z]).map((z) => {
						const m = attentionMeta[z];
						return (
							<View key={z} style={[styles.zonePill, { backgroundColor: m.tint }]}>
								<Dot color={m.color} size={6} />
								<Text style={[styles.zoneN, { color: m.color }]}>{zones[z]}</Text>
								<Text style={styles.zoneLabel}>{m.label}</Text>
							</View>
						);
					})}
				</View>
			) : null}

			<View style={[styles.actions, wide && styles.actionsWide]}>
				{open ? (
					<>
						<Button
							title="Open orchestrator"
							icon="terminal"
							onPress={() => openTerminal(link.id)}
							style={wide ? styles.contentBtn : styles.flexBtn}
						/>
						<Button title="Restart" variant="ghost" icon="rotate-ccw" loading={busy} onPress={() => onLaunch(false)} />
					</>
				) : (
					<Button
						title={present ? "Restart orchestrator" : "Spawn orchestrator"}
						icon="play"
						loading={busy}
						onPress={() => onLaunch(present)}
						style={wide ? styles.contentBtn : styles.flexBtn}
					/>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	scrollContent: { paddingBottom: 110, paddingTop: 4 },
	wideScrollContent: { paddingBottom: 110, paddingTop: 4 },
	wideGrid: { paddingHorizontal: 16 },
	card: {
		backgroundColor: theme.bgElevated,
		borderRadius: 14,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		padding: 16,
		marginHorizontal: 12,
		marginVertical: 6,
	},
	cardWide: { width: "100%", marginHorizontal: 0, marginVertical: 0 },
	head: { flexDirection: "row", alignItems: "center", gap: 12 },
	orgIcon: {
		width: 40,
		height: 40,
		borderRadius: 11,
		backgroundColor: theme.tintBlue,
		alignItems: "center",
		justifyContent: "center",
	},
	projName: { color: theme.textPrimary, fontSize: 17, fontWeight: "700" },
	statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
	statusText: { fontSize: 12, fontWeight: "600" },
	workers: { color: theme.textTertiary, fontSize: 12 },
	zones: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 14 },
	zonePill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		paddingHorizontal: 9,
		paddingVertical: 5,
		borderRadius: 8,
	},
	zoneN: { fontSize: 12, fontWeight: "800", fontFamily: theme.fontMono },
	zoneLabel: { color: theme.textSecondary, fontSize: 11, fontWeight: "600" },
	actions: { flexDirection: "row", gap: 8, marginTop: 16 },
	actionsWide: { flexWrap: "wrap" },
	flexBtn: { flex: 1 },
	contentBtn: {},
});
