import { describe, expect, it } from "vitest";
import { bundledTmuxPath, resolveDaemonLaunch } from "./daemon-launch";

describe("resolveDaemonLaunch", () => {
	it("uses AO_DAEMON_COMMAND when configured", () => {
		expect(resolveDaemonLaunch({ AO_DAEMON_COMMAND: "/tmp/ao daemon" }, false, "/resources", "/app", "darwin")).toEqual(
			{
				command: "/tmp/ao daemon",
				args: [],
				cwd: "/app",
				shell: true,
				source: "configured",
			},
		);
	});

	it("runs the backend daemon from source in dev without an explicit command", () => {
		expect(resolveDaemonLaunch({}, false, "/resources", "/repo/frontend", "darwin")).toEqual({
			command: "go",
			args: ["run", "./cmd/ao", "daemon"],
			cwd: "/repo/frontend/../backend",
			shell: false,
			source: "dev",
		});
	});

	it("uses the bundled daemon binary for packaged macOS/Linux builds", () => {
		expect(
			resolveDaemonLaunch({}, true, "/Applications/Agent Orchestrator.app/Contents/Resources", "/app", "darwin"),
		).toEqual({
			command: "/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao",
			args: ["daemon"],
			cwd: "/Applications/Agent Orchestrator.app/Contents/Resources",
			shell: false,
			source: "bundled",
		});
	});

	it("uses the bundled daemon exe for packaged Windows builds", () => {
		expect(
			resolveDaemonLaunch(
				{},
				true,
				"C:\\Program Files\\AO\\resources",
				"C:\\Program Files\\AO\\resources\\app.asar",
				"win32",
			),
		).toEqual({
			command: "C:\\Program Files\\AO\\resources/daemon/ao.exe",
			args: ["daemon"],
			cwd: "C:\\Program Files\\AO\\resources",
			shell: false,
			source: "bundled",
		});
	});
});

describe("bundledTmuxPath", () => {
	const resources = "/Applications/Agent Orchestrator.app/Contents/Resources";
	const bundled = `${resources}/tmux-dist/tmux`;

	it("returns the resource path when packaged and the binary exists", () => {
		expect(bundledTmuxPath(true, resources, "darwin", (p) => p === bundled)).toBe(bundled);
	});

	it("returns null in dev so the daemon resolves system tmux only", () => {
		expect(bundledTmuxPath(false, resources, "darwin", () => true)).toBeNull();
	});

	it("returns null on Windows where ConPTY needs no tmux", () => {
		expect(bundledTmuxPath(true, "C:\\AO\\resources", "win32", () => true)).toBeNull();
	});

	it("returns null when the resource is missing (AO_SKIP_TMUX_FETCH builds)", () => {
		expect(bundledTmuxPath(true, resources, "linux", () => false)).toBeNull();
	});
});
