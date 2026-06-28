// Generates electron-updater feed metadata (latest*.yml / nightly*.yml) plus
// gzip sidecar blockmaps for a release's versioned installers. Dependency-free
// ESM (mirrors nightly-version.mjs) so CI runs `node scripts/feed.mjs` directly
// and vitest unit-tests the pure functions. The only non-stdlib reach is the
// blockmap wrapper (Task 1).
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeBlockmap } from "./blockmap.mjs";

// selectInstallers picks the versioned, auto-updatable installers from a release
// download dir, grouped by platform/arch. Excludes the ao-start aliases (no
// version string in their names) and deb/rpm (system-package-managed). The mac
// arch split keys on the literal "arm64" substring, the same discriminator the
// updater (MacUpdater.filterFilesForArch) uses.
export function selectInstallers(filenames, version) {
	const versioned = filenames.filter((f) => f.includes(version));
	const isDarwinZip = (f) => f.endsWith(".zip") && f.includes("darwin");
	return {
		win: versioned.filter((f) => f.endsWith(".exe")),
		linux: versioned.filter((f) => f.endsWith(".AppImage")),
		macArm64: versioned.filter((f) => isDarwinZip(f) && f.includes("arm64")),
		macX64: versioned.filter((f) => isDarwinZip(f) && !f.includes("arm64")),
	};
}

// feedFilename maps (channel, platform) to electron-updater's expected feed name.
// The updater adds its own OS/arch suffix client-side; we name the published
// asset to match: "" (win), "-mac", "-linux" (x64 Linux).
export function feedFilename(channel, platform) {
	const suffix = platform === "mac" ? "-mac" : platform === "linux" ? "-linux" : "";
	return `${channel}${suffix}.yml`;
}

// buildYml serializes one platform's feed. files is [{ url, sha512, size }];
// for mac the arm64 entry comes first. The deprecated top-level path/sha512
// point at files[0]. blockMapSize is never written (forces sidecar differential).
export function buildYml(version, files, releaseDate) {
	const lines = [`version: ${version}`, "files:"];
	for (const f of files) {
		lines.push(`  - url: ${f.url}`);
		lines.push(`    sha512: ${f.sha512}`);
		lines.push(`    size: ${f.size}`);
	}
	lines.push(`path: ${files[0].url}`);
	lines.push(`sha512: ${files[0].sha512}`);
	lines.push(`releaseDate: '${releaseDate}'`);
	return lines.join("\n") + "\n";
}

// generateFeeds writes the yml + sidecar blockmaps for every platform present in
// dir. version may carry +build metadata (nightly); strip it for the yml.
async function generateFeeds(dir, rawVersion, channel, releaseDate) {
	const version = rawVersion.split("+")[0];
	const sel = selectInstallers(readdirSync(dir), version);
	const groups = [
		{ platform: "win", names: sel.win },
		{ platform: "linux", names: sel.linux },
		{ platform: "mac", names: [...sel.macArm64, ...sel.macX64] }, // arm64 first
	];
	for (const { platform, names } of groups) {
		if (names.length === 0) continue;
		const files = [];
		for (const name of names) {
			const { sha512, size } = await writeBlockmap(join(dir, name));
			files.push({ url: name, sha512, size });
		}
		writeFileSync(join(dir, feedFilename(channel, platform)), buildYml(version, files, releaseDate));
	}
}

// CLI: node scripts/feed.mjs <dir> <version> <channel>
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , dir, version, channel] = process.argv;
	if (!dir || !version || !channel) {
		process.stderr.write("usage: node feed.mjs <dir> <version> <channel>\n");
		process.exit(2);
	}
	generateFeeds(dir, version, channel, new Date().toISOString()).catch((err) => {
		process.stderr.write(`${err.stack || err}\n`);
		process.exit(1);
	});
}
