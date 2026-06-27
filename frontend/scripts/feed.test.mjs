// @vitest-environment node
import { describe, it, expect } from "vitest";
import { selectInstallers, feedFilename, buildYml } from "./feed.mjs";

const V = "0.10.4";
const NAMES = [
	"Agent.Orchestrator.Setup.0.10.4.exe", // win versioned
	"Agent.Orchestrator-0.10.4.AppImage", // linux versioned
	"Agent.Orchestrator-darwin-arm64-0.10.4.zip", // mac arm64 versioned
	"Agent.Orchestrator-darwin-x64-0.10.4.zip", // mac x64 versioned
	"agent-orchestrator-darwin-arm64.zip", // ao-start alias (no version) -> excluded
	"agent-orchestrator-win32-x64.exe", // alias (no version) -> excluded
	"agent-orchestrator_0.10.4_amd64.deb", // deb -> excluded by extension
	"agent-orchestrator-0.10.4.x86_64.rpm", // rpm -> excluded by extension
];

describe("selectInstallers", () => {
	it("keeps only versioned exe/AppImage/darwin-zip, split by arch", () => {
		const s = selectInstallers(NAMES, V);
		expect(s.win).toEqual(["Agent.Orchestrator.Setup.0.10.4.exe"]);
		expect(s.linux).toEqual(["Agent.Orchestrator-0.10.4.AppImage"]);
		expect(s.macArm64).toEqual(["Agent.Orchestrator-darwin-arm64-0.10.4.zip"]);
		expect(s.macX64).toEqual(["Agent.Orchestrator-darwin-x64-0.10.4.zip"]);
	});
});

describe("feedFilename", () => {
	it("maps channel + platform to electron-updater names", () => {
		expect(feedFilename("latest", "win")).toBe("latest.yml");
		expect(feedFilename("latest", "mac")).toBe("latest-mac.yml");
		expect(feedFilename("latest", "linux")).toBe("latest-linux.yml");
		expect(feedFilename("nightly", "win")).toBe("nightly.yml");
		expect(feedFilename("nightly", "mac")).toBe("nightly-mac.yml");
		expect(feedFilename("nightly", "linux")).toBe("nightly-linux.yml");
	});
});

describe("buildYml", () => {
	it("serializes one file with deprecated top-level fields and no blockMapSize", () => {
		const yml = buildYml(
			"0.10.4",
			[{ url: "Agent.Orchestrator.Setup.0.10.4.exe", sha512: "AA/BB+cc==", size: 123 }],
			"2026-06-27T12:00:00.000Z",
		);
		expect(yml).toBe(
			"version: 0.10.4\n" +
				"files:\n" +
				"  - url: Agent.Orchestrator.Setup.0.10.4.exe\n" +
				"    sha512: AA/BB+cc==\n" +
				"    size: 123\n" +
				"path: Agent.Orchestrator.Setup.0.10.4.exe\n" +
				"sha512: AA/BB+cc==\n" +
				"releaseDate: '2026-06-27T12:00:00.000Z'\n",
		);
		expect(yml).not.toContain("blockMapSize");
	});

	it("lists both mac arches with arm64 first and points top-level at arm64", () => {
		const yml = buildYml(
			"0.10.4",
			[
				{ url: "Agent.Orchestrator-darwin-arm64-0.10.4.zip", sha512: "ARM==", size: 10 },
				{ url: "Agent.Orchestrator-darwin-x64-0.10.4.zip", sha512: "X64==", size: 20 },
			],
			"2026-06-27T12:00:00.000Z",
		);
		const lines = yml.split("\n");
		expect(lines[2]).toBe("  - url: Agent.Orchestrator-darwin-arm64-0.10.4.zip");
		expect(lines[5]).toBe("  - url: Agent.Orchestrator-darwin-x64-0.10.4.zip");
		expect(yml).toContain("path: Agent.Orchestrator-darwin-arm64-0.10.4.zip");
	});
});
