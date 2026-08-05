const SAFE_DEV_INSTANCE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_DEV_DAEMON_PORT = 3002;
const DEV_INSTANCE_PORT_BASE = 31_000;
const DEV_INSTANCE_PORT_SPAN = 10_000;

export function normalizeDevInstance(value: string | undefined): string | null {
	const normalized = value?.trim().toLowerCase() ?? "";
	return SAFE_DEV_INSTANCE.test(normalized) ? normalized : null;
}

export function devStateSubdir(value: string | undefined): string {
	const instance = normalizeDevInstance(value);
	return instance ? `dev/worktrees/${instance}` : "dev";
}

export function devDaemonPort(value: string | undefined): number {
	const instance = normalizeDevInstance(value);
	if (!instance) return DEFAULT_DEV_DAEMON_PORT;

	let hash = 2_166_136_261;
	for (const character of instance) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	return DEV_INSTANCE_PORT_BASE + ((hash >>> 0) % DEV_INSTANCE_PORT_SPAN);
}
