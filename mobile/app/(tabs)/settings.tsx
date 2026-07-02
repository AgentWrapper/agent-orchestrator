import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pingServer } from "../../lib/api";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type ServerConfig } from "../../lib/config";
import { useApp } from "../../lib/store";
import { theme } from "../../lib/theme";
import { Button, ConnectionPill, ScreenHeader } from "../../lib/ui";

export default function SettingsScreen() {
	const insets = useSafeAreaInsets();
	const { reloadConfig, projects, connection } = useApp();
	const [cfg, setCfg] = useState<ServerConfig>(DEFAULT_CONFIG);
	const [loaded, setLoaded] = useState(false);
	const [testing, setTesting] = useState(false);
	const [saved, setSaved] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

	useEffect(() => {
		loadConfig().then((c) => {
			setCfg(c);
			setLoaded(true);
		});
	}, []);

	const set = (k: keyof ServerConfig) => (v: string) => setCfg((prev) => ({ ...prev, [k]: v }));

	async function test() {
		setTesting(true);
		setResult(null);
		try {
			await saveConfig(cfg);
			const count = await pingServer(cfg);
			setResult({ ok: true, msg: `Connected — ${count} session(s) found.` });
			await reloadConfig();
		} catch (e) {
			setResult({ ok: false, msg: e instanceof Error ? e.message : "Could not reach server." });
		} finally {
			setTesting(false);
		}
	}

	async function save() {
		await saveConfig(cfg);
		await reloadConfig();
		setSaved(true);
		setTimeout(() => setSaved(false), 1800);
	}

	if (!loaded) {
		return (
			<View style={styles.center}>
				<ActivityIndicator color={theme.blue} />
			</View>
		);
	}

	return (
		<KeyboardAvoidingView
			style={{ flex: 1, backgroundColor: theme.bgBase }}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<View style={{ height: insets.top }} />
			<ScreenHeader title="Settings" right={<ConnectionPill status={connection} />} />
			<ScrollView
				style={styles.screen}
				contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
				keyboardShouldPersistTaps="handled"
			>
				<Text style={styles.sectionTitle}>SERVER</Text>
				<Text style={styles.intro}>
					Point the app at your AO server — your PC's Tailscale name / 100.x address (or LAN IP on the same Wi-Fi).
				</Text>

				<Field
					label="HOST"
					value={cfg.host}
					onChangeText={set("host")}
					placeholder="my-pc.tailXXXX.ts.net  or  192.168.x.x"
					autoCapitalize="none"
					keyboardType="url"
				/>
				<View style={styles.row}>
					<View style={{ flex: 1, marginRight: 8 }}>
						<Field label="API PORT" value={cfg.httpPort} onChangeText={set("httpPort")} keyboardType="number-pad" />
					</View>
					<View style={{ flex: 1, marginLeft: 8 }}>
						<Field label="TERMINAL PORT" value={cfg.muxPort} onChangeText={set("muxPort")} keyboardType="number-pad" />
					</View>
				</View>

				<View style={styles.toggleRow}>
					<View style={{ flex: 1 }}>
						<Text style={styles.toggleLabel}>Use TLS (https / wss)</Text>
						<Text style={styles.toggleHint}>On only if AO is served over HTTPS (e.g. a Tailscale funnel).</Text>
					</View>
					<Switch
						value={!!cfg.secure}
						onValueChange={(v) => setCfg((prev) => ({ ...prev, secure: v }))}
						trackColor={{ true: theme.blue, false: theme.borderStrong }}
					/>
				</View>

				<Button
					title="Test connection"
					variant="ghost"
					icon="activity"
					loading={testing}
					onPress={test}
					style={{ marginTop: 4 }}
				/>
				{result && (
					<View style={[styles.resultBox, { borderColor: result.ok ? theme.tintGreen : theme.tintRed }]}>
						<Feather
							name={result.ok ? "check-circle" : "alert-circle"}
							size={15}
							color={result.ok ? theme.green : theme.red}
						/>
						<Text style={[styles.result, { color: result.ok ? theme.green : theme.red }]}>{result.msg}</Text>
					</View>
				)}
				<Button
					title={saved ? "Saved ✓" : "Save"}
					icon={saved ? undefined : "save"}
					onPress={save}
					disabled={!cfg.host.trim()}
					style={{ marginTop: 12 }}
				/>

				<Text style={[styles.sectionTitle, { marginTop: 32 }]}>PROJECTS</Text>
				{projects.length === 0 ? (
					<Text style={styles.intro}>No projects found. Add a project from the AO dashboard.</Text>
				) : (
					projects.map((p) => (
						<View key={p.id} style={styles.projRow}>
							<Feather name="folder" size={16} color={theme.textTertiary} />
							<Text style={styles.projName}>{p.name}</Text>
							{p.sessionPrefix ? <Text style={styles.projPrefix}>{p.sessionPrefix}</Text> : null}
						</View>
					))
				)}
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

function Field(props: {
	label: string;
	value: string;
	onChangeText: (v: string) => void;
	placeholder?: string;
	autoCapitalize?: "none" | "sentences";
	keyboardType?: "default" | "url" | "number-pad";
}) {
	return (
		<View style={styles.field}>
			<Text style={styles.label}>{props.label}</Text>
			<TextInput
				style={styles.input}
				value={props.value}
				onChangeText={props.onChangeText}
				placeholder={props.placeholder}
				placeholderTextColor={theme.textTertiary}
				autoCapitalize={props.autoCapitalize}
				autoCorrect={false}
				keyboardType={props.keyboardType}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.bgBase },
	sectionTitle: { color: theme.textTertiary, fontSize: 11, letterSpacing: 1.2, fontWeight: "700", marginBottom: 10 },
	intro: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 18 },
	field: { marginBottom: 16 },
	row: { flexDirection: "row" },
	label: { color: theme.textTertiary, fontSize: 10, letterSpacing: 1, marginBottom: 6, fontWeight: "600" },
	input: {
		backgroundColor: theme.bgElevated,
		borderColor: theme.borderDefault,
		borderWidth: 1,
		borderRadius: 10,
		color: theme.textPrimary,
		paddingHorizontal: 12,
		paddingVertical: 12,
		fontSize: 14,
	},
	resultBox: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 12,
		padding: 12,
		borderRadius: 10,
		borderWidth: 1,
		backgroundColor: theme.bgElevated,
	},
	result: { fontSize: 13, lineHeight: 18, flex: 1 },
	toggleRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingVertical: 6,
		marginBottom: 8,
	},
	toggleLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
	toggleHint: { color: theme.textTertiary, fontSize: 12, marginTop: 2, lineHeight: 16 },
	projRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 13,
		paddingHorizontal: 14,
		backgroundColor: theme.bgElevated,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		marginBottom: 8,
	},
	projName: { color: theme.textPrimary, fontSize: 14, fontWeight: "600", flex: 1 },
	projPrefix: { color: theme.textTertiary, fontSize: 12, fontFamily: theme.fontMono },
});
