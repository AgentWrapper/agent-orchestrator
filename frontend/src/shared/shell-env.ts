// Recovering the login-shell environment so a Finder/Dock launch (started by
// launchd, not a shell) gets the same PATH and exported credentials a terminal
// launch would. See docs/daemon-environment.md for the root cause.
//
// Kept pure and dependency-injected (no node:* or electron imports — the
// vite-plugin-electron-renderer polyfill breaks node:* under vitest, see
// daemon-attach.ts) so the parsing/merging logic is testable directly; the real
// shell spawn lives in main.ts and is injected as a ShellRunner.

export const SHELL_ENV_SENTINEL = "__AO_SHELL_ENV__";

// PATH floor: dirs a working macOS/Linux box keeps tools in, appended when the
// shell probe fails so zellij/git/agents still resolve.
export const FALLBACK_PATH_DIRS = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
];

// Ask the login shell (-l sources zprofile, -i sources zshrc) to print a
// sentinel then a NUL-separated env dump (-0 keeps values with newlines intact).
export function shellEnvArgs(): string[] {
	return ["-ilc", `printf '%s' '${SHELL_ENV_SENTINEL}'; env -0`];
}

// Slice after the sentinel (drops banner/motd/prompt noise printed before it),
// split on NUL, split each record on the first '='.
export function parseEnvBlock(stdout: string): Record<string, string> {
	const at = stdout.lastIndexOf(SHELL_ENV_SENTINEL);
	const block = at === -1 ? stdout : stdout.slice(at + SHELL_ENV_SENTINEL.length);
	const out: Record<string, string> = {};
	for (const rec of block.split("\0")) {
		if (rec === "") continue;
		const eq = rec.indexOf("=");
		if (eq <= 0) continue; // skip records with no key or a leading '='
		out[rec.slice(0, eq)] = rec.slice(eq + 1);
	}
	return out;
}

// Prefer $SHELL (the user's login shell); under launchd it may be absent, so
// fall back to /bin/zsh.
export function resolveShellPath(env: Record<string, string | undefined>): string {
	const shell = env.SHELL?.trim();
	return shell && shell.length > 0 ? shell : "/bin/zsh";
}

// Append any missing floor dirs to PATH, preserving the existing order/priority
// and de-duping.
export function withFallbackPath(currentPath: string | undefined): string {
	const result = (currentPath ?? "").split(":").filter(Boolean);
	const present = new Set(result);
	for (const dir of FALLBACK_PATH_DIRS) {
		if (!present.has(dir)) {
			present.add(dir);
			result.push(dir);
		}
	}
	return result.join(":");
}

// Base = shell env, overlaid by processEnv so Electron/AO runtime vars win, then
// PATH forced to the shell's PATH (with floor), then explicit overrides.
//
// TERM defaults to xterm-256color (what the renderer's xterm.js emulates): a
// Finder/Dock launch starts under launchd with no controlling tty, so TERM is
// unset, and the daemon's tmux attach client inherits that and dies with
// "open terminal failed: terminal does not support clear". Seeded as the base
// so a real TERM from the shell/process env still wins.
export function buildDaemonEnv(
	processEnv: NodeJS.ProcessEnv,
	shellEnv: Record<string, string> | null,
	overrides: Record<string, string>,
): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = { TERM: "xterm-256color", ...(shellEnv ?? {}), ...processEnv };
	merged.PATH = withFallbackPath(shellEnv?.PATH ?? processEnv.PATH);
	if (!merged.TERM?.trim() || merged.TERM === "dumb") {
		merged.TERM = "xterm-256color";
	}
	return { ...merged, ...overrides };
}

export type ShellRunner = (shellPath: string, args: string[]) => Promise<string | null>;

// Run the probe via an injected runner (main.ts supplies the real spawn).
// Returns null on any failure or if the result lacks PATH; the caller then falls
// back to the static floor.
export async function resolveShellEnv(
	env: Record<string, string | undefined>,
	run: ShellRunner,
): Promise<Record<string, string> | null> {
	try {
		const stdout = await run(resolveShellPath(env), shellEnvArgs());
		if (stdout == null) return null;
		const parsed = parseEnvBlock(stdout);
		return parsed.PATH ? parsed : null;
	} catch {
		return null;
	}
}
