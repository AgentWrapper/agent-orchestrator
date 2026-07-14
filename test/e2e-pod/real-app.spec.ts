import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";

// Real-app integration smoke: launch the installed packaged app, prove the GUI
// window paints AND the bundled daemon (real Go binary + embedded SQLite) reaches
// ready. Testid-free on purpose — the published nightly predates the new
// data-testids, so these assertions exercise the real IPC/daemon path only.
const APP_BIN = process.env.AO_APP_BIN || "/usr/lib/agent-orchestrator/agent-orchestrator";

let app: ElectronApplication;

test.afterEach(async () => {
	if (app) await app.close().catch(() => {});
});

test("REAL-001 packaged app launches + window paints @T0 @real", async () => {
	app = await electron.launch({
		executablePath: APP_BIN,
		args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
	});
	const win = await app.firstWindow();
	expect(win).toBeTruthy();
	// window has a title (renderer mounted)
	await expect.poll(async () => (await win.title()) ?? "", { timeout: 30_000 }).not.toBeNull();
});

test("REAL-002 bundled daemon reaches ready (real SQLite) @T0 @real", async () => {
	app = await electron.launch({
		executablePath: APP_BIN,
		args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
		env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
	});
	await app.firstWindow();
	// The app spawns its own daemon on 127.0.0.1:3001; poll its real /readyz.
	const status = await expect
		.poll(
			async () => {
				try {
					const r = await fetch("http://127.0.0.1:3001/readyz");
					return r.status;
				} catch {
					return 0;
				}
			},
			{ timeout: 40_000, intervals: [1000] },
		)
		.toBe(200);
	// body proves it's the real daemon, status ready
	const body = await (await fetch("http://127.0.0.1:3001/readyz")).json();
	expect(body.status).toBe("ready");
	expect(body.service).toContain("daemon");
});
