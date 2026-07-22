import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
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
import { haptics } from "../../lib/haptics";
import { getPushStatus, openNotificationSettings, type PushStatus, registerForPush } from "../../lib/push";
import { useApp } from "../../lib/store";
import { theme } from "../../lib/theme";
import { useTabScrollToTop } from "../../lib/useTabScrollToTop";
import { Button, ConnectionPill, ScreenHeader } from "../../lib/ui";

export default function SettingsScreen() {
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const { reloadConfig, projects, connection, setActiveProject } = useApp();

	const scrollRef = useTabScrollToTop<ScrollView>();

	// Tapping a project scopes the Kanban board to it and jumps to that tab.
	const openProject = (id: string) => {
		setActiveProject(id);
		router.navigate("/");
	};
	const [cfg, setCfg] = useState<ServerConfig>(DEFAULT_CONFIG);
	const [loaded, setLoaded] = useState(false);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
	const [pwPromptOpen, setPwPromptOpen] = useState(false);
	const [pwDraft, setPwDraft] = useState("");

	// Reload the saved config every time the screen regains focus — not just on
	// mount — so returning from the QR scanner (which writes host/port to storage
	// then navigates back here) repaints the fields with the scanned values.
	useFocusEffect(
		useCallback(() => {
			loadConfig().then((c) => {
				setCfg(c);
				setLoaded(true);
			});
		}, []),
	);

	// Once the background poller reports a live connection, drop any stale error
	// banner (e.g. a leftover 401/429 from an earlier failed attempt) so the UI
	// doesn't show a scary error while the app is actually connected. A success
	// message is kept.
	useEffect(() => {
		if (connection === "open") {
			setResult((r) => (r && !r.ok ? null : r));
		}
	}, [connection]);

	const set = (k: keyof ServerConfig) => (v: string) => setCfg((prev) => ({ ...prev, [k]: v }));

	async function test(target: ServerConfig = cfg) {
		setTesting(true);
		setResult(null);
		try {
			await saveConfig(target);
			const count = await pingServer(target);
			haptics.success();
			setResult({ ok: true, msg: `Connected — ${count} session(s) found.` });
			await reloadConfig();
		} catch (e) {
			haptics.error();
			const msg = e instanceof Error ? e.message : "Could not reach server.";
			setResult({ ok: false, msg });
			// Wrong/missing password — reopen the prompt instead of leaving the
			// user stuck on a silent 401.
			if (msg.startsWith("401")) {
				setPwDraft(target.password);
				setPwPromptOpen(true);
			}
		} finally {
			setTesting(false);
		}
	}

	// Save now behaves like Connect: it prompts for the password when none is set
	// (so it can't silently persist a passwordless config that never connects),
	// then tests + persists and reports the result. test() already calls
	// saveConfig, so the config is persisted on the way.
	function save() {
		if (!cfg.password.trim()) {
			setPwDraft("");
			setPwPromptOpen(true);
			return;
		}
		void test();
	}

	// The primary "Connect" action — gated behind a password prompt the first
	// time (no password saved yet). Once a password is saved it persists in
	// AsyncStorage with the rest of the config, so subsequent connects skip
	// straight to test().
	function connect() {
		if (!cfg.password.trim()) {
			setPwDraft("");
			setPwPromptOpen(true);
			return;
		}
		test();
	}

	function submitPassword() {
		const next = { ...cfg, password: pwDraft };
		setCfg(next);
		setPwPromptOpen(false);
		test(next);
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
				ref={scrollRef}
				style={styles.screen}
				contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
				keyboardShouldPersistTaps="handled"
			>
				<Text style={styles.sectionTitle}>SERVER</Text>
				<Text style={styles.intro}>
					Point the app at your AO server - your PC's Tailscale name / 100.x address (or LAN IP on the same Wi-Fi).
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

				<Field
					label="PASSWORD"
					value={cfg.password}
					onChangeText={set("password")}
					placeholder="Daemon connection password"
					autoCapitalize="none"
					secureTextEntry
				/>

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
					title="Scan QR"
					variant="ghost"
					icon="camera"
					onPress={() => router.navigate("/pair")}
					style={{ marginTop: 4, marginBottom: 12 }}
				/>

				<Button
					title="Test connection"
					variant="ghost"
					icon="activity"
					loading={testing}
					onPress={connect}
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
					title="Save & connect"
					icon="save"
					loading={testing}
					onPress={save}
					disabled={!cfg.host.trim()}
					style={{ marginTop: 12 }}
				/>

				<Text style={[styles.sectionTitle, { marginTop: 32 }]}>PROJECTS</Text>
				{projects.length === 0 ? (
					<Text style={styles.intro}>No projects found. Add a project from the AO dashboard.</Text>
				) : (
					projects.map((p) => (
						<Pressable
							key={p.id}
							onPress={() => openProject(p.id)}
							style={({ pressed }) => [styles.projRow, pressed && styles.projRowPressed]}
						>
							<Feather name="folder" size={16} color={theme.textTertiary} />
							<Text style={styles.projName}>{p.name}</Text>
							{p.sessionPrefix ? <Text style={styles.projPrefix}>{p.sessionPrefix}</Text> : null}
							<Feather name="chevron-right" size={16} color={theme.textTertiary} />
						</Pressable>
					))
				)}

				<NotificationsSection />
			</ScrollView>

			<Modal visible={pwPromptOpen} transparent animationType="fade" onRequestClose={() => setPwPromptOpen(false)}>
				<View style={styles.modalBackdrop}>
					<View style={styles.modalCard}>
						<Text style={styles.modalTitle}>Enter password</Text>
						<Text style={styles.toggleHint}>Required to connect to this AO server.</Text>
						<TextInput
							style={[styles.input, { marginTop: 14 }]}
							value={pwDraft}
							onChangeText={setPwDraft}
							placeholder="Password"
							placeholderTextColor={theme.textTertiary}
							autoCapitalize="none"
							autoCorrect={false}
							secureTextEntry
							autoFocus
							onSubmitEditing={submitPassword}
						/>
						<View style={styles.modalRow}>
							<Button
								title="Cancel"
								variant="ghost"
								onPress={() => setPwPromptOpen(false)}
								style={{ flex: 1, marginRight: 8 }}
							/>
							<Button title="Connect" onPress={submitPassword} style={{ flex: 1, marginLeft: 8 }} />
						</View>
					</View>
				</View>
			</Modal>
		</KeyboardAvoidingView>
	);
}

// Describes the current push state as a label/hint and the single action that
// moves it forward, so the section renders one clear next step.
function describePush(
	status: PushStatus | null,
	hasConfig: boolean,
): { label: string; hint: string; action: string | null } {
	if (!status) return { label: "Checking…", hint: "", action: null };
	if (!status.supported) {
		return { label: "Not available", hint: "Push notifications need a physical device.", action: null };
	}
	if (status.granted && status.registered) {
		return { label: "On", hint: "You'll be alerted when an agent needs you or a PR is ready.", action: null };
	}
	if (status.granted && !status.registered) {
		return {
			label: "Permission granted",
			hint: hasConfig
				? "This device isn't registered yet. Tap to register with your server."
				: "Connect to a server first, then this device registers automatically.",
			action: hasConfig ? "Register" : null,
		};
	}
	if (!status.granted && status.canAskAgain) {
		return { label: "Off", hint: "Turn on alerts for agents that need input and PR updates.", action: "Enable" };
	}
	// Permanently denied — only system settings can flip it back on.
	return { label: "Blocked", hint: "Notifications are turned off for AO in system settings.", action: "Open settings" };
}

// Settings section that surfaces push-notification status and the one action to
// advance it: request permission, register, or (after a permanent denial) open
// the OS settings. Closes the "denied on first try, no way back" gap.
function NotificationsSection() {
	const { config, connection } = useApp();
	const [status, setStatus] = useState<PushStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(() => {
		getPushStatus()
			.then(setStatus)
			.catch(() => {});
	}, []);

	// Reload on focus and whenever the connection flips (registration happens on
	// a successful connect, so the status can change without user action here).
	useFocusEffect(useCallback(() => refresh(), [refresh]));
	useEffect(() => refresh(), [connection, refresh]);

	const { label, hint, action } = describePush(status, !!config);

	async function onAction() {
		if (!status) return;
		setBusy(true);
		try {
			if (!status.granted && !status.canAskAgain) {
				await openNotificationSettings();
			} else if (config) {
				// Requests permission if needed, then registers with the daemon.
				// A null result means the build couldn't mint a token (most often an
				// iOS local build with no APNs entitlement) — say so instead of a
				// silent no-op.
				const token = await registerForPush(config);
				if (token) {
					haptics.success();
				} else {
					haptics.error();
					Alert.alert(
						"Couldn't enable push on this build",
						Platform.OS === "ios"
							? "A local iOS build has no push entitlement, so it can't receive notifications. Install an EAS build (with an APNs key) to test push on iOS."
							: "Couldn't register a push token. Check that notifications are allowed and that you're connected to your server.",
					);
				}
			}
		} finally {
			setBusy(false);
			refresh();
		}
	}

	return (
		<>
			<Text style={[styles.sectionTitle, { marginTop: 32 }]}>NOTIFICATIONS</Text>
			<View style={styles.notifCard}>
				<View style={{ flex: 1, marginRight: 12 }}>
					<Text style={styles.toggleLabel}>{label}</Text>
					{hint ? <Text style={styles.toggleHint}>{hint}</Text> : null}
				</View>
				{action ? <Button title={action} variant="ghost" loading={busy} onPress={onAction} /> : null}
			</View>
		</>
	);
}

function Field(props: {
	label: string;
	value: string;
	onChangeText: (v: string) => void;
	placeholder?: string;
	autoCapitalize?: "none" | "sentences";
	keyboardType?: "default" | "url" | "number-pad";
	secureTextEntry?: boolean;
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
				secureTextEntry={props.secureTextEntry}
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
	notifCard: {
		flexDirection: "row",
		alignItems: "center",
		padding: 14,
		backgroundColor: theme.bgElevated,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
	},
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
	projRowPressed: { backgroundColor: theme.bgElevatedHover, borderColor: theme.borderDefault },
	projName: { color: theme.textPrimary, fontSize: 14, fontWeight: "600", flex: 1 },
	projPrefix: { color: theme.textTertiary, fontSize: 12, fontFamily: theme.fontMono },
	modalBackdrop: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		padding: 24,
	},
	modalCard: {
		width: "100%",
		maxWidth: 360,
		backgroundColor: theme.bgElevated,
		borderRadius: 14,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		padding: 20,
	},
	modalTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "700" },
	modalRow: { flexDirection: "row", marginTop: 18 },
});
