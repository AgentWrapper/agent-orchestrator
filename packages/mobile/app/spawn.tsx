import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { getAgents, refreshAgents, type AgentCatalog, type AgentInfo } from "../lib/api";
import { haptics } from "../lib/haptics";
import { useApp } from "../lib/store";
import { theme } from "../lib/theme";
import { Button } from "../lib/ui";

type RankedAgent = AgentInfo & {
	rank: number;
	reason: string;
	selectable: boolean;
};

function rankAgents(catalog: AgentCatalog): RankedAgent[] {
	const authorizedIds = new Set(catalog.authorized.map((a) => a.id));
	const installedById = new Map(catalog.installed.map((a) => [a.id, a]));
	return catalog.supported
		.map((agent) => {
			const installed = installedById.get(agent.id);
			const authStatus = installed?.authStatus;
			const isAuthorized = authorizedIds.has(agent.id) || authStatus === "authorized";
			const isAuthUnknown = !!installed && !isAuthorized && authStatus !== "unauthorized";
			const isSelectable = isAuthorized || isAuthUnknown;
			const rank = isAuthorized ? 0 : isAuthUnknown ? 1 : installed ? 2 : 3;
			const reason = !installed ? "Needs install" : isAuthUnknown ? "Auth unknown" : !isAuthorized ? "Needs auth" : "";
			return { ...agent, rank, reason, selectable: isSelectable };
		})
		.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

export default function SpawnModal() {
	const router = useRouter();
	const { projects, activeProjectId, config, spawn } = useApp();
	const [projectId, setProjectId] = useState<string | null>(null);
	const [harness, setHarness] = useState("");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);

	// Default to the active project, else the only project.
	useEffect(() => {
		if (projectId) return;
		if (activeProjectId !== "all") setProjectId(activeProjectId);
		else if (projects.length === 1) setProjectId(projects[0].id);
	}, [activeProjectId, projects, projectId]);

	// Fetch agent catalog from the daemon.
	useEffect(() => {
		if (!config) return;
		let cancelled = false;
		setLoading(true);
		getAgents(config)
			.then((c) => {
				if (cancelled) return;
				setCatalog(c);
				const ranked = rankAgents(c);
				const first = ranked.find((a) => a.selectable) ?? ranked[0];
				if (first && !harness) setHarness(first.id);
			})
			.catch(() => {
				if (!cancelled) setCatalog(null);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [config]);

	const handleRefresh = async () => {
		if (!config || refreshing) return;
		setRefreshing(true);
		try {
			const c = await refreshAgents(config);
			setCatalog(c);
			const ranked = rankAgents(c);
			const first = ranked.find((a) => a.selectable) ?? ranked[0];
			if (first && !harness) setHarness(first.id);
		} catch {
			// keep existing catalog
		} finally {
			setRefreshing(false);
		}
	};

	const rankedAgents = useMemo(() => (catalog ? rankAgents(catalog) : []), [catalog]);
	const selectedAgent = rankedAgents.find((a) => a.id === harness);

	const onSpawn = async () => {
		if (!projectId) {
			setError("Pick a project first.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await spawn(prompt.trim() || undefined, projectId, harness || undefined);
			haptics.success();
			router.back();
		} catch (e) {
			haptics.error();
			setError(e instanceof Error ? e.message : "Failed to spawn agent.");
			setBusy(false);
		}
	};

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
				<Text style={styles.lead}>
					Spawn a worker agent. It gets its own git worktree and branch, then starts on the task you give it.
				</Text>

				<Text style={styles.label}>PROJECT</Text>
				<View style={styles.chips}>
					{projects.map((p) => (
						<Pressable
							key={p.id}
							style={[styles.chip, projectId === p.id && styles.chipActive]}
							onPress={() => {
								haptics.select();
								setProjectId(p.id);
							}}
						>
							<Text style={[styles.chipText, projectId === p.id && styles.chipTextActive]}>{p.name}</Text>
						</Pressable>
					))}
				</View>

				<View style={[styles.labelRow, { marginTop: 20 }]}>
					<Text style={styles.label}>AGENT</Text>
					<Pressable onPress={handleRefresh} disabled={loading || refreshing}>
						<Text style={styles.refreshLink}>{refreshing ? "Refreshing..." : "Refresh"}</Text>
					</Pressable>
				</View>

				<Pressable style={styles.pickerTrigger} onPress={() => setPickerOpen(true)} disabled={loading}>
					<Text style={[styles.pickerTriggerText, !selectedAgent && styles.pickerPlaceholder]}>
						{loading ? "Loading agents..." : selectedAgent ? selectedAgent.label : "Select agent"}
					</Text>
					<Feather name={loading ? "loader" : "chevron-down"} size={16} color={theme.textTertiary} />
				</Pressable>

				{catalog && rankedAgents.length === 0 && (
					<Text style={styles.hint}>No agents found. Is the daemon reachable?</Text>
				)}

				<Text style={[styles.label, { marginTop: 20 }]}>TASK (OPTIONAL)</Text>
				<TextInput
					style={styles.input}
					value={prompt}
					onChangeText={setPrompt}
					placeholder="e.g. Fix the flaky login test and open a PR"
					placeholderTextColor={theme.textTertiary}
					multiline
					autoCapitalize="sentences"
				/>

				{error ? <Text style={styles.error}>{error}</Text> : null}

				<Button
					title="Spawn agent"
					icon="zap"
					loading={busy}
					onPress={onSpawn}
					disabled={!projectId}
					style={{ marginTop: 20 }}
				/>
				<Button title="Cancel" variant="ghost" onPress={() => router.back()} style={{ marginTop: 10 }} />
			</ScrollView>

			<Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
				<Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>Select agent</Text>
						<ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
							{rankedAgents.map((a) => (
								<Pressable
									key={a.id}
									style={[styles.modalItem, harness === a.id && styles.modalItemActive]}
									onPress={() => {
										if (a.selectable) {
											haptics.select();
											setHarness(a.id);
											setPickerOpen(false);
										}
									}}
								>
									<View style={{ flex: 1 }}>
										<Text
											style={[
												styles.modalItemLabel,
												harness === a.id && styles.modalItemLabelActive,
												!a.selectable && styles.modalItemLabelMuted,
											]}
										>
											{a.label}
										</Text>
									</View>
									{a.reason ? (
										<View style={styles.modalItemReasonRow}>
											{a.reason === "Auth unknown" ? (
												<Feather name="alert-triangle" size={12} color={theme.amber} style={{ marginRight: 4 }} />
											) : null}
											<Text style={[styles.modalItemReason, a.reason === "Auth unknown" && { color: theme.amber }]}>
												{a.reason}
											</Text>
										</View>
									) : harness === a.id ? (
										<Feather name="check" size={16} color={theme.blue} />
									) : null}
								</Pressable>
							))}
						</ScrollView>
						<Button title="Cancel" variant="ghost" onPress={() => setPickerOpen(false)} style={{ marginTop: 8 }} />
					</Pressable>
				</Pressable>
			</Modal>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	lead: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 22 },
	label: { color: theme.textTertiary, fontSize: 10, letterSpacing: 1, fontWeight: "700" },
	labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
	refreshLink: { color: theme.blue, fontSize: 12, fontWeight: "600" },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },

	chip: {
		paddingHorizontal: 14,
		paddingVertical: 7,
		borderRadius: 20,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		backgroundColor: theme.bgElevated,
	},
	chipActive: { backgroundColor: theme.tintBlue, borderColor: theme.blue },
	chipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
	chipTextActive: { color: theme.blue },

	pickerTrigger: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		backgroundColor: theme.bgElevated,
		borderColor: theme.borderDefault,
		borderWidth: 1,
		borderRadius: 10,
		paddingHorizontal: 14,
		paddingVertical: 13,
	},
	pickerTriggerText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600", flex: 1 },
	pickerPlaceholder: { color: theme.textTertiary, fontWeight: "400" },

	hint: { color: theme.textTertiary, fontSize: 12, marginTop: 6 },

	input: {
		backgroundColor: theme.bgElevated,
		borderColor: theme.borderDefault,
		borderWidth: 1,
		borderRadius: 10,
		color: theme.textPrimary,
		paddingHorizontal: 12,
		paddingVertical: 12,
		fontSize: 14,
		minHeight: 96,
		textAlignVertical: "top",
	},
	error: { color: theme.red, fontSize: 13, marginTop: 14 },

	modalBackdrop: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		padding: 24,
	},
	modalCard: {
		width: "100%",
		maxWidth: 380,
		maxHeight: "70%",
		backgroundColor: theme.bgElevated,
		borderRadius: 14,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		padding: 20,
	},
	modalTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "700", marginBottom: 14 },
	modalList: { maxHeight: 320 },
	modalItem: {
		flexDirection: "row",
		alignItems: "center",
		paddingVertical: 12,
		paddingHorizontal: 12,
		borderRadius: 8,
		marginBottom: 4,
	},
	modalItemActive: { backgroundColor: theme.tintBlue },
	modalItemLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
	modalItemLabelActive: { color: theme.blue },
	modalItemLabelMuted: { color: theme.textTertiary },
	modalItemReasonRow: { flexDirection: "row", alignItems: "center", marginLeft: 8 },
	modalItemReason: { color: theme.textTertiary, fontSize: 11 },
});
