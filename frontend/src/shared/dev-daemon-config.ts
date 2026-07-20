import { DEFAULT_DAEMON_PORT, expectedDaemonPort } from "./daemon-attach";

export const ISOLATED_DEV_DAEMON_PORT = 3002;
export const ISOLATED_DEV_STATE_SUBDIR = "dev";

export function isDevIsolationEnabled(env: Record<string, string | undefined>): boolean {
	return env.ISOLATE_DEV === "true";
}

export function devDaemonPort(env: Record<string, string | undefined>): number {
	if (env.AO_PORT) return expectedDaemonPort(env);
	return isDevIsolationEnabled(env) ? ISOLATED_DEV_DAEMON_PORT : DEFAULT_DAEMON_PORT;
}
