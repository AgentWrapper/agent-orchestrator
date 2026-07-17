// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	resolveRemoteClientBuild,
	resolveRemoteClientIdentity,
	shouldUseCanonicalAppState,
} from "./remote-client-build";

describe("resolveRemoteClientBuild", () => {
	it("allows the environment override only in development", () => {
		expect(resolveRemoteClientBuild({ isPackaged: false, envOverride: true, markerExists: false })).toBe(true);
		expect(resolveRemoteClientBuild({ isPackaged: true, envOverride: true, markerExists: false })).toBe(false);
	});

	it("selects a packaged remote build only from its resource marker", () => {
		expect(resolveRemoteClientBuild({ isPackaged: true, envOverride: false, markerExists: true })).toBe(true);
		expect(resolveRemoteClientBuild({ isPackaged: true, envOverride: false, markerExists: false })).toBe(false);
	});
});

describe("resolveRemoteClientIdentity", () => {
	it("keeps the existing desktop identity for a local build", () => {
		expect(resolveRemoteClientIdentity(false)).toEqual({
			productName: "Agent Orchestrator",
			appBundleId: "dev.agent-orchestrator.desktop",
			executableName: "agent-orchestrator",
			userDataDirectoryName: "electron",
		});
	});

	it("gives the remote client a separate desktop identity and state directory", () => {
		expect(resolveRemoteClientIdentity(true)).toEqual({
			productName: "Agent Orchestrator Remote",
			appBundleId: "dev.agent-orchestrator.desktop.remote",
			executableName: "agent-orchestrator-remote",
			userDataDirectoryName: "electron-remote",
		});
	});
});

describe("remote client desktop policies", () => {
	it("keeps canonical app-state exclusive to the standard desktop app", () => {
		expect(shouldUseCanonicalAppState(false)).toBe(true);
		expect(shouldUseCanonicalAppState(true)).toBe(false);
	});

	it("uses the selected desktop identity for the native window title", async () => {
		const mainSource = await readFile(new URL("../main.ts", import.meta.url), "utf8");

		expect(mainSource).toMatch(/title:\s*clientIdentity\.productName/);
	});
});
