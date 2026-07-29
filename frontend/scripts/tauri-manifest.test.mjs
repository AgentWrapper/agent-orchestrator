// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPlatform, manifestFilename, releaseDownloadUrl, buildManifest, generateManifest } from "./tauri-manifest.mjs";

describe("detectPlatform", () => {
	it("maps macOS .app.tar.gz bundles by arch", () => {
		expect(detectPlatform("Agent Orchestrator_0.11.0_aarch64.app.tar.gz")).toBe("darwin-aarch64");
		expect(detectPlatform("Agent Orchestrator_0.11.0_x64.app.tar.gz")).toBe("darwin-x86_64");
	});

	it("maps the Linux AppImage archive", () => {
		expect(detectPlatform("agent-orchestrator_0.11.0_amd64.AppImage.tar.gz")).toBe("linux-x86_64");
	});

	it("maps Windows nsis/msi update archives", () => {
		expect(detectPlatform("Agent Orchestrator_0.11.0_x64-setup.nsis.zip")).toBe("windows-x86_64");
		expect(detectPlatform("Agent Orchestrator_0.11.0_x64_en-US.msi.zip")).toBe("windows-x86_64");
	});

	it("returns null for non-updater artifacts (.sig, .deb, plain installers)", () => {
		expect(detectPlatform("Agent Orchestrator_0.11.0_x64-setup.exe")).toBeNull();
		expect(detectPlatform("agent-orchestrator_0.11.0_amd64.deb")).toBeNull();
		expect(detectPlatform("Agent Orchestrator_0.11.0_aarch64.app.tar.gz.sig")).toBeNull();
	});
});

describe("manifestFilename", () => {
	it("maps latest and nightly to their fixed manifest names", () => {
		expect(manifestFilename("latest")).toBe("latest.json");
		expect(manifestFilename("nightly")).toBe("nightly.json");
	});

	it("maps pr<N> to pr-<N>.json, matching channel_endpoint() in updater/mod.rs", () => {
		expect(manifestFilename("pr2270")).toBe("pr-2270.json");
	});

	it("rejects an unrecognized channel", () => {
		expect(() => manifestFilename("stable")).toThrow(/unknown channel/);
	});
});

describe("releaseDownloadUrl", () => {
	it("builds a GitHub release asset download URL", () => {
		expect(releaseDownloadUrl("AgentWrapper/agent-orchestrator", "v0.11.0", "app.tar.gz")).toBe(
			"https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.11.0/app.tar.gz",
		);
	});
});

describe("buildManifest", () => {
	it("builds one platforms entry per recognized artifact", () => {
		const manifest = buildManifest("0.11.0", "2026-07-29T00:00:00.000Z", [
			{ filename: "Agent Orchestrator_0.11.0_aarch64.app.tar.gz", signature: "SIG_MAC_ARM", url: "u1" },
			{ filename: "Agent Orchestrator_0.11.0_x64.app.tar.gz", signature: "SIG_MAC_X64", url: "u2" },
			{ filename: "agent-orchestrator_0.11.0_amd64.AppImage.tar.gz", signature: "SIG_LINUX", url: "u3" },
			{ filename: "Agent Orchestrator_0.11.0_x64-setup.nsis.zip", signature: "SIG_WIN", url: "u4" },
		]);
		expect(manifest).toEqual({
			version: "0.11.0",
			pub_date: "2026-07-29T00:00:00.000Z",
			platforms: {
				"darwin-aarch64": { signature: "SIG_MAC_ARM", url: "u1" },
				"darwin-x86_64": { signature: "SIG_MAC_X64", url: "u2" },
				"linux-x86_64": { signature: "SIG_LINUX", url: "u3" },
				"windows-x86_64": { signature: "SIG_WIN", url: "u4" },
			},
		});
	});

	it("silently skips entries that are not recognized updater artifacts", () => {
		const manifest = buildManifest("0.11.0", "2026-07-29T00:00:00.000Z", [
			{ filename: "agent-orchestrator_0.11.0_amd64.deb", signature: "SIG", url: "u" },
		]);
		expect(manifest.platforms).toEqual({});
	});

	it("throws if two entries resolve to the same platform key", () => {
		expect(() =>
			buildManifest("0.11.0", "2026-07-29T00:00:00.000Z", [
				{ filename: "Agent Orchestrator_0.11.0_aarch64.app.tar.gz", signature: "A", url: "u1" },
				{ filename: "Agent Orchestrator_0.11.0-old_aarch64.app.tar.gz", signature: "B", url: "u2" },
			]),
		).toThrow(/duplicate updater artifact/);
	});
});

describe("generateManifest", () => {
	it("reads signed bundles from a directory and writes the manifest json", () => {
		const dir = mkdtempSync(join(tmpdir(), "tauri-manifest-test-"));
		const macBundle = "Agent Orchestrator_0.11.0_aarch64.app.tar.gz";
		const linuxBundle = "agent-orchestrator_0.11.0_amd64.AppImage.tar.gz";
		writeFileSync(join(dir, macBundle), "fake mac bundle");
		writeFileSync(join(dir, `${macBundle}.sig`), "FAKE_MAC_SIGNATURE\n");
		writeFileSync(join(dir, linuxBundle), "fake linux bundle");
		writeFileSync(join(dir, `${linuxBundle}.sig`), "FAKE_LINUX_SIGNATURE\n");
		// Present but unsigned: must be excluded (no sibling .sig).
		writeFileSync(join(dir, "Agent Orchestrator_0.11.0_x64-setup.nsis.zip"), "fake win bundle, no sig");

		const outPath = generateManifest(dir, "0.11.0", "latest", {
			repo: "AgentWrapper/agent-orchestrator",
			tag: "v0.11.0",
			pubDate: "2026-07-29T00:00:00.000Z",
		});

		expect(outPath).toBe(join(dir, "latest.json"));
		const manifest = JSON.parse(readFileSync(outPath, "utf8"));
		expect(manifest).toEqual({
			version: "0.11.0",
			pub_date: "2026-07-29T00:00:00.000Z",
			platforms: {
				"darwin-aarch64": {
					signature: "FAKE_MAC_SIGNATURE",
					url: `https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.11.0/${macBundle}`,
				},
				"linux-x86_64": {
					signature: "FAKE_LINUX_SIGNATURE",
					url: `https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.11.0/${linuxBundle}`,
				},
			},
		});

		rmSync(dir, { recursive: true, force: true });
	});

	it("writes pr-<N>.json for a pr<N> channel", () => {
		const dir = mkdtempSync(join(tmpdir(), "tauri-manifest-test-"));
		const linuxBundle = "agent-orchestrator_0.11.0-pr42.1_amd64.AppImage.tar.gz";
		writeFileSync(join(dir, linuxBundle), "fake linux bundle");
		writeFileSync(join(dir, `${linuxBundle}.sig`), "FAKE_LINUX_SIGNATURE");

		const outPath = generateManifest(dir, "0.11.0-pr42.1", "pr42", {
			repo: "AgentWrapper/agent-orchestrator",
			tag: "v0.11.0-pr42.1",
			pubDate: "2026-07-29T00:00:00.000Z",
		});

		expect(outPath).toBe(join(dir, "pr-42.json"));
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws when no signed updater artifacts are present", () => {
		const dir = mkdtempSync(join(tmpdir(), "tauri-manifest-test-"));
		writeFileSync(join(dir, "agent-orchestrator_0.11.0_amd64.deb"), "not an updater artifact");

		expect(() => generateManifest(dir, "0.11.0", "latest", { repo: "o/r", tag: "v0.11.0" })).toThrow(
			/no signed updater artifacts/,
		);

		rmSync(dir, { recursive: true, force: true });
	});
});
