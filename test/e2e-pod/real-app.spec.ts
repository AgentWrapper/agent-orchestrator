import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// Real-app integration smoke: launch the installed packaged app, prove the GUI
// window paints AND the bundled daemon (real Go binary + embedded SQLite) reaches
// ready. Testid-free on purpose — the published nightly predates the new
// data-testids, so these assertions exercise the real IPC/daemon path only.
//
// Isolation is per test: each launch gets a unique ephemeral AO_PORT and a fresh
// AO_DATA_DIR / AO_RUN_FILE under a temp dir. The daemon inherits these (Electron
// main spreads process.env into the daemon child), so a stale daemon from a prior
// run — or anything already bound to the default 3001 — can NOT be mistaken for the
// app under test: nothing else is on our ephemeral port or writes our run file.
const APP_BIN = process.env.AO_APP_BIN || "/usr/lib/agent-orchestrator/agent-orchestrator";

interface RunFile {
	pid: number;
	port: number;
	startedAt: string;
	owner?: string;
}

// Grab a currently-free loopback port. Small TOCTOU window before the daemon binds
// it, but combined with the unique run file + readyz pid check below it's enough to
// pin the endpoint deterministically instead of hardcoding 3001.
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address() as net.AddressInfo;
			srv.close(() => resolve(addr.port));
		});
	});
}

async function readRunFile(runFile: string): Promise<RunFile | null> {
	try {
		return JSON.parse(await fs.readFile(runFile, "utf8")) as RunFile;
	} catch {
		return null;
	}
}

const launched: { app: ElectronApplication; tmpDir: string }[] = [];

// Launch the packaged app with a per-test-isolated port + data/run paths, the way
// production clients discover the daemon (run file), never a fixed port.
async function launchIsolated() {
	const port = await freePort();
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ao-e2e-"));
	const runFile = path.join(tmpDir, "running.json");
	const dataDir = path.join(tmpDir, "data");
	const launchedAtMs = Date.now();
	const app = await electron.launch({
		executablePath: APP_BIN,
		args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		env: {
			...process.env,
			ELECTRON_DISABLE_SANDBOX: "1",
			AO_PORT: String(port),
			AO_RUN_FILE: runFile,
			AO_DATA_DIR: dataDir,
		},
	});
	launched.push({ app, tmpDir });
	return { app, port, runFile, launchedAtMs };
}

test.afterEach(async () => {
	for (const { app, tmpDir } of launched.splice(0)) {
		await app.close().catch(() => {});
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});

test("REAL-001 packaged app launches + window paints @T0 @real", async () => {
	const { app } = await launchIsolated();
	const win = await app.firstWindow();
	expect(win).toBeTruthy();
	// Prove the AO renderer SCREEN mounted (INS-002 first-run/home UI) — not just
	// that some document painted. The AO brand string "Agent Orchestrator" is
	// rendered into the app shell (sidebar) and the first-run home/welcome
	// ("Welcome to Agent Orchestrator"), so its presence in VISIBLE body text is an
	// AO-specific proof the renderer mounted. A Chromium/Electron error page has no
	// AO brand text (fails), and an unmounted shell (empty #root) has no visible
	// text (fails). document.title is deliberately NOT used: index.html sets it to
	// "Agent Orchestrator" statically, so it is present even if React never mounts.
	await expect
		.poll(
			() =>
				win.evaluate(() => {
					const text = document.body?.innerText ?? "";
					return document.readyState === "complete" && text.includes("Agent Orchestrator");
				}),
			{ timeout: 30_000, intervals: [500] },
		)
		.toBe(true);
});

test("REAL-002 bundled daemon reaches ready (real SQLite) @T0 @real", async () => {
	const { app, port, runFile, launchedAtMs } = await launchIsolated();
	await app.firstWindow();

	// Discover the daemon the way production clients do: read THIS launch's run file
	// and use the port it recorded — do not assume 3001. Wait until the run file the
	// app spawned reports our isolated port.
	await expect
		.poll(async () => (await readRunFile(runFile))?.port ?? 0, { timeout: 40_000, intervals: [500] })
		.toBe(port);
	const info = await readRunFile(runFile);
	expect(info).not.toBeNull();
	// This run file belongs to an app-spawned daemon started after we launched — not
	// a leftover from a previous run.
	expect(info!.owner).toBe("app");
	expect(info!.pid).toBeGreaterThan(0);
	expect(new Date(info!.startedAt).getTime()).toBeGreaterThanOrEqual(launchedAtMs - 2000);

	// Poll the real /readyz on the discovered port (only our daemon can be here).
	const url = `http://127.0.0.1:${info!.port}/readyz`;
	await expect
		.poll(
			async () => {
				try {
					return (await fetch(url)).status;
				} catch {
					return 0;
				}
			},
			{ timeout: 40_000, intervals: [1000] },
		)
		.toBe(200);

	const body = await (await fetch(url)).json();
	expect(body.status).toBe("ready");
	expect(body.service).toBe("agent-orchestrator-daemon");
	// Attribution: the ready daemon is the exact process this launch's run file
	// recorded — not a stale daemon that happened to answer on some shared port.
	expect(body.pid).toBe(info!.pid);
});
