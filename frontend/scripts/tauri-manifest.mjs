// Generates the tauri-plugin-updater manifest (latest.json / nightly.json /
// pr-<N>.json) from a directory of built + signed bundle artifacts. Mirrors
// feed.mjs's role for electron-updater, but targets the Tauri v2 updater's
// JSON schema (https://v2.tauri.app/plugin/updater/#update-server-json-format)
// instead of electron-updater's YAML.
//
// Manifest filenames must byte-match the endpoints already hardcoded in
// src-tauri/src/updater/mod.rs's channel_endpoint():
//   latest -> releases/latest/download/latest.json
//   nightly -> releases/download/nightly/nightly.json
//   pr<N>  -> releases/download/pr<N>/pr-<N>.json
//
// Usage: node scripts/tauri-manifest.mjs <dir> <version> <channel>
// Env:
//   AO_RELEASE_REPO  owner/repo the release assets live in (default:
//                    $GITHUB_REPOSITORY, else AgentWrapper/agent-orchestrator —
//                    matches updater/mod.rs's release_repo() default).
//   AO_RELEASE_TAG   git tag the assets were uploaded to (default: v<version>,
//                    matching frontend-release.yml/feature-release.yml).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// detectPlatform maps a bundle filename to the tauri-plugin-updater platform
// key, using tauri-bundler's updater artifact naming
// (https://v2.tauri.app/distribute/updater/#update-artifacts). Each of the
// four native runners in tauri-release.yml produces exactly one of these:
//   macOS   *.app.tar.gz (name also carries aarch64/x64) -> darwin-aarch64 / darwin-x86_64
//   Linux   *.AppImage.tar.gz                              -> linux-x86_64
//   Windows *.nsis.zip or *.msi.zip                         -> windows-x86_64
export function detectPlatform(filename) {
	if (filename.endsWith(".app.tar.gz")) {
		if (filename.includes("aarch64")) return "darwin-aarch64";
		if (filename.includes("x64")) return "darwin-x86_64";
		return null;
	}
	if (filename.endsWith(".AppImage.tar.gz")) return "linux-x86_64";
	if (filename.endsWith(".nsis.zip") || filename.endsWith(".msi.zip")) return "windows-x86_64";
	return null;
}

// manifestFilename maps a channel to the manifest asset name the corresponding
// channel_endpoint() in updater/mod.rs downloads. Throws on an unrecognized
// channel so a typo'd CLI invocation fails loudly instead of silently writing
// the wrong file.
export function manifestFilename(channel) {
	if (channel === "latest") return "latest.json";
	if (channel === "nightly") return "nightly.json";
	const prMatch = /^pr(\d+)$/.exec(channel);
	if (prMatch) return `pr-${prMatch[1]}.json`;
	throw new Error(`unknown channel "${channel}" (expected "latest", "nightly", or "pr<N>")`);
}

// releaseDownloadUrl builds the GitHub Release asset URL the updater fetches
// once it has resolved a platform entry from the manifest.
export function releaseDownloadUrl(repo, tag, filename) {
	return `https://github.com/${repo}/releases/download/${tag}/${filename}`;
}

// buildManifest is the pure core: given a list of {filename, signature, url}
// entries (one per signed bundle actually present), returns the
// {version, pub_date, platforms} object tauri-plugin-updater expects. Kept
// separate from generateManifest() so it can be unit-tested with fixture data
// and no filesystem access. Throws if two entries resolve to the same
// platform key (a build should only ever produce one bundle per platform).
export function buildManifest(version, pubDate, entries) {
	const platforms = {};
	for (const { filename, signature, url } of entries) {
		const platform = detectPlatform(filename);
		if (!platform) continue;
		if (platforms[platform]) {
			throw new Error(`duplicate updater artifact for platform "${platform}": ${filename}`);
		}
		platforms[platform] = { signature, url };
	}
	return { version, pub_date: pubDate, platforms };
}

// generateManifest reads every file in `dir`, keeps the ones detectPlatform()
// recognizes AND that have a sibling `<filename>.sig` (written by tauri-bundler
// when TAURI_SIGNING_PRIVATE_KEY is set), builds the manifest, and writes it to
// dir/manifestFilename(channel). Returns the written path.
export function generateManifest(dir, version, channel, { repo, tag, pubDate = new Date().toISOString() } = {}) {
	const entries = [];
	for (const filename of readdirSync(dir)) {
		if (!detectPlatform(filename)) continue;
		const sigPath = join(dir, `${filename}.sig`);
		if (!existsSync(sigPath)) continue;
		const signature = readFileSync(sigPath, "utf8").trim();
		entries.push({ filename, signature, url: releaseDownloadUrl(repo, tag, filename) });
	}
	const manifest = buildManifest(version, pubDate, entries);
	if (Object.keys(manifest.platforms).length === 0) {
		throw new Error(`no signed updater artifacts (recognized bundle + sibling .sig) found in ${dir}`);
	}
	const outPath = join(dir, manifestFilename(channel));
	writeFileSync(outPath, JSON.stringify(manifest, null, "\t") + "\n");
	return outPath;
}

// CLI: node scripts/tauri-manifest.mjs <dir> <version> <channel>
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , dir, version, channel] = process.argv;
	if (!dir || !version || !channel) {
		process.stderr.write("usage: node tauri-manifest.mjs <dir> <version> <channel>\n");
		process.exit(2);
	}
	const repo = process.env.AO_RELEASE_REPO || process.env.GITHUB_REPOSITORY || "AgentWrapper/agent-orchestrator";
	const tag = process.env.AO_RELEASE_TAG || `v${version}`;
	try {
		const outPath = generateManifest(dir, version, channel, { repo, tag });
		process.stdout.write(`wrote ${outPath}\n`);
	} catch (err) {
		process.stderr.write(`${err.stack || err}\n`);
		process.exit(1);
	}
}
