import { describe, expect, it } from "vitest";
import { resolveDaemonLaunch } from "./daemon-launch";

describe("resolveDaemonLaunch", () => {
	it("uses AO_DAEMON_COMMAND when configured", () => {
		expect(
			resolveDaemonLaunch({ AO_DAEMON_COMMAND: "/tmp/ao daemon" }, false, "/resources", "/app", "/home/user", "darwin"),
		).toEqual({
			command: "/tmp/ao daemon",
			args: [],
			cwd: "/app",
			shell: true,
			source: "configured",
		});
	});

	it("runs the backend daemon from source in dev without an explicit command", () => {
		expect(resolveDaemonLaunch({}, false, "/resources", "/repo/frontend", "/home/user", "darwin")).toEqual({
			command: "go",
			args: ["run", "./cmd/ao", "daemon"],
			cwd: "/repo/frontend/../backend",
			shell: false,
			source: "dev",
		});
	});

	it("uses the bundled daemon binary for packaged macOS/Linux builds", () => {
		expect(
			resolveDaemonLaunch(
				{},
				true,
				"/Applications/Agent Orchestrator.app/Contents/Resources",
				"/app",
				"/Users/alice",
				"darwin",
			),
		).toEqual({
			command: "/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao",
			args: ["daemon"],
			cwd: "/Users/alice/.ao",
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
				"C:\\Users\\alice",
				"win32",
			),
		).toEqual({
			command: "C:\\Program Files\\AO\\resources/daemon/ao.exe",
			args: ["daemon"],
			cwd: "C:\\Users\\alice/.ao",
			shell: false,
			source: "bundled",
		});
	});
});
