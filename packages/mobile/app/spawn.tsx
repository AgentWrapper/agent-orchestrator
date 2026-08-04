import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	InteractionManager,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
} from "react-native";
import { AgentLogo } from "../lib/AgentLogo";
import { agentErrorCopy } from "../lib/agentError";
import { defaultAgent, rankAgents } from "../lib/agentPicker";
import { ApiError, getAgents, type AgentCatalog } from "../lib/api";
import { classifyConnectionFailure, describeConnectionFailure } from "../lib/connectionError";
import { haptics } from "../lib/haptics";
import { agentSheetRoute, projectSheetRoute } from "../lib/sheetResult";
import { useApp } from "../lib/store";
import type { Theme } from "../lib/theme";
import { useTheme, useThemedStyles } from "../lib/ThemeProvider";
import { Button, SettingsGroup, SettingsRow } from "../lib/ui";
import { useT } from "../lib/i18n";

export default function SpawnModal() {
	const t = useTheme();
	const tr = useT();
	const styles = useThemedStyles(makeStyles);
	const router = useRouter();
	const { projects, activeProjectId, config, spawn } = useApp();

	const [projectId, setProjectId] = useState<string | null>(null);
	const [harness, setHarness] = useState("");
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	// Seed from the active project, or the only project. Mirrors the store's
	// `targetProject()`; kept here because the screen needs it as UI state to
	// drive the picker's value and the button's disabled state.
	useEffect(() => {
		if (projectId) return;
		if (activeProjectId !== "all") setProjectId(activeProjectId);
		else if (projects.length === 1) setProjectId(projects[0].id);
	}, [activeProjectId, projects, projectId]);

	useEffect(() => {
		if (!config) return;
		let cancelled = false;
		setLoading(true);
		getAgents(config)
			.then((c) => {
				if (cancelled) return;
				setCatalog(c);
				setCatalogError(null);
				setHarness((h) => h || (defaultAgent(rankAgents(c, tr)) ?? ""));
			})
			.catch((e) => {
				// Previously swallowed into `catalog = null`, which left an empty
				// picker and no way to tell the daemon was unreachable.
				if (!cancelled) setCatalogError(agentErrorCopy(e, tr));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [config]);

	// Refreshing the catalog moved into the agent sheet route, which owns its own
	// copy of it — see app/sheets/agent.tsx.
	const agents = useMemo(() => rankAgents(catalog, tr), [catalog, tr]);
	const selectedAgent = agents.find((a) => a.id === harness);
	const project = projects.find((p) => p.id === projectId);

	const onSpawn = async () => {
		// Validated on submit rather than by disabling the button — desktop's
		// choice, and the better one: a disabled button with no explanation is
		// worse than a message naming what is missing.
		if (!name.trim() || !prompt.trim()) {
			haptics.error();
			setError(tr("spawn.required"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const session = await spawn({
				projectId: projectId ?? undefined,
				prompt: prompt.trim() || undefined,
				issueId: name.trim() || undefined,
				harness: harness || undefined,
			});
			haptics.success();
			// Dismiss the modal first, then open the freshly spawned session's terminal
			// once the dismiss transition has settled. Firing both navigations in the
			// same tick overlaps their animations (the modal retracts while the session
			// is already sliding in); runAfterInteractions waits for the modal's
			// transition to finish so the two happen back-to-back, not on top of each
			// other. The session screen shows its own "connecting" state while the
			// terminal attaches, so landing on it before the PTY is ready is expected.
			router.back();
			InteractionManager.runAfterInteractions(() => {
				router.push({
					pathname: "/session/[id]",
					params: { id: session.id, projectId: session.projectId },
				});
			});
		} catch (e) {
			haptics.error();
			setError(spawnErrorCopy(e, tr));
			setBusy(false);
		}
	};

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
				<Text style={styles.lead}>{tr("spawn.lead")}</Text>

				<SettingsGroup footer={tr("spawn.agentsCached")}>
					<SettingsRow
						icon="folder"
						label={tr("spawn.project")}
						value={project?.name ?? tr("spawn.chooseProject")}
						onPress={() =>
							router.push(
								projectSheetRoute({
									selected: projectId ?? "",
									onSelect: setProjectId,
									// "All projects" is a filter — there is nothing to spawn into.
									includeAll: false,
									title: tr("spawn.project"),
									subtitle: tr("spawn.projectSubtitle"),
								}),
							)
						}
					/>
					<SettingsRow
						icon="cpu"
						label={tr("spawn.agent")}
						value={loading ? tr("common.loading") : (selectedAgent?.label ?? tr("spawn.chooseAgent"))}
						// The collapsed row carries the mark too, as desktop's trigger does.
						leading={selectedAgent ? <AgentLogo harness={selectedAgent.id} size={20} /> : undefined}
						disabled={loading}
						onPress={() => router.push(agentSheetRoute({ selected: harness, onSelect: setHarness }))}
					/>
				</SettingsGroup>

				{catalogError ? <Text style={styles.warn}>{catalogError}</Text> : null}

				<Text style={styles.label}>{tr("spawn.name")}</Text>
				<TextInput
					style={styles.input}
					value={name}
					onChangeText={setName}
					placeholder={tr("spawn.namePlaceholder")}
					placeholderTextColor={t.textFaint}
					autoCapitalize="sentences"
					returnKeyType="next"
				/>
				<Text style={styles.hint}>{tr("spawn.nameHint")}</Text>

				<Text style={styles.label}>{tr("spawn.task")}</Text>
				<TextInput
					style={[styles.input, styles.textarea]}
					value={prompt}
					onChangeText={setPrompt}
					placeholder={tr("spawn.taskPlaceholder")}
					placeholderTextColor={t.textFaint}
					multiline
					autoCapitalize="sentences"
				/>

				{error ? <Text style={styles.error}>{error}</Text> : null}

				<Button
					title={tr("spawn.submit")}
					icon="zap"
					loading={busy}
					onPress={onSpawn}
					disabled={!projectId}
					style={{ marginTop: 20 }}
				/>
				<Button title={tr("spawn.cancel")} variant="ghost" onPress={() => router.back()} style={{ marginTop: 10 }} />
			</ScrollView>

		</KeyboardAvoidingView>
	);
}

// Human copy for a failed spawn, matching every other screen. This one used to
// render `e.message` — the wire string, e.g. "401 - missing or invalid
// connection password".
function spawnErrorCopy(e: unknown, tr: import("../lib/i18n").TFunction): string {
	const status = e instanceof ApiError ? e.status : undefined;
	const { title, message } = describeConnectionFailure(
		classifyConnectionFailure(status),
		{ host: "", port: "", platform: Platform.OS },
		tr,
	);
	return `${title} ${message}`;
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
		screen: { flex: 1, backgroundColor: t.bgBase },
		lead: { color: t.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 22 },
		label: {
			color: t.textTertiary,
			fontSize: 11,
			letterSpacing: 1.2,
			fontWeight: "700",
			marginTop: 18,
			marginBottom: 8,
			marginLeft: 4,
		},
		input: {
			backgroundColor: t.bgElevated,
			borderColor: t.borderSubtle,
			borderWidth: 1,
			borderRadius: 12,
			color: t.textPrimary,
			paddingHorizontal: 14,
			paddingVertical: 12,
			fontSize: 15,
		},
		textarea: { minHeight: 96, textAlignVertical: "top" },
		hint: { color: t.textTertiary, fontSize: 12, lineHeight: 17, marginTop: 8, marginHorizontal: 4 },
		warn: { color: t.amber, fontSize: 13, lineHeight: 18, marginTop: 4 },
		error: { color: t.red, fontSize: 13, lineHeight: 18, marginTop: 16 },
	});
