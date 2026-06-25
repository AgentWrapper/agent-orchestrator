import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	net,
	Notification as ElectronNotification,
	protocol,
	shell,
	WebContentsView,
	type OpenDialogOptions,
} from "electron";
import { updateElectronApp } from "update-electron-app";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type DaemonLaunchSpec, resolveDaemonLaunch } from "./shared/daemon-launch";
import { createListenPortScanner, defaultRunFilePath, parseRunFile } from "./shared/daemon-discovery";
import type { DaemonStatus } from "./shared/daemon-status";
import {
	type DaemonProbe,
	expectedDaemonPort,
	parseDaemonProbe,
	resolveDaemonFromPort,
	resolveDaemonFromRunFile,
} from "./shared/daemon-attach";
import { shouldReplacePortHolder } from "./shared/daemon-takeover";
import { buildDaemonEnv, resolveShellEnv, type ShellRunner } from "./shared/shell-env";
import { DEFAULT_POSTHOG_HOST, DEFAULT_POSTHOG_PROJECT_KEY } from "./shared/posthog-config";
import { buildTelemetryBootstrap } from "./shared/telemetry";
import { createBrowserViewHost, type BrowserViewHost } from "./main/browser-view-host";
import { connectSupervisor, type SupervisorLinkHandle } from "./main/supervisor-link";

// Globals injected at compile time by @electron-forge/plugin-vite.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Windows GUI launches (e.g. from a Start-menu/desktop shortcut) have no attached
// console, so process.stdout and process.stderr are dead pipes. The daemon-output
// console.log/console.error calls
// below then fail with EPIPE, and with no "error" listener that surfaces as an
// uncaught exception that crashes the main process. Swallow broken-pipe write
// errors on the std streams: a dropped log line is harmless, the crash is not.
const ignoreStdStreamError = (err: NodeJS.ErrnoException): void => {
	if (err.code === "EPIPE") return;
};
process.stdout.on("error", ignoreStdStreamError);
process.stderr.on("error", ignoreStdStreamError);

// Must run before app ready so the About panel and default-menu role labels use it.
app.setName("Agent Orchestrator");

// Pin ALL Electron-owned state (Chromium cache, cookies, local/session storage,
// crash dumps) under the canonical AO home at ~/.ao instead of Electron's macOS
// default ~/Library/Application Support/<name>. Keeps the app's entire footprint
// inside ~/.ao alongside the daemon's data dir and running.json. sessionData and
// crashDumps derive from userData, so this one override reparents them all.
// Must run before app ready.
app.setPath("userData", path.join(os.homedir(), ".ao", "electron"));

let mainWindow: BrowserWindow | null = null;
let daemonProcess: ChildProcessWithoutNullStreams | null = null;
let daemonStoppingProcess: ChildProcessWithoutNullStreams | null = null;
let daemonStartPromise: Promise<DaemonStatus> | null = null;
let daemonStartEpoch = 0;
let daemonStatus: DaemonStatus = { state: "stopped" };
let browserViewHost: BrowserViewHost | null = null;
// Held for the app lifetime. Dropping it (on any exit) triggers daemon self-stop.
let supervisorLink: SupervisorLinkHandle | null = null;

const isDev = !app.isPackaged;

const RENDERER_SCHEME = "app";
const RENDERER_HOST = "renderer";
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;

// The packaged renderer is served from a custom standard scheme, not file://.
// A file:// page has the opaque "null" origin, which the daemon must never
// trust (every sandboxed iframe on any website also presents "null"), so its
// fetch/EventSource calls to the loopback API would be CORS-blocked.
// app://renderer is an origin only this app can present, so the daemon's CORS
// allowlist can name it. A standard scheme also makes the build's absolute
// asset URLs (/assets/…) and history-API routing resolve, which file:// breaks.
// Must run before app ready.
protocol.registerSchemesAsPrivileged([
	{
		scheme: RENDERER_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true },
	},
]);

// Maps app://renderer/<path> to the built renderer in dist/. Paths without a
// file extension are client-side routes and fall back to index.html (SPA).
function registerRendererProtocol(): void {
	const distRoot = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
	protocol.handle(RENDERER_SCHEME, async (request) => {
		const url = new URL(request.url);
		if (url.host !== RENDERER_HOST) {
			return new Response("Not found", { status: 404 });
		}
		const resolved = path.resolve(path.join(distRoot, decodeURIComponent(url.pathname)));
		if (resolved !== distRoot && !resolved.startsWith(distRoot + path.sep)) {
			return new Response("Forbidden", { status: 403 });
		}
		const target = path.extname(resolved) === "" ? path.join(distRoot, "index.html") : resolved;
		try {
			return await net.fetch(pathToFileURL(target).toString());
		} catch {
			return new Response("Not found", { status: 404 });
		}
	});
}

function rendererUrl(): string {
	if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined" && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		return MAIN_WINDOW_VITE_DEV_SERVER_URL;
	}

	return `${RENDERER_ORIGIN}/index.html`;
}

function preloadPath(): string {
	return path.join(__dirname, "preload.js");
}

function annotatePreloadPath(): string {
	return path.join(__dirname, "annotate-preload.js");
}

// Runtime window/taskbar icon for Linux and Windows. macOS ignores this and
// uses the .app bundle's .icns instead. Packaged: shipped via extraResource to
// resources/icon.png; dev: the source asset under frontend/assets.
function windowIconPath(): string | undefined {
	const candidate = app.isPackaged
		? path.join(process.resourcesPath, "icon.png")
		: path.join(__dirname, "../../assets/icon.png");
	return existsSync(candidate) ? candidate : undefined;
}

function setDaemonStatus(nextStatus: DaemonStatus): void {
	daemonStatus = nextStatus;
	mainWindow?.webContents.send("daemon:status", daemonStatus);
}

function createWindow(): void {
	browserViewHost?.dispose();
	browserViewHost = null;
	mainWindow = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 960,
		minHeight: 640,
		title: "Agent Orchestrator",
		icon: windowIconPath(),
		backgroundColor: "#0f1014",
		titleBarStyle: "hiddenInset",
		// Lights visually centered at y=28 — the 56px topbar/.titlebar-nav center
		// line — so lights + nav cluster + header content share one row. macOS
		// draws the 12pt disc 2pt below the given y (measured: center = y + 8),
		// hence 20, not 22.
		trafficLightPosition: { x: 14, y: 20 },
		webPreferences: {
			preload: preloadPath(),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	// Harden navigation: never let renderer/terminal content open in-app windows or
	// navigate the privileged window away from the app origin. External links go to
	// the OS browser. Keep this in place before exposing any daemon output to the renderer.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});

	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (url !== mainWindow?.webContents.getURL()) {
			event.preventDefault();
		}
	});

	browserViewHost = createBrowserViewHost({
		mainWindow,
		ipcMain,
		shell,
		WebContentsView,
		annotatePreloadPath: annotatePreloadPath(),
		rendererOrigin: RENDERER_ORIGIN,
	});

	void mainWindow.loadURL(rendererUrl());

	if (isDev && process.env.AO_OPEN_DEVTOOLS === "1") {
		mainWindow.webContents.once("did-frame-finish-load", () => {
			mainWindow?.webContents.openDevTools({ mode: "detach" });
		});
	}

	mainWindow.on("closed", () => {
		browserViewHost?.dispose();
		browserViewHost = null;
		mainWindow = null;
	});
}

// How long the supervisor waits for the daemon to confirm its bound port (via
// the listen log line or running.json) before reporting the configured port as
// a best-effort fallback.
const PORT_DISCOVERY_TIMEOUT_MS = 15_000;
const RUN_FILE_POLL_MS = 300;
// Accept run-files stamped slightly before our spawn timestamp: the daemon's
// clock reading and ours race within normal scheduling jitter.
const RUN_FILE_FRESHNESS_SKEW_MS = 2_000;
const DAEMON_PROBE_TIMEOUT_MS = 2_000;

function runFilePath(): string | null {
	if (process.env.AO_RUN_FILE) return process.env.AO_RUN_FILE;
	return defaultRunFilePath(process.platform, process.env, os.homedir());
}

// How long to wait for the login shell to print its env before giving up. A
// misconfigured rc that blocks (or a slow nvm/pyenv chain) must not hang startup;
// the daemon then falls back to the static PATH floor.
const SHELL_ENV_TIMEOUT_MS = 3_000;

// The login-shell env resolved once at startup (see docs/daemon-environment.md),
// or null when the probe failed/timed out. Read synchronously by daemonEnv().
let cachedShellEnv: Record<string, string> | null = null;
// Memoize the in-flight resolution so concurrent/repeat awaits are cheap.
let shellEnvPromise: Promise<void> | null = null;

// Telemetry defaults stamped on the daemon env on every platform; explicit env
// always wins.
function telemetryOverrides(): Record<string, string> {
	return {
		AO_TELEMETRY_EVENTS: process.env.AO_TELEMETRY_EVENTS ?? "on",
		AO_TELEMETRY_REMOTE: process.env.AO_TELEMETRY_REMOTE ?? "posthog",
		AO_TELEMETRY_POSTHOG_KEY: process.env.AO_TELEMETRY_POSTHOG_KEY ?? DEFAULT_POSTHOG_PROJECT_KEY,
		AO_TELEMETRY_POSTHOG_HOST: process.env.AO_TELEMETRY_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
	};
}

// Run the user's login shell to dump its env. stdin is ignored so an rc that
// reads input hits EOF instead of hanging; stderr is ignored to drop banner
// noise. Never rejects: resolves null on spawn error, non-zero exit, or timeout
// (SIGKILLed), so the caller degrades to the static PATH floor.
const runLoginShell: ShellRunner = (shellPath, args) =>
	new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(shellPath, args, { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			finish(null);
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, SHELL_ENV_TIMEOUT_MS);
		let stdout = "";
		// stdout may be typed Readable | null under this stdio config; guard it.
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.once("error", () => {
			clearTimeout(timer);
			finish(null);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			finish(code === 0 ? stdout : null);
		});
	});

// Resolve the login-shell env once and cache it. No-op on Windows (the launchd
// shell split does not apply; a static PATH floor suffices). Awaited at the
// daemon-spawn chokepoint so the cache is populated before the first spawn.
function ensureShellEnv(): Promise<void> {
	if (process.platform === "win32") return Promise.resolve();
	if (!shellEnvPromise) {
		shellEnvPromise = resolveShellEnv(process.env, runLoginShell).then((resolved) => {
			cachedShellEnv = resolved;
			if (!resolved) {
				console.error("AO: could not read the login-shell environment; falling back to a static PATH floor.");
			}
		});
	}
	return shellEnvPromise;
}

function daemonEnv(): NodeJS.ProcessEnv {
	// Windows keeps the old behavior exactly: no shell probe, no unix PATH floor.
	if (process.platform === "win32") {
		return { ...process.env, ...telemetryOverrides() };
	}
	return buildDaemonEnv(process.env, cachedShellEnv, telemetryOverrides());
}

function pathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

function pathInside(child: string, parent: string): boolean {
	const childKey = pathKey(child);
	const parentKey = pathKey(parent);
	return childKey === parentKey || childKey.startsWith(parentKey + path.sep);
}

function processAlive(pid: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readDaemonProbe(port: number, endpoint: "healthz" | "readyz"): Promise<DaemonProbe | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DAEMON_PROBE_TIMEOUT_MS);
	try {
		const response = await net.fetch(`http://127.0.0.1:${port}/${endpoint}`, { signal: controller.signal });
		if (!response.ok) return null;
		return parseDaemonProbe(endpoint, await response.json());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function daemonIdentityError(launch: DaemonLaunchSpec, probe: DaemonProbe): string | null {
	if (launch.source === "dev") {
		const cwdMatches = probe.workingDirectory ? samePath(probe.workingDirectory, launch.cwd) : false;
		const executableMatches = probe.executablePath ? pathInside(probe.executablePath, launch.cwd) : false;
		if (!probe.workingDirectory && !probe.executablePath) {
			return "An older AO daemon is already running, but it does not report its checkout identity. Stop it and restart this app.";
		}
		if (!cwdMatches && !executableMatches) {
			const actual = probe.workingDirectory ?? probe.executablePath ?? "an unknown location";
			return `Another AO daemon is already running from ${actual}; expected this checkout at ${launch.cwd}. Stop the other daemon before using this checkout.`;
		}
		return null;
	}

	if (launch.source === "bundled") {
		if (!probe.executablePath) {
			return "An older AO daemon is already running, but it does not report its binary path. Stop it and restart this app.";
		}
		if (!samePath(probe.executablePath, launch.command)) {
			return `Another AO daemon is already running from ${probe.executablePath}; expected ${launch.command}. Stop the other daemon before using this app.`;
		}
	}
	return null;
}

async function inspectExistingDaemon(launch: DaemonLaunchSpec): Promise<DaemonStatus | null> {
	const handshakePath = runFilePath();
	let runFileContents: string | null = null;
	if (handshakePath) {
		try {
			runFileContents = await readFile(handshakePath, "utf8");
		} catch {
			runFileContents = null;
		}
	}
	return resolveDaemonFromRunFile({
		runFileContents,
		isProcessAlive: processAlive,
		probe: readDaemonProbe,
		identityError: (probe) => daemonIdentityError(launch, probe),
	});
}

async function refreshDaemonStatus(): Promise<DaemonStatus> {
	if (daemonProcess) {
		return daemonStatus;
	}
	const launch = resolveDaemonLaunch(
		process.env,
		app.isPackaged,
		process.resourcesPath,
		app.getAppPath(),
		process.platform,
	);
	if (!launch) return daemonStatus;
	const existing = await inspectExistingDaemon(launch);
	if (existing) {
		setDaemonStatus(existing);
	} else if (
		daemonStatus.state === "ready" ||
		(daemonStatus.state === "error" && (daemonStatus.pid || daemonStatus.port))
	) {
		setDaemonStatus({
			state: "stopped",
			message: "AO daemon is no longer reachable.",
		});
	}
	return daemonStatus;
}

async function startDaemon(): Promise<DaemonStatus> {
	if (daemonStartPromise) {
		return daemonStartPromise;
	}
	const startEpoch = daemonStartEpoch;
	const promise = startDaemonInner(startEpoch).finally(() => {
		if (daemonStartPromise === promise) {
			daemonStartPromise = null;
		}
	});
	daemonStartPromise = promise;
	return daemonStartPromise;
}

async function startDaemonInner(startEpoch: number): Promise<DaemonStatus> {
	if (daemonProcess) {
		return daemonStatus;
	}

	// Single chokepoint: make sure the login-shell env is resolved before the
	// daemon is spawned, so a Finder/Dock launch hands the daemon a real PATH and
	// shell-exported credentials rather than launchd's minimal env.
	await ensureShellEnv();

	const launch = resolveDaemonLaunch(
		process.env,
		app.isPackaged,
		process.resourcesPath,
		app.getAppPath(),
		process.platform,
	);
	if (!launch) {
		setDaemonStatus({
			state: "stopped",
			message: "AO_DAEMON_COMMAND is not configured; renderer uses loopback REST when available.",
		});
		return daemonStatus;
	}

	const existing = await inspectExistingDaemon(launch);
	if (startEpoch !== daemonStartEpoch) {
		return daemonStatus;
	}
	if (existing) {
		setDaemonStatus(existing);
		return daemonStatus;
	}

	// Defensive: inspectExistingDaemon only attaches when the run-file agrees with
	// a live daemon. Any divergence (missing/stale/unparseable run-file, dead PID,
	// health.pid mismatch) makes it return null — yet a daemon may still be serving
	// the port. Spawning then would just make the Go child refuse and exit 1. Probe
	// the expected port directly, independent of the run-file, and attach if a
	// daemon answers. The expected port (AO_PORT or the default) is exactly the
	// port the Go child would bind and collide on — probing a hardcoded 3001 would
	// miss an AO_PORT override.
	const directDaemon = await resolveDaemonFromPort({
		expectedPort: expectedDaemonPort(process.env),
		probe: readDaemonProbe,
		identityError: (probe) => daemonIdentityError(launch, probe),
	});
	if (startEpoch !== daemonStartEpoch) {
		return daemonStatus;
	}
	if (directDaemon) {
		setDaemonStatus(directDaemon);
		return daemonStatus;
	}

	// Wedged-orphan kill+replace: both attach paths returned null, but a process
	// may still be holding the port. The only reachable case here is a hung/wedged
	// holder whose run-file PID is still alive but is not answering /healthz (e.g.
	// our own daemon that bound the port and then deadlocked). Two cases are
	// intentionally NOT handled: an identity-mismatched but healthy AO daemon is
	// already surfaced as an error status upstream by resolveDaemonFromPort (not
	// killed here), and a foreign non-AO process holding the port with a dead
	// run-file PID is not replaced (out of scope). When no holder is detectable,
	// skip straight to spawn.
	const orphanProbe = await readDaemonProbe(expectedDaemonPort(process.env), "healthz");
	const runFilePath_ = runFilePath();
	let runFilePid: number | null = null;
	if (runFilePath_) {
		try {
			runFilePid = parseRunFile(await readFile(runFilePath_, "utf8"))?.pid ?? null;
		} catch {
			// run-file absent or unreadable; proceed without a PID.
		}
	}
	// process.kill(pid, 0) does not kill; it throws iff the PID is not live.
	let holderPidAlive = false;
	if (runFilePid) {
		try {
			process.kill(runFilePid, 0);
			holderPidAlive = true;
		} catch {
			holderPidAlive = false;
		}
	}
	if (shouldReplacePortHolder(orphanProbe, holderPidAlive)) {
		// Use the run-file PID when available; fall back to the probe's reported
		// PID as a last resort (a wedged daemon may not have written a fresh run-file).
		const pidToKill = runFilePid ?? orphanProbe?.pid ?? null;
		if (pidToKill) {
			try {
				process.kill(-pidToKill, "SIGTERM");
			} catch {
				try {
					process.kill(pidToKill, "SIGTERM");
				} catch {
					// process already gone; proceed
				}
			}
		}
		// Poll until the port is free (probe returns null) or 8 s elapses.
		const TAKEOVER_TIMEOUT_MS = 8_000;
		const TAKEOVER_POLL_MS = 200;
		const deadline = Date.now() + TAKEOVER_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const still = await readDaemonProbe(expectedDaemonPort(process.env), "healthz");
			if (!still) break;
			await new Promise<void>((r) => setTimeout(r, TAKEOVER_POLL_MS));
		}
		// Remove the stale run-file so the new daemon can write a fresh one.
		if (runFilePath_) {
			await rm(runFilePath_, { force: true });
		}
	}

	if (launch.source === "bundled" && !existsSync(launch.command)) {
		setDaemonStatus({
			state: "error",
			message: `Bundled AO daemon binary was not found at ${launch.command}. Rebuild the desktop package.`,
		});
		return daemonStatus;
	}

	setDaemonStatus({ state: "starting" });

	// Capture the spawned handle locally so the async lifecycle listeners act only
	// on THIS process. Without this, a stale exit from an already-stopped daemon
	// could null out a newer daemonProcess started in the meantime, orphaning it.
	//
	// `detached` makes the child its own process-group leader. Because shell:true
	// runs the command through /bin/sh, a plain kill() would only signal the shell
	// wrapper and orphan the real daemon (which keeps holding the port). Killing
	// the whole group via killDaemon() reaches the daemon and any PTY children.
	const child = spawn(launch.command, launch.args, {
		cwd: launch.cwd,
		env: daemonEnv(),
		shell: launch.shell,
		detached: true,
		// Hide the daemon's console on a Windows GUI launch (no flashing terminal).
		windowsHide: true,
	});
	daemonProcess = child;

	// Discover the port the daemon ACTUALLY bound rather than trusting AO_PORT:
	// the daemon may fall back to a different port than the one requested. Two
	// confirmed sources race — the "daemon listening" slog line (stderr, but both
	// streams are scanned) and the running.json handshake — first one wins.
	const spawnedAtMs = Date.now();
	let portConfirmed = false;
	let runFileTimer: ReturnType<typeof setInterval> | undefined;
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

	const stopDiscovery = () => {
		if (runFileTimer) clearInterval(runFileTimer);
		runFileTimer = undefined;
		if (fallbackTimer) clearTimeout(fallbackTimer);
		fallbackTimer = undefined;
	};

	const reportBoundPort = (port: number) => {
		if (portConfirmed || daemonProcess !== child || daemonStoppingProcess === child) return;
		portConfirmed = true;
		stopDiscovery();
		setDaemonStatus({ state: "ready", port });

		// Establish (or re-establish) the OS-native liveness link to the daemon's
		// supervisor socket. Holding this connection keeps the daemon alive. When
		// Electron exits for any reason (Cmd+Q, crash, SIGKILL), the OS closes the
		// fd; the daemon detects EOF and self-stops after its ~5s grace period,
		// leaving tmux/ConPTY sessions alive for the next launch to adopt.
		const rfp = runFilePath();
		const addr =
			process.platform === "win32"
				? "\\\\.\\pipe\\ao-supervise"
				: rfp
					? path.join(path.dirname(rfp), "supervise.sock")
					: null;
		if (addr) {
			supervisorLink?.dispose();
			supervisorLink = connectSupervisor(addr, {
				log: (msg) => console.log(`AO: ${msg}`),
			});
		}
	};

	// One scanner per stream: each keeps its own partial-line buffer.
	const scanStdout = createListenPortScanner(reportBoundPort);
	const scanStderr = createListenPortScanner(reportBoundPort);

	child.stdout.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		console.log(text.trimEnd());
		scanStdout(text);
	});

	child.stderr.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		console.error(text.trimEnd());
		scanStderr(text);
	});

	const handshakePath = runFilePath();
	if (handshakePath) {
		runFileTimer = setInterval(() => {
			readFile(handshakePath, "utf8")
				.then((contents) => {
					const info = parseRunFile(contents);
					// Ignore a stale handshake left by a previous daemon: only trust a
					// file written at/after this spawn.
					if (info && info.startedAtMs >= spawnedAtMs - RUN_FILE_FRESHNESS_SKEW_MS) {
						reportBoundPort(info.port);
					}
				})
				.catch(() => undefined); // absent until the daemon binds; keep polling
		}, RUN_FILE_POLL_MS);
	}

	// Last resort: neither source confirmed (e.g. an older daemon build). Report
	// the configured port so the renderer is not stuck on "starting" forever.
	fallbackTimer = setTimeout(() => {
		if (portConfirmed || daemonProcess !== child || daemonStoppingProcess === child) return;
		stopDiscovery();
		setDaemonStatus({
			state: "ready",
			port: process.env.AO_PORT ? Number(process.env.AO_PORT) : undefined,
			message: "Daemon port not confirmed from logs or running.json; assuming the configured port.",
		});
	}, PORT_DISCOVERY_TIMEOUT_MS);

	child.once("error", (error) => {
		stopDiscovery();
		if (daemonProcess !== child) return;
		daemonProcess = null;
		if (daemonStoppingProcess === child) daemonStoppingProcess = null;
		setDaemonStatus({ state: "error", message: error.message });
	});

	child.once("exit", (code, signal) => {
		stopDiscovery();
		if (daemonProcess !== child) return;
		daemonProcess = null;
		if (daemonStoppingProcess === child) daemonStoppingProcess = null;
		setDaemonStatus({
			state: "stopped",
			message: signal ? `Daemon exited with ${signal}` : `Daemon exited with code ${code ?? "unknown"}`,
		});
	});

	return daemonStatus;
}

// Signal the daemon's whole process group so the kill reaches the real daemon
// behind the /bin/sh wrapper (and any PTY children it forked), not just the
// shell. Falls back to a direct kill if the group signal can't be delivered
// (e.g. the process already exited).
function killDaemon(child: ChildProcessWithoutNullStreams): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

function stopDaemon(): DaemonStatus {
	daemonStartEpoch += 1;
	daemonStartPromise = null;
	if (!daemonProcess) {
		setDaemonStatus({ state: "stopped" });
		return daemonStatus;
	}

	daemonStoppingProcess = daemonProcess;
	killDaemon(daemonProcess);
	setDaemonStatus({ state: "stopped" });
	return daemonStatus;
}

ipcMain.handle("daemon:getStatus", () => refreshDaemonStatus());
ipcMain.handle("daemon:start", () => startDaemon());
ipcMain.handle("daemon:stop", () => stopDaemon());
ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("telemetry:getBootstrap", () =>
	buildTelemetryBootstrap(process.env, app.getVersion(), process.platform),
);
ipcMain.handle("app:chooseDirectory", async () => {
	const options: OpenDialogOptions = {
		properties: ["openDirectory"],
		title: "Choose a git repository",
	};
	const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

	if (result.canceled) return null;
	return result.filePaths[0] ?? null;
});
ipcMain.handle("clipboard:writeText", (_event, text: string) => {
	clipboard.writeText(text, "clipboard");
	if (process.platform === "linux") {
		clipboard.writeText(text, "selection");
	}
});
ipcMain.handle("clipboard:readText", () => clipboard.readText());

ipcMain.handle("notifications:show", (_event, notification: { id: string; title: string; body?: string }) => {
	if (!notification.id || !notification.title || !ElectronNotification.isSupported()) return;
	const toast = new ElectronNotification({
		title: notification.title,
		body: notification.body,
	});
	toast.on("click", () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
		mainWindow.webContents.send("notifications:click", notification.id);
	});
	toast.show();
});

// Auto-update only runs for packaged builds reading the GitHub Releases feed
// (see forge.config.ts publishers). In dev there is no feed, so it is skipped.
// A live updater additionally requires a signed + notarized build — see
// frontend/docs/desktop-release.md.
function initAutoUpdates(): void {
	if (!app.isPackaged) return;
	updateElectronApp();
}

app.whenReady().then(() => {
	registerRendererProtocol();
	createWindow();
	void startDaemon();
	initAutoUpdates();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

// Daemon teardown is now handled via the OS-native supervisor socket: the daemon
// self-stops ~5s after the last client (this process) drops its connection.
// The supervisorLink fd is NOT explicitly closed on quit; the OS closes it when
// the process exits for any reason (Cmd+Q, crash, SIGKILL). Sessions survive.
app.on("before-quit", () => {
	browserViewHost?.dispose();
	browserViewHost = null;
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
