// Fetches the pinned static tmux binary bundled into the macOS/Linux
// installers as a private fallback for machines with no system tmux
// (issue #2443). Artifacts are built from source by the tmux-artifacts
// workflow (.github/workflows/tmux-artifacts.yml); provenance and the
// rollover procedure are documented in frontend/docs/desktop-release.md.
//
// Runs from the prepackage/premake hooks so the binary exists BEFORE
// electron-forge copies extraResources and signs the bundle (resources
// written after signing make macOS report the app as "damaged").
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TMUX_DIST_TAG = "tmux-artifacts-v3.5a-1";
const TMUX_DIST_REPO = "AgentWrapper/agent-orchestrator";
// sha256 of the built binaries, from the release's checksums.txt. Bumping
// TMUX_DIST_TAG requires refreshing every hash here.
const TMUX_DIST = {
	"darwin-arm64": {
		asset: "tmux-darwin-arm64",
		sha256: "0000000000000000000000000000000000000000000000000000000000000000",
	},
	"darwin-x64": {
		asset: "tmux-darwin-x64",
		sha256: "0000000000000000000000000000000000000000000000000000000000000000",
	},
	"linux-x64": {
		asset: "tmux-linux-x64",
		sha256: "0000000000000000000000000000000000000000000000000000000000000000",
	},
};

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptsDir, "..");
const outDir = join(frontendRoot, "tmux-dist");
const outPath = join(outDir, "tmux");

if (process.platform === "win32") {
	console.log("fetch-tmux: Windows uses the built-in ConPTY runtime; nothing to bundle.");
	process.exit(0);
}

const key = `${process.platform}-${process.arch}`;
const dist = TMUX_DIST[key];
if (!dist) {
	// e.g. linux-arm64: not a published desktop target yet. The app still
	// works wherever a system tmux exists.
	console.warn(`fetch-tmux: no pinned tmux artifact for ${key}; skipping bundle.`);
	process.exit(0);
}

if (process.env.AO_SKIP_TMUX_FETCH === "1") {
	console.warn("fetch-tmux: AO_SKIP_TMUX_FETCH=1, skipping; the package will have no bundled tmux fallback.");
	process.exit(0);
}

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

if (existsSync(outPath) && sha256(readFileSync(outPath)) === dist.sha256) {
	console.log(`fetch-tmux: cached ${key} binary matches pin; skipping download.`);
	process.exit(0);
}

const url = `https://github.com/${TMUX_DIST_REPO}/releases/download/${TMUX_DIST_TAG}/${dist.asset}`;
console.log(`fetch-tmux: downloading ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
	console.error(`fetch-tmux: download failed: HTTP ${res.status} ${res.statusText}`);
	console.error("fetch-tmux: set AO_SKIP_TMUX_FETCH=1 to package without the bundled fallback (dev only).");
	process.exit(1);
}
const body = Buffer.from(await res.arrayBuffer());
const got = sha256(body);
if (got !== dist.sha256) {
	console.error(`fetch-tmux: checksum mismatch for ${dist.asset}: got ${got}, want ${dist.sha256}`);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, body);
chmodSync(outPath, 0o755);
console.log(`fetch-tmux: wrote ${outPath} (${body.length} bytes, sha256 verified).`);
