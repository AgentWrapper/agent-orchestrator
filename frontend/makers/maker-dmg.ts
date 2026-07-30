import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";

const run = promisify(execFile);

// macOS first-install distribution as a .dmg, so a user never runs an
// extraction step and the class of failure where a third-party unzip tool
// mishandles AppleDouble entries and breaks the code signature seal cannot
// happen at all. Full decision record: issue #3267, tracked as #3288
// workstream 6.
//
// This is ADDITIVE. The .zip must keep publishing forever:
// MacUpdater.doDownloadUpdate calls `findFile(files, "zip", ["pkg", "dmg"])`
// and throws ERR_UPDATER_ZIP_FILE_NOT_FOUND when it is absent, and findFile
// explicitly excludes .pkg and .dmg from candidates. There is no code path in
// electron-updater that can install an update from a .dmg, so the dmg is
// first-install only and never replaces the darwin maker-zip entry.
//
// Why bridge to app-builder-lib's `buildForge` instead of using Forge's own
// @electron-forge/maker-dmg: maker-dmg wraps electron-installer-dmg -> appdmg,
// neither of which have any notarize/staple code, and app-builder-lib's dmg
// target has the same limitation (dmg.sign defaults to false and its own docs
// warn against enabling it alongside notarization). So no maker solves signing
// for us and we need the same explicit postMake seal either way. Given that,
// consistency wins: app-builder-lib is already a direct dependency and already
// proven for a second-target bridge in maker-nsis.ts, so this reuses that
// pattern instead of pulling a second packaging engine into the tree for one
// platform. buildForge also needs no host tooling beyond hdiutil.

export type MakerDMGConfig = {
	// electron-builder appId; keep in sync with packagerConfig.appBundleId.
	appId?: string;
	// Volume/product name shown when the dmg is mounted. Defaults to appName.
	productName?: string;
	// Any extra electron-builder `dmg` options, merged over our defaults.
	dmg?: Record<string, unknown>;
};

export default class MakerDMG extends MakerBase<MakerDMGConfig> {
	name = "dmg";
	defaultPlatforms: ForgePlatform[] = ["darwin"];

	// hdiutil is macOS only, so unlike the NSIS bridge this cannot cross-build.
	isSupportedOnCurrentPlatform(): boolean {
		return process.platform === "darwin";
	}

	async make({ dir, targetArch, appName }: MakerOptions): Promise<string[]> {
		const { buildForge } = await import("app-builder-lib");
		const cfg = this.config ?? {};
		// Mirror buildForge's own output layout (<dir>/../make) so artifacts land
		// where Forge's publisher expects them.
		const output = path.join(path.dirname(path.resolve(dir)), "make");
		return buildForge(
			{ dir },
			{
				mac: [`dmg:${targetArch}`],
				config: {
					appId: cfg.appId,
					productName: cfg.productName ?? appName,
					directories: { output },
					// Forge owns publishing (the workflow uploads via `gh release`).
					// `null` stops electron-builder from inferring a GitHub publish
					// target from package.json `repository` and trying to upload.
					publish: null,
					mac: {
						// The .app inside is ALREADY signed, notarized and stapled by
						// Forge's packagerConfig.osxSign/osxNotarize, which run before any
						// maker. `identity: null` guarantees electron-builder never
						// re-signs it and breaks that seal; we only want its dmg target.
						identity: null,
					},
					dmg: {
						// Left unsigned on purpose. electron-builder's own docs: "Signing
						// is not required and will lead to unwanted errors in combination
						// with notarization requirements." The dmg container is sealed
						// afterwards by sealDmg() in forge.config.ts's postMake hook.
						sign: false,
						...cfg.dmg,
					},
				},
			},
		);
	}
}

// resolveSigningIdentity mirrors packagerConfig.osxSign's credential shapes.
// APPLE_SIGNING_IDENTITY is the explicit identity used in CI and in the local
// runbook. With only CSC_LINK set, electron-osx-sign discovers the identity
// from the keychain it imported the .p12 into; `codesign` does the same given
// the common prefix, so that is the fallback. Undefined means "no signing
// material", which is a legitimate state (unsigned local and testing builds).
function resolveSigningIdentity(env: NodeJS.ProcessEnv): string | undefined {
	if (env.APPLE_SIGNING_IDENTITY) return env.APPLE_SIGNING_IDENTITY;
	if (env.CSC_LINK) return "Developer ID Application";
	return undefined;
}

// resolveNotaryArgs mirrors packagerConfig.osxNotarize's two credential shapes:
// an AO_NOTARY_PROFILE notarytool keychain profile locally, or the App Store
// Connect API key trio in CI.
function resolveNotaryArgs(env: NodeJS.ProcessEnv): string[] | undefined {
	if (env.AO_NOTARY_PROFILE) return ["--keychain-profile", env.AO_NOTARY_PROFILE];
	if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
		return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
	}
	return undefined;
}

/**
 * sealDmg signs, notarizes and staples one .dmg.
 *
 * Neither maker-dmg nor app-builder-lib's dmg target does any of this, and the
 * .app's own stapled ticket does not propagate through an unsealed dmg
 * container, so the container needs its own explicit seal (#3267 decision 3).
 * Credentials are the exact same env vars packagerConfig already consumes; no
 * new secrets are introduced.
 *
 * With no signing material present this is a no-op with a warning, so unsigned
 * local builds and the unsigned desktop-testing pipeline still produce a dmg.
 * When credentials ARE present, any failure throws and fails the build: a
 * silently unsigned dmg published as a release asset is exactly the outcome
 * this work exists to prevent.
 */
export async function sealDmg(dmgPath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const identity = resolveSigningIdentity(env);
	if (!identity) {
		console.warn(`[dmg] no signing material (APPLE_SIGNING_IDENTITY / CSC_LINK); leaving ${dmgPath} unsigned`);
		return;
	}

	console.log(`[dmg] signing ${dmgPath}`);
	await run("codesign", ["--sign", identity, "--timestamp", "--force", dmgPath]);

	const notaryArgs = resolveNotaryArgs(env);
	if (!notaryArgs) {
		console.warn(`[dmg] no notarization credentials (AO_NOTARY_PROFILE / APPLE_API_KEY); ${dmgPath} is not notarized`);
		return;
	}

	console.log(`[dmg] notarizing ${dmgPath} (this waits on Apple)`);
	await run("xcrun", ["notarytool", "submit", dmgPath, ...notaryArgs, "--wait"], {
		// Notarization routinely takes several minutes.
		maxBuffer: 10 * 1024 * 1024,
	});

	console.log(`[dmg] stapling ${dmgPath}`);
	await run("xcrun", ["stapler", "staple", dmgPath]);
}

export { MakerDMG };
