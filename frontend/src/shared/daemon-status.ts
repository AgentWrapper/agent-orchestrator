import { TOKEN_VALUE_PATTERN } from "./credential-patterns";

// DaemonStatus is the supervisor → renderer handshake payload, shared by the
// Electron main process (which derives it) and the preload bridge (which types
// the IPC surface). The renderer picks it up through the preload's AoBridge type.
// Machine-readable failure classification for telemetry. `message` is
// human-facing and may contain local paths; `code` is what gets reported.
// Statuses without a code (normal ready, user-initiated stop) are not failures.
export type DaemonFailureCode =
	| "not_configured"
	| "daemon_unreachable"
	| "binary_missing"
	| "spawn_failed"
	| "exited"
	| "port_unconfirmed"
	| "not_ready"
	| "identity_mismatch"
	| "remote_host_required"
	| "remote_port_invalid"
	| "remote_password_required"
	| "remote_bad_password"
	| "remote_rate_limited"
	| "remote_http_error"
	| "remote_forwarder_bind_failed"
	| "remote_config_save_failed";

export type DaemonStatus = {
	state: "starting" | "ready" | "stopped" | "error";
	port?: number;
	pid?: number;
	executablePath?: string;
	workingDirectory?: string;
	message?: string;
	code?: DaemonFailureCode;
	exitCode?: number | null;
	signal?: string | null;
	httpStatus?: number;
};

const URL_CREDENTIAL_PATTERN = /:\/\/[^/\s:]+:[^@/\s]+@/;
const NORMALIZED_CREDENTIAL_MARKER =
	/(?:token|credential|secret|passphrase|password|passwd|authorization|bearer|apikey|privatekey|oauthkey)/;

/** Keep useful transport diagnostics while refusing credential-bearing text. */
export function safeDaemonStatusDetail(value: unknown): string | undefined {
	const message = value instanceof Error ? value.message.trim() : typeof value === "string" ? value.trim() : "";
	if (!message) return undefined;
	const normalized = message.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (
		NORMALIZED_CREDENTIAL_MARKER.test(normalized) ||
		URL_CREDENTIAL_PATTERN.test(message) ||
		TOKEN_VALUE_PATTERN.test(message)
	) {
		return undefined;
	}
	return message;
}
