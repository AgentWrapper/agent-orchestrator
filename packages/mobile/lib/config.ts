import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

// The user points the app at their AO daemon (over Tailscale/LAN). We store the
// host + API port; HTTP and WS URLs are derived from them. The Go daemon serves
// both the REST API and the terminal mux (`/mux`) on the same port, so muxPort is
// kept only for back-compat and no longer used to build the mux URL.
export type ServerConfig = {
	host: string; // e.g. "100.101.102.103" or "my-pc.tail1234.ts.net"
	httpPort: string; // AO daemon HTTP port (REST API + /mux), default 3001
	muxPort: string; // legacy separate mux port - unused against the Go daemon
	secure?: boolean; // use https/wss instead of http/ws (TLS / Tailscale funnel)
};

export const DEFAULT_CONFIG: ServerConfig = {
	host: "",
	httpPort: "3001",
	muxPort: "14801",
	secure: false,
};

// Strip a pasted scheme (http://, ws://, ...) and trailing slashes so we never
// build a double-scheme URL like "http://https://host".
function cleanHost(host: string): string {
	return host
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/\/+$/, "");
}

const KEY = "ao.serverConfig";

export async function loadConfig(): Promise<ServerConfig> {
	try {
		const raw = await AsyncStorage.getItem(KEY);
		if (!raw) return DEFAULT_CONFIG;
		return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
	} catch {
		return DEFAULT_CONFIG;
	}
}

export async function saveConfig(cfg: ServerConfig): Promise<void> {
	await AsyncStorage.setItem(KEY, JSON.stringify(cfg));
}

export function httpBase(cfg: ServerConfig): string {
	return `${cfg.secure ? "https" : "http"}://${cleanHost(cfg.host)}:${cfg.httpPort}`;
}

export function muxUrl(cfg: ServerConfig): string {
	// The Go daemon serves the terminal mux at /mux on the same HTTP port as the
	// REST API (not a separate mux port).
	return `${cfg.secure ? "wss" : "ws"}://${cleanHost(cfg.host)}:${cfg.httpPort}/mux`;
}

export function isConfigured(cfg: ServerConfig): boolean {
	return cleanHost(cfg.host).length > 0;
}

// Small reactive hook so screens re-render when the config changes.
export function useServerConfig() {
	const [config, setConfig] = useState<ServerConfig | null>(null);

	const reload = useCallback(async () => {
		setConfig(await loadConfig());
	}, []);

	useEffect(() => {
		reload();
	}, [reload]);

	const update = useCallback(async (cfg: ServerConfig) => {
		await saveConfig(cfg);
		setConfig(cfg);
	}, []);

	return { config, update, reload };
}
