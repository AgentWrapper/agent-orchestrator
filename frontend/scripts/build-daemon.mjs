import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { meetsMinimumVersion, parseGoVersion, parseMinimumGoVersion } from "./go-version.mjs";

// --sidecar switches the build target from the Electron daemon layout
// (frontend/daemon/ao[.exe]) to the Tauri externalBin sidecar layout
// (frontend/src-tauri/binaries/ao-<target-triple>[.exe]). Tauri requires the
// sidecar to be named after the Rust target triple of the host that will run
// it (https://v2.tauri.app/develop/sidecar/); each CI runner builds its own
// native triple, so no cross-compilation is attempted here.
const sidecarMode = process.argv.includes("--sidecar");

// mapTargetTriple mirrors the four native runners in tauri-release.yml
// (macos-latest -> aarch64-apple-darwin, macos-15-intel -> x86_64-apple-darwin,
// windows-latest -> x86_64-pc-windows-msvc, ubuntu-latest -> x86_64-unknown-linux-gnu).
export function mapTargetTriple(platform, arch) {
	if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
	if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
	if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
	if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
	return null;
}

// The rest of this module has build-time side effects (spawns `go build`,
// deletes directories), so it only runs when invoked as the CLI entry point,
// not when imported (e.g. by the vitest unit test importing mapTargetTriple).
if (import.meta.url === `file://${process.argv[1]}`) {
	const scriptsDir = dirname(fileURLToPath(import.meta.url));
	const frontendRoot = resolve(scriptsDir, "..");
	const repoRoot = resolve(frontendRoot, "..");
	const backendRoot = join(repoRoot, "backend");

	let outDir;
	let outPath;
	if (sidecarMode) {
		const targetTriple = mapTargetTriple(process.platform, process.arch);
		if (!targetTriple) {
			console.error(
				`--sidecar: unsupported host platform/arch ${process.platform}/${process.arch} (expected one of the four tauri-release.yml runners)`,
			);
			process.exit(1);
		}
		outDir = join(frontendRoot, "src-tauri", "binaries");
		outPath = join(outDir, `ao-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`);
	} else {
		outDir = join(frontendRoot, "daemon");
		outPath = join(outDir, process.platform === "win32" ? "ao.exe" : "ao");
	}

	const minimumGoVersion = parseMinimumGoVersion(readFileSync(join(backendRoot, "go.mod"), "utf8"));

	if (!minimumGoVersion) {
		console.error("Could not determine the required Go version from backend/go.mod.");
		process.exit(1);
	}

	const versionResult = spawnSync("go", ["version"], { encoding: "utf8" });
	if (versionResult.error) {
		console.error(
			`Go ${minimumGoVersion.join(".")}+ is required, but Go could not be started: ${versionResult.error.message}`,
		);
		process.exit(1);
	}
	const actualGoVersion = parseGoVersion(versionResult.stdout);
	if (versionResult.status !== 0 || !actualGoVersion || !meetsMinimumVersion(actualGoVersion, minimumGoVersion)) {
		const found = actualGoVersion ? actualGoVersion.join(".") : versionResult.stdout.trim() || "unknown";
		console.error(`Go ${minimumGoVersion.join(".")}+ required, found ${found} — upgrade at https://go.dev/dl/`);
		process.exit(1);
	}

	if (sidecarMode) {
		// Sidecar mode only clears its own target file: src-tauri/binaries/ can
		// hold one sidecar per target triple, and wiping the whole directory
		// would destroy any other triple already staged there (e.g. by a prior
		// local run).
		mkdirSync(outDir, { recursive: true });
		rmSync(outPath, { force: true });
	} else {
		rmSync(outDir, { recursive: true, force: true });
		mkdirSync(outDir, { recursive: true });
	}

	// Pure-Go sqlite (modernc) needs no cgo; disabling it on Linux keeps the
	// sidecar static and portable across glibc versions (matches CGO_ENABLED=0
	// in testing-build.yml for the same reason).
	const buildEnv = sidecarMode && process.platform === "linux" ? { ...process.env, CGO_ENABLED: "0" } : process.env;

	const result = spawnSync("go", ["build", "-o", outPath, "./cmd/ao"], {
		cwd: backendRoot,
		stdio: "inherit",
		env: buildEnv,
	});

	if (result.error) {
		console.error(`failed to start go build: ${result.error.message}`);
		process.exit(1);
	}

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
