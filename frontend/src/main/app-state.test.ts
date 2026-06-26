// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_STATE_FILE_NAME, writeAppStateMarker, type AppStateMarker } from "./app-state";

// The exact key set the Go reader (start.go `appState`) unmarshals.
const GO_READER_KEYS = ["schemaVersion", "appPath", "version", "installedAt", "lastReconciledAt", "installSource"];

async function readMarker(dir: string): Promise<AppStateMarker> {
	const raw = await readFile(path.join(dir, APP_STATE_FILE_NAME), "utf8");
	return JSON.parse(raw) as AppStateMarker;
}

describe("writeAppStateMarker", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-app-state-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("first write sets installedAt + installSource from installedVia", async () => {
		const t = new Date("2026-06-26T10:00:00.000Z");
		await writeAppStateMarker({
			stateDir: dir,
			appPath: "/Applications/Agent Orchestrator.app",
			version: "0.0.0",
			installedVia: "npm-bootstrap",
			now: () => t,
		});

		const m = await readMarker(dir);
		expect(m.schemaVersion).toBe(1);
		expect(m.appPath).toBe("/Applications/Agent Orchestrator.app");
		expect(m.version).toBe("0.0.0");
		expect(m.installedAt).toBe("2026-06-26T10:00:00.000Z");
		expect(m.lastReconciledAt).toBe("2026-06-26T10:00:00.000Z");
		expect(m.installSource).toBe("npm-bootstrap");
	});

	it("second write PRESERVES installedAt/installSource and updates appPath/version/lastReconciledAt", async () => {
		await writeAppStateMarker({
			stateDir: dir,
			appPath: "/tmp/staging/Agent Orchestrator.app",
			version: "0.0.0",
			installedVia: "npm-bootstrap",
			now: () => new Date("2026-06-26T10:00:00.000Z"),
		});

		// Second launch: app relocated, version bumped, different install arg.
		await writeAppStateMarker({
			stateDir: dir,
			appPath: "/Applications/Agent Orchestrator.app",
			version: "1.2.3",
			installedVia: "github",
			now: () => new Date("2026-06-26T11:30:00.000Z"),
		});

		const m = await readMarker(dir);
		// Preserved from first creation.
		expect(m.installedAt).toBe("2026-06-26T10:00:00.000Z");
		expect(m.installSource).toBe("npm-bootstrap");
		// Refreshed.
		expect(m.appPath).toBe("/Applications/Agent Orchestrator.app");
		expect(m.version).toBe("1.2.3");
		expect(m.lastReconciledAt).toBe("2026-06-26T11:30:00.000Z");
	});

	it("written JSON keys exactly match the Go reader struct", async () => {
		await writeAppStateMarker({
			stateDir: dir,
			appPath: "/Applications/Agent Orchestrator.app",
			version: "0.0.0",
			installedVia: "npm-bootstrap",
			now: () => new Date("2026-06-26T10:00:00.000Z"),
		});

		const raw = await readFile(path.join(dir, APP_STATE_FILE_NAME), "utf8");
		const keys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
		expect(keys.sort()).toEqual([...GO_READER_KEYS].sort());
		// Trailing newline, mirroring runfile.Write.
		expect(raw.endsWith("}\n")).toBe(true);
	});

	it("installedVia undefined => installSource 'unknown'", async () => {
		await writeAppStateMarker({
			stateDir: dir,
			appPath: "/Applications/Agent Orchestrator.app",
			version: "0.0.0",
			now: () => new Date("2026-06-26T10:00:00.000Z"),
		});

		const m = await readMarker(dir);
		expect(m.installSource).toBe("unknown");
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeAppStateMarker({
			stateDir: dir,
			appPath: "/Applications/Agent Orchestrator.app",
			version: "0.0.0",
			installedVia: "npm-bootstrap",
			now: () => new Date("2026-06-26T10:00:00.000Z"),
		});

		const entries = await readdir(dir);
		expect(entries).toEqual([APP_STATE_FILE_NAME]);
		expect(entries.some((e) => e.startsWith(".app-state-"))).toBe(false);
	});

	it("creates the state dir when it does not exist", async () => {
		const nested = path.join(dir, "does", "not", "exist");
		await writeAppStateMarker({
			stateDir: nested,
			appPath: "/Applications/Agent Orchestrator.app",
			version: "0.0.0",
			now: () => new Date("2026-06-26T10:00:00.000Z"),
		});

		const m = await readMarker(nested);
		expect(m.appPath).toBe("/Applications/Agent Orchestrator.app");
	});
});
