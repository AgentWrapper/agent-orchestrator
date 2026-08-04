import Constants from "expo-constants";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, pingServer } from "../../lib/api";
import { bugReportBody, formatVersion, type BuildInfo } from "../../lib/appInfo";
import { DEFAULT_CONFIG, isConfigured, loadConfig, type ServerConfig } from "../../lib/config";
import { classifyConnectionFailure, describeConnectionFailure } from "../../lib/connectionError";
import { forgetServer } from "../../lib/disconnect";
import type { Theme } from "../../lib/theme";
import { haptics } from "../../lib/haptics";
import { projectSheetRoute } from "../../lib/sheetResult";
import { preferenceLabel } from "../../lib/themePreference";
import { getPushStatus, openNotificationSettings, registerForPush, unregisterFromPush } from "../../lib/push";
import { describePushToggle, describeRegisterFailure, type PushStatus } from "../../lib/pushStatus";
import { openGitHub } from "../../lib/openGitHub";
import { useApp } from "../../lib/store";
import { useTabScrollToTop } from "../../lib/useTabScrollToTop";
import { Dot, ScreenHeader, SettingsGroup, SettingsRow, SettingsToggle } from "../../lib/ui";
import { useTheme, useThemedStyles, useThemeState } from "../../lib/ThemeProvider";
import { LOCALE_NATIVE_LABELS, useLocale, useT } from "../../lib/i18n";

const ISSUES_URL = "https://github.com/AgentWrapper/agent-orchestrator/issues/new";

export default function SettingsScreen() {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const { reloadConfig, projects, connection, activeProjectId, setActiveProject } = useApp();
	const scrollRef = useTabScrollToTop<ScrollView>();
	const tr = useT();
	const { locale } = useLocale();

	const [cfg, setCfg] = useState<ServerConfig>(DEFAULT_CONFIG);
	const [loaded, setLoaded] = useState(false);
	const { preference } = useThemeState();

	// Reload the saved config every time the screen regains focus — not just on
	// mount — so returning from the pairing flow (which writes host/port to
	// storage then navigates back here) repaints the rows with the new values.
	useFocusEffect(
		useCallback(() => {
			loadConfig().then((c) => {
				setCfg(c);
				setLoaded(true);
			});
		}, []),
	);

	if (!loaded) {
		return (
			<View style={styles.center}>
				<ActivityIndicator color={t.blue} />
			</View>
		);
	}

	const paired = isConfigured(cfg);
	const activeProject = projects.find((p) => p.id === activeProjectId);

	return (
		<View style={styles.screen}>
			<View style={{ height: insets.top }} />
			<ScreenHeader title={tr("settings.title")} status={connection} />
			<ScrollView
				ref={scrollRef}
				contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
				keyboardShouldPersistTaps="handled"
			>
				<ConnectionSection cfg={cfg} paired={paired} connection={connection} />

				<SettingsGroup title={tr("settings.projects")} footer={tr("settings.projectsFooter")}>
					<SettingsRow
						icon="folder"
						label={tr("settings.activeProject")}
						value={activeProject?.name ?? tr("common.allProjects")}
						onPress={() =>
							router.push(
								projectSheetRoute({
									selected: activeProjectId,
									onSelect: (id) => {
										// Picking a project scopes the board and takes you there —
										// the choice and its effect land in one step.
										setActiveProject(id);
										router.navigate("/");
									},
								}),
							)
						}
					/>
				</SettingsGroup>

				<SettingsGroup title={tr("settings.appearance")}>
					<SettingsRow
						icon="moon"
						label={tr("settings.theme")}
						value={preferenceLabel(preference, tr)}
						onPress={() => router.push("/sheets/theme")}
					/>
					<SettingsRow
						icon="globe"
						label={tr("settings.language")}
						value={LOCALE_NATIVE_LABELS[locale]}
						onPress={() => router.push("/sheets/language")}
					/>
				</SettingsGroup>

				<NotificationsSection />

				<AboutSection
					onForget={async () => {
						await forgetServer();
						await reloadConfig();
						router.replace("/onboarding");
					}}
				/>
			</ScrollView>
		</View>
	);
}

// Connection is one row, not a form. `/pair` already owns the whole flow —
// camera scan, permission fallbacks, and the "Enter details manually" sheet that
// opens prefilled from the saved config — so editing a connection and creating
// one go through the same door instead of two divergent forms.
function ConnectionSection({
	cfg,
	paired,
	connection,
}: {
	cfg: ServerConfig;
	paired: boolean;
	connection: string;
}) {
	const t = useTheme();
	const tr = useT();
	const router = useRouter();
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

	// Drop a stale failure once the background poller reports a live connection,
	// so the row doesn't keep showing a scary error while the app is connected.
	useEffect(() => {
		if (connection === "open") setResult((r) => (r && !r.ok ? null : r));
	}, [connection]);

	const dotColor =
		connection === "open" ? t.green : connection === "connecting" ? t.amber : t.textFaint;

	async function test() {
		setTesting(true);
		setResult(null);
		try {
			const count = await pingServer(cfg);
			haptics.success();
			setResult({
				ok: true,
				msg: tr(count === 1 ? "common.connectedSessions" : "common.connectedSessions_other", { count }),
			});
		} catch (e) {
			haptics.error();
			const status = e instanceof ApiError ? e.status : undefined;
			const { title } = describeConnectionFailure(
				classifyConnectionFailure(status),
				{
					host: cfg.host,
					port: cfg.httpPort,
					platform: Platform.OS,
				},
				tr,
			);
			setResult({ ok: false, msg: title });
		} finally {
			setTesting(false);
		}
	}

	return (
		<SettingsGroup title={tr("settings.connection")} footer={tr("settings.connectionFooter")}>
			<SettingsRow
				icon="link"
				label={tr("settings.connectAo")}
				value={paired ? `${cfg.host}:${cfg.httpPort}` : tr("settings.notConnected")}
				leading={paired ? <Dot color={dotColor} size={7} breathing={connection === "connecting"} /> : undefined}
				onPress={() => router.navigate("/pair")}
			/>
			<SettingsRow
				icon="activity"
				label={tr("settings.testConnection")}
				value={result?.msg}
				valueColor={result ? (result.ok ? t.green : t.red) : undefined}
				loading={testing}
				disabled={!paired}
				onPress={test}
			/>
		</SettingsGroup>
	);
}

// Push collapsed to a single switch. The old card offered up to three different
// buttons (Enable / Register / Open settings) for what a user thinks of as one
// setting; `describePushToggle` folds those states into one control plus a
// footer that explains where it currently stands.
function NotificationsSection() {
	const router = useRouter();
	const tr = useT();
	const { config, connection } = useApp();
	const [status, setStatus] = useState<PushStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(() => {
		getPushStatus()
			.then(setStatus)
			.catch(() => {});
	}, []);

	// Reload on focus and whenever the connection flips — registration happens
	// automatically on a successful connect, so the state can change without any
	// action on this screen.
	useFocusEffect(useCallback(() => refresh(), [refresh]));
	useEffect(() => refresh(), [connection, refresh]);

	const toggle = describePushToggle(status, config, tr);

	async function onToggle(next: boolean) {
		// A permanent denial can only be undone in system settings; the OS will
		// not let the app prompt again, so say so rather than failing silently.
		if (toggle.blocked) {
			Alert.alert(tr("settings.notificationsBlockedTitle"), tr("settings.notificationsBlockedMessage"), [
				{ text: tr("common.notNow"), style: "cancel" },
				{ text: tr("common.openSettings"), onPress: openNotificationSettings },
			]);
			return;
		}
		setBusy(true);
		try {
			if (!next) {
				await unregisterFromPush();
				haptics.tap();
			} else if (config) {
				// A deliberate tap is the right moment to spend the one-shot OS prompt.
				const result = await registerForPush(config, { ask: true });
				if (result.ok) {
					haptics.success();
				} else {
					haptics.error();
					const { title, message } = describeRegisterFailure(result.reason, Platform.OS, result.status, tr);
					Alert.alert(title, message);
				}
			}
		} finally {
			setBusy(false);
			refresh();
		}
	}

	return (
		<SettingsGroup title={tr("settings.notifications")} footer={toggle.footer}>
			<SettingsToggle
				icon="bell"
				label={tr("settings.agentNotifications")}
				value={toggle.value}
				disabled={toggle.disabled}
				busy={busy}
				onValueChange={onToggle}
			/>
			<SettingsRow icon="clock" label={tr("settings.history")} onPress={() => router.navigate("/notifications")} />
		</SettingsGroup>
	);
}

function AboutSection({ onForget }: { onForget: () => Promise<void> }) {
	const tr = useT();
	const [forgetting, setForgetting] = useState(false);

	const build: BuildInfo = {
		version: Constants.expoConfig?.version,
		build:
			Platform.OS === "ios"
				? Constants.expoConfig?.ios?.buildNumber
				: (Constants.expoConfig?.android?.versionCode?.toString() ?? null),
	};

	// Routed through openGitHub for consistency, though this one always lands in
	// the browser: the GitHub app has no deep link that accepts a prefilled issue
	// body, and the attached diagnostics are the point of this button.
	function report() {
		const body = encodeURIComponent(bugReportBody(build, Platform.OS, Platform.Version));
		void openGitHub(`${ISSUES_URL}?body=${body}`);
	}

	function confirmForget() {
		Alert.alert(tr("settings.disconnectTitle"), tr("settings.disconnectMessage"), [
				{ text: tr("common.cancel"), style: "cancel" },
				{
					text: tr("settings.disconnectConfirm"),
					style: "destructive",
					onPress: async () => {
						setForgetting(true);
						try {
							await onForget();
						} finally {
							setForgetting(false);
						}
					},
				},
			],
		);
	}

	return (
		<SettingsGroup title={tr("settings.about")}>
			<SettingsRow icon="info" label={tr("settings.version")} value={formatVersion(build)} />
			<SettingsRow icon="mail" label={tr("settings.reportProblem")} onPress={report} />
			<SettingsRow
				icon="power"
				label={tr("settings.disconnect")}
				destructive
				loading={forgetting}
				onPress={confirmForget}
			/>
		</SettingsGroup>
	);
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
	screen: { flex: 1, backgroundColor: t.bgBase },
	center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.bgBase },
});