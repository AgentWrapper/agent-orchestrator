import { rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptsDir, "..");
const repoRoot = resolve(frontendRoot, "..");
const backendRoot = join(repoRoot, "backend");
const outDir = join(frontendRoot, "daemon");
const outPath = join(outDir, process.platform === "win32" ? "ao.exe" : "ao");
const minimumGoVersion = [1, 25, 7];

function parseGoVersion(value) {
	const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function meetsMinimumVersion(actual, minimum) {
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
	}
	return true;
}

const versionResult = spawnSync("go", ["version"], { encoding: "utf8" });
if (versionResult.error) {
	console.error(`Go ${minimumGoVersion.join(".")}+ is required, but Go could not be started: ${versionResult.error.message}`);
	process.exit(1);
}
const actualGoVersion = parseGoVersion(versionResult.stdout);
if (versionResult.status !== 0 || !actualGoVersion || !meetsMinimumVersion(actualGoVersion, minimumGoVersion)) {
	const found = actualGoVersion ? actualGoVersion.join(".") : versionResult.stdout.trim() || "unknown";
	console.error(`Go ${minimumGoVersion.join(".")}+ required, found ${found} — upgrade at https://go.dev/dl/`);
	process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = spawnSync("go", ["build", "-o", outPath, "./cmd/ao"], {
	cwd: backendRoot,
	stdio: "inherit",
});

if (result.error) {
	console.error(`failed to start go build: ${result.error.message}`);
	process.exit(1);
}

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}
