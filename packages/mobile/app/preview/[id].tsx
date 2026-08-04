import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { getPreview } from "../../lib/api";
import { authHeaders } from "../../lib/config";
import { useApp } from "../../lib/store";
import type { Theme } from "../../lib/theme";
import { useTheme, useThemedStyles } from "../../lib/ThemeProvider";

/** Session-scoped counterpart of the desktop Browser inspector. */
export default function SessionPreviewScreen() {
	const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
	const navigation = useNavigation();
	const { config } = useApp();
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const web = useRef<WebView>(null);
	const [preview, setPreview] = useState<{ entry: string; url: string } | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();

	const refresh = useCallback(async () => {
		if (!config || !id) return;
		setError(undefined);
		try {
			const found = await getPreview(config, id);
			const base = (found?.entry ?? "").split("/").pop() ?? "";
			setPreview(/^readme\.(md|markdown)$/i.test(base) ? null : found);
		}
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoading(false); }
	}, [config, id]);

	useEffect(() => { void refresh(); const poll = setInterval(() => void refresh(), 5_000); return () => clearInterval(poll); }, [refresh]);
	useLayoutEffect(() => { navigation.setOptions({ title: title || preview?.entry || "Preview", headerRight: () => <Pressable accessibilityRole="button" accessibilityLabel="Reload preview" hitSlop={10} onPress={() => preview ? web.current?.reload() : void refresh()}><Feather name="refresh-cw" size={18} color={t.textSecondary} /></Pressable> }); }, [navigation, preview, refresh, t.textSecondary, title]);

	if (!config || loading) return <View style={styles.center}><ActivityIndicator color={t.blue} /><Text style={styles.copy}>Looking for a session preview…</Text></View>;
	if (!preview) return <View style={styles.center}><Feather name={error ? "alert-triangle" : "globe"} size={24} color={error ? t.red : t.textTertiary} /><Text style={styles.title}>{error ? "Could not load preview" : "No preview yet"}</Text><Text style={styles.copy}>{error || "Waiting for the agent to generate a page or document. This screen will keep checking."}</Text><Pressable onPress={() => void refresh()} style={styles.retry}><Text style={styles.retryText}>Check again</Text></Pressable></View>;
	return <WebView ref={web} source={{ uri: preview.url, headers: authHeaders(config) }} style={styles.web} startInLoadingState renderLoading={() => <View style={styles.webLoading}><ActivityIndicator color={t.blue} /></View>} onHttpError={(event) => setError(`Preview returned HTTP ${event.nativeEvent.statusCode}.`)} />;
}

const makeStyles = (t: Theme) => StyleSheet.create({
	web: { flex: 1, backgroundColor: t.bgBase },
	webLoading: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: t.bgBase },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 11, paddingHorizontal: 36, backgroundColor: t.bgBase },
	title: { color: t.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
	copy: { color: t.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center" },
	retry: { marginTop: 5, minHeight: 40, justifyContent: "center", borderRadius: 10, backgroundColor: t.blue, paddingHorizontal: 14 },
	retryText: { color: t.onAccent, fontSize: 12, fontWeight: "700" },
});
