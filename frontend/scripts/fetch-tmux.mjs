// Fetches the pinned static tmux binary bundled into the macOS/Linux
// installers as a private fallback for machines with no system tmux
// (issue #2443). Artifacts are built from source by the tmux-artifacts
// workflow (.github/workflows/tmux-artifacts.yml); provenance and the
// rollover procedure are documented in frontend/docs/desktop-release.md.
//
// Runs from the prepackage/premake hooks so the binary exists BEFORE
// electron-forge copies extraResources and signs the bundle (resources
// written after signing make macOS report the app as "damaged").
//
// The tmux-artifacts release referenced below does not exist on every
// fork/branch (it is published by manually dispatching the workflow above),
// so a missing release or an unpinned checksum only fails the build when
// AO_REQUIRE_TMUX_FETCH=1 — set by the official signed release/nightly
// workflows. Everywhere else this degrades to "no bundled fallback", same as
// AO_SKIP_TMUX_FETCH, so default/dev/testing packaging never breaks on it.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TMUX_DIST_TAG = "tmux-artifacts-v3.5a-1";
const TMUX_DIST_REPO = "AgentWrapper/agent-orchestrator";
// Optional sha256 pins for in-repo provenance. After dispatching
// tmux-artifacts, copy each asset hash from the release's checksums.txt
// here; when set, the pin must match checksums.txt or packaging fails.
// Bumping TMUX_DIST_TAG requires refreshing every pin.
const TMUX_DIST = {
	"darwin-arm64": {
		asset: "tmux-darwin-arm64",
	},
	"darwin-x64": {
		asset: "tmux-darwin-x64",
	},
	"linux-x64": {
		asset: "tmux-linux-x64",
	},
};

export const PLACEHOLDER_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

/** @param {string} text */
export function parseChecksumsFile(text) {
	/** @type {Map<string, string>} */
	const map = new Map();
	for (const line of text.trim().split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
		if (!match) continue;
		map.set(match[2], match[1]);
	}
	return map;
}

/** @param {string | undefined} hash */
export function isPlaceholderSha256(hash) {
	return !hash || hash === PLACEHOLDER_SHA256;
}

/**
 * @param {string | undefined} pinnedSha256
 * @param {Map<string, string>} checksums
 * @param {string} asset
 */
export function resolveExpectedHash(pinnedSha256, checksums, asset) {
	const fromRelease = checksums.get(asset);
	if (!fromRelease) {
		throw new Error(`asset ${asset} not found in release checksums.txt`);
	}
	if (!isPlaceholderSha256(pinnedSha256)) {
		if (pinnedSha256 !== fromRelease) {
			throw new Error(`pinned sha256 for ${asset} does not match release checksums.txt`);
		}
		return pinnedSha256;
	}
	return fromRelease;
}

/** @param {string} tag @param {string} repo */
export function releaseAssetUrl(tag, repo, asset) {
	return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptsDir, "..");
const outDir = join(frontendRoot, "tmux-dist");
const outPath = join(outDir, "tmux");

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

async function main() {
	if (process.platform === "win32") {
		console.log("fetch-tmux: Windows uses the built-in ConPTY runtime; nothing to bundle.");
		return;
	}

	const key = `${process.platform}-${process.arch}`;
	const dist = TMUX_DIST[key];
	if (!dist) {
		// e.g. linux-arm64: not a published desktop target yet. The app still
		// works wherever a system tmux exists.
		console.warn(`fetch-tmux: no pinned tmux artifact for ${key}; skipping bundle.`);
		return;
	}

	if (process.env.AO_SKIP_TMUX_FETCH === "1") {
		console.warn("fetch-tmux: AO_SKIP_TMUX_FETCH=1, skipping; the package will have no bundled tmux fallback.");
		return;
	}

	// Official signed release/nightly builds set this so a missing artifact
	// release or an unpinned checksum fails the build loudly instead of
	// silently shipping without the bundled fallback. Everywhere else (local
	// packaging, PR/testing-build CI) degrades gracefully: the tmux-artifacts
	// release may not exist yet on every fork/branch, and that must not break
	// default packaging.
	const required = process.env.AO_REQUIRE_TMUX_FETCH === "1";

	if (isPlaceholderSha256(dist.sha256)) {
		if (required) {
			console.error(`fetch-tmux: AO_REQUIRE_TMUX_FETCH=1 but no sha256 pin is set for ${dist.asset}.`);
			console.error("fetch-tmux: pin the release's checksums.txt hash in fetch-tmux.mjs before cutting a signed release.");
			process.exit(1);
		}
		console.warn(
			`fetch-tmux: no sha256 pin for ${dist.asset}; using release checksums.txt (pin it in fetch-tmux.mjs after verifying provenance).`,
		);
	}

	const checksumsUrl = releaseAssetUrl(TMUX_DIST_TAG, TMUX_DIST_REPO, "checksums.txt");
	console.log(`fetch-tmux: fetching ${checksumsUrl}`);
	const checksumsRes = await fetch(checksumsUrl, { redirect: "follow" });
	if (!checksumsRes.ok) {
		console.error(`fetch-tmux: checksums.txt download failed: HTTP ${checksumsRes.status} ${checksumsRes.statusText}`);
		console.error(`fetch-tmux: dispatch .github/workflows/tmux-artifacts.yml to publish ${TMUX_DIST_TAG}, or set AO_SKIP_TMUX_FETCH=1 for dev packaging.`);
		if (required) {
			process.exit(1);
		}
		console.warn("fetch-tmux: continuing without the bundled tmux fallback (set AO_REQUIRE_TMUX_FETCH=1 to make this fatal).");
		return;
	}

	let expectedHash;
	try {
		expectedHash = resolveExpectedHash(dist.sha256, parseChecksumsFile(await checksumsRes.text()), dist.asset);
	} catch (err) {
		console.error(`fetch-tmux: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	if (existsSync(outPath) && sha256(readFileSync(outPath)) === expectedHash) {
		console.log(`fetch-tmux: cached ${key} binary matches pin; skipping download.`);
		return;
	}

	const url = releaseAssetUrl(TMUX_DIST_TAG, TMUX_DIST_REPO, dist.asset);
	console.log(`fetch-tmux: downloading ${url}`);
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) {
		console.error(`fetch-tmux: download failed: HTTP ${res.status} ${res.statusText}`);
		if (required) {
			process.exit(1);
		}
		console.warn("fetch-tmux: continuing without the bundled tmux fallback (set AO_REQUIRE_TMUX_FETCH=1 to make this fatal).");
		return;
	}
	const body = Buffer.from(await res.arrayBuffer());
	const got = sha256(body);
	if (got !== expectedHash) {
		console.error(`fetch-tmux: checksum mismatch for ${dist.asset}: got ${got}, want ${expectedHash}`);
		process.exit(1);
	}

	mkdirSync(outDir, { recursive: true });
	writeFileSync(outPath, body);
	chmodSync(outPath, 0o755);
	console.log(`fetch-tmux: wrote ${outPath} (${body.length} bytes, sha256 verified).`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	await main();
}
