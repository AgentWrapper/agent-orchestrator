import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useApp } from "../lib/store";
import { theme } from "../lib/theme";
import { Button, Pill } from "../lib/ui";

// Common agent harnesses. The daemon needs one unless the project configures a
// default worker.agent; claude-code is the safe default in this environment.
const HARNESSES = ["claude-code", "codex", "cursor", "opencode", "aider", "amp", "copilot"];

export default function SpawnModal() {
	const router = useRouter();
	const { projects, activeProjectId, spawn } = useApp();
	const [projectId, setProjectId] = useState<string | null>(null);
	const [harness, setHarness] = useState<string>("claude-code");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Default to the active project, else the only project.
	useEffect(() => {
		if (projectId) return;
		if (activeProjectId !== "all") setProjectId(activeProjectId);
		else if (projects.length === 1) setProjectId(projects[0].id);
	}, [activeProjectId, projects, projectId]);

	const onSpawn = async () => {
		if (!projectId) {
			setError("Pick a project first.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await spawn(prompt.trim() || undefined, projectId, harness);
			router.back();
		} catch (e) {
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
				<View style={styles.projects}>
					{projects.map((p) => (
						<Pill key={p.id} label={p.name} active={projectId === p.id} onPress={() => setProjectId(p.id)} />
					))}
				</View>

				<Text style={[styles.label, { marginTop: 20 }]}>AGENT</Text>
				<View style={styles.projects}>
					{HARNESSES.map((h) => (
						<Pill key={h} label={h} active={harness === h} onPress={() => setHarness(h)} />
					))}
				</View>

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
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	lead: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 22 },
	label: { color: theme.textTertiary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 10 },
	projects: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
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
});
