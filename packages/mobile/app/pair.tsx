import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { loadConfig, saveConfig } from "../lib/config";
import { parsePairingPayload } from "../lib/pairing";
import { useApp } from "../lib/store";
import { theme } from "../lib/theme";
import { Button } from "../lib/ui";

// Scans the desktop's pairing QR code (a `{v,host,port,password}` JSON payload),
// writes host/httpPort/password into the saved server config, kicks off a
// reconnect, and returns to Settings — so one scan connects with no typing.
export default function PairScreen() {
	const router = useRouter();
	const { reloadConfig } = useApp();
	const [permission, requestPermission] = useCameraPermissions();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Guards against onBarcodeScanned firing multiple times per frame while we
	// process the first hit (and before we navigate away).
	const scanned = useRef(false);

	async function onScan({ data }: { data: string }) {
		if (scanned.current || busy) return;
		const parsed = parsePairingPayload(data);
		if (!parsed) {
			setError("That QR code isn't an AO pairing code. Try again.");
			return;
		}
		scanned.current = true;
		setBusy(true);
		setError(null);
		try {
			const cfg = await loadConfig();
			// Keep any existing password if the QR is an older host+port-only code.
			await saveConfig({
				...cfg,
				host: parsed.host,
				httpPort: parsed.port,
				password: parsed.password || cfg.password,
			});
			await reloadConfig(); // reconnect with the scanned credentials
			router.back();
		} catch {
			setError("Couldn't save the scanned config. Try again.");
			scanned.current = false;
			setBusy(false);
		}
	}

	if (!permission) {
		return (
			<View style={styles.center}>
				<Text style={styles.hint}>Loading camera…</Text>
			</View>
		);
	}

	if (!permission.granted) {
		return (
			<View style={styles.center}>
				<Text style={styles.title}>Camera access needed</Text>
				<Text style={styles.hint}>AO needs the camera to scan the pairing QR code shown on your desktop.</Text>
				<Button title="Grant camera access" onPress={requestPermission} style={{ marginTop: 20 }} />
				<Button title="Cancel" variant="ghost" onPress={() => router.back()} style={{ marginTop: 10 }} />
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			<CameraView
				style={StyleSheet.absoluteFill}
				facing="back"
				barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
				onBarcodeScanned={onScan}
			/>
			<View style={styles.overlay}>
				<View style={styles.frame} />
				<Text style={styles.overlayHint}>Point the camera at the pairing QR code on your desktop.</Text>
				{error ? <Text style={styles.error}>{error}</Text> : null}
				<Button title="Cancel" variant="ghost" onPress={() => router.back()} style={{ marginTop: 18 }} />
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: theme.bgBase,
		padding: 24,
	},
	title: { color: theme.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
	hint: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 8 },
	overlay: {
		flex: 1,
		alignItems: "center",
		justifyContent: "flex-end",
		paddingBottom: 40,
		paddingHorizontal: 24,
	},
	frame: {
		position: "absolute",
		top: "28%",
		width: 240,
		height: 240,
		borderRadius: 16,
		borderWidth: 2,
		borderColor: theme.blue,
	},
	overlayHint: {
		color: theme.textPrimary,
		fontSize: 13,
		textAlign: "center",
		backgroundColor: "rgba(0,0,0,0.5)",
		padding: 10,
		borderRadius: 10,
	},
	error: { color: theme.red, fontSize: 13, textAlign: "center", marginTop: 10 },
});
