export type DaemonLaunchSpec = {
	command: string;
	args: string[];
	cwd: string;
	shell: boolean;
	source: "configured" | "bundled" | "dev";
};

function joinPath(...segments: string[]): string {
	return segments.map((segment) => segment.replace(/[/\\]+$/, "")).join("/");
}

export function bundledDaemonBinaryName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "ao.exe" : "ao";
}

export function resolveDaemonLaunch(
	env: Record<string, string | undefined>,
	isPackaged: boolean,
	resourcesPath: string,
	appPath: string,
	platform: NodeJS.Platform,
): DaemonLaunchSpec | null {
	const configuredCommand = env.AO_DAEMON_COMMAND?.trim();
	if (configuredCommand) {
		return {
			command: configuredCommand,
			args: [],
			cwd: appPath,
			shell: true,
			source: "configured",
		};
	}

	if (!isPackaged) {
		return {
			command: "go",
			args: ["run", "./cmd/ao", "daemon"],
			cwd: joinPath(appPath, "..", "backend"),
			shell: false,
			source: "dev",
		};
	}

	return {
		command: joinPath(resourcesPath, "daemon", bundledDaemonBinaryName(platform)),
		args: ["daemon"],
		cwd: resourcesPath,
		shell: false,
		source: "bundled",
	};
}

// bundledTmuxPath locates the static tmux fallback shipped as an
// extraResource (see fetch-tmux.mjs), stamped into the daemon env as
// AO_BUNDLED_TMUX. Null when not packaged (dev uses system tmux), on
// Windows (ConPTY needs no tmux), or when the resource is absent
// (AO_SKIP_TMUX_FETCH builds) — the daemon then resolves PATH only.
export function bundledTmuxPath(
	isPackaged: boolean,
	resourcesPath: string,
	platform: NodeJS.Platform,
	exists: (path: string) => boolean,
): string | null {
	if (!isPackaged || platform === "win32") {
		return null;
	}
	const path = joinPath(resourcesPath, "tmux-dist", "tmux");
	return exists(path) ? path : null;
}
