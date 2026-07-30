import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture buildForge's args without pulling in electron-builder's real machinery.
const buildForge = vi.fn<(forge: { dir: string }, options: any) => Promise<string[]>>(async () => [
	"/out/make/Agent Orchestrator-0.10.3-arm64.dmg",
]);
vi.mock("app-builder-lib", () => ({ buildForge }));

// Capture the commands sealDmg would run, without ever spawning codesign or
// xcrun. maker-dmg promisifies execFile at module load, so the stub has to keep
// the callback shape promisify expects.
const commands: Array<[string, string[]]> = [];
let nextError: Error | undefined;
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
		const done = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
			err: Error | null,
			stdout?: string,
			stderr?: string,
		) => void;
		commands.push([cmd, args]);
		if (nextError) {
			const err = nextError;
			nextError = undefined;
			done(err);
			return;
		}
		done(null, "", "");
	};
	return { ...actual, default: { ...actual, execFile }, execFile };
});

import MakerDMG, { sealDmg } from "./maker-dmg";

const makeOptions = {
	dir: "/tmp/app/Agent Orchestrator-darwin-arm64",
	makeDir: "/tmp/app/make",
	appName: "Agent Orchestrator",
	targetPlatform: "darwin" as const,
	targetArch: "arm64" as const,
	forgeConfig: {} as never,
	packageJSON: {},
};

beforeEach(() => {
	buildForge.mockClear();
	commands.length = 0;
	nextError = undefined;
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("MakerDMG", () => {
	it("targets darwin and only builds on macOS (hdiutil is not portable)", () => {
		const maker = new MakerDMG();
		expect(maker.name).toBe("dmg");
		expect(maker.defaultPlatforms).toEqual(["darwin"]);
		expect(maker.isSupportedOnCurrentPlatform()).toBe(process.platform === "darwin");
	});

	it("builds a dmg target for the requested arch and forwards config", async () => {
		const maker = new MakerDMG({ appId: "dev.agent-orchestrator.desktop" }, ["darwin"]);
		await maker.prepareConfig(makeOptions.targetArch);
		const artifacts = await maker.make(makeOptions);

		expect(artifacts).toEqual(["/out/make/Agent Orchestrator-0.10.3-arm64.dmg"]);
		const [forgeOptions, options] = buildForge.mock.calls[0];
		expect(forgeOptions).toEqual({ dir: makeOptions.dir });
		expect(options.mac).toEqual(["dmg:arm64"]);
		// electron-builder must not try to publish; the workflow does that.
		expect(options.config.publish).toBeNull();
		expect(options.config.appId).toBe("dev.agent-orchestrator.desktop");
		expect(options.config.productName).toBe("Agent Orchestrator");
	});

	it("never lets electron-builder re-sign the already notarized .app", () => {
		// packagerConfig.osxSign/osxNotarize seal the bundle before any maker runs.
		// identity: null is what keeps this maker from touching that seal.
		return new MakerDMG().make(makeOptions).then(() => {
			const [, options] = buildForge.mock.calls.at(-1)!;
			expect(options.config.mac.identity).toBeNull();
		});
	});

	it("leaves the dmg container unsigned for the postMake seal to handle", async () => {
		await new MakerDMG().make(makeOptions);
		const [, options] = buildForge.mock.calls.at(-1)!;
		// electron-builder's docs warn that dmg.sign conflicts with notarization;
		// sealDmg signs + notarizes + staples the container instead.
		expect(options.config.dmg.sign).toBe(false);
	});
});

describe("sealDmg", () => {
	const dmg = "/out/make/app.dmg";

	it("does nothing when there is no signing material (unsigned local builds)", async () => {
		await sealDmg(dmg, {});
		expect(commands).toEqual([]);
	});

	it("signs, notarizes with a keychain profile, and staples", async () => {
		await sealDmg(dmg, { APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (TEAMID)", AO_NOTARY_PROFILE: "ao" });

		expect(commands[0]).toEqual([
			"codesign",
			["--sign", "Developer ID Application: Someone (TEAMID)", "--timestamp", "--force", dmg],
		]);
		expect(commands[1]).toEqual(["xcrun", ["notarytool", "submit", dmg, "--keychain-profile", "ao", "--wait"]]);
		expect(commands[2]).toEqual(["xcrun", ["stapler", "staple", dmg]]);
	});

	it("uses the App Store Connect API key trio when that is what CI provides", async () => {
		await sealDmg(dmg, {
			APPLE_SIGNING_IDENTITY: "id",
			APPLE_API_KEY: "/tmp/key.p8",
			APPLE_API_KEY_ID: "KEYID",
			APPLE_API_ISSUER: "ISSUER",
		});
		expect(commands[1][1]).toEqual([
			"notarytool",
			"submit",
			dmg,
			"--key",
			"/tmp/key.p8",
			"--key-id",
			"KEYID",
			"--issuer",
			"ISSUER",
			"--wait",
		]);
	});

	it("falls back to the keychain identity prefix when only CSC_LINK is set", async () => {
		await sealDmg(dmg, { CSC_LINK: "base64p12" });
		expect(commands[0][1]).toEqual(["--sign", "Developer ID Application", "--timestamp", "--force", dmg]);
	});

	it("signs but skips notarization when no notary credentials are present", async () => {
		await sealDmg(dmg, { APPLE_SIGNING_IDENTITY: "id" });
		expect(commands).toHaveLength(1);
		expect(commands[0][0]).toBe("codesign");
	});

	it("fails the build when signing fails and credentials were present", async () => {
		nextError = new Error("codesign: no identity found");
		await expect(sealDmg(dmg, { APPLE_SIGNING_IDENTITY: "id" })).rejects.toThrow(/no identity found/);
	});
});
