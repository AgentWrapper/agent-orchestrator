import { readFileSync } from "node:fs";
import { rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptsDir, "..");
const repoRoot = resolve(frontendRoot, "..");
const backendRoot = join(repoRoot, "backend");
const outDir = join(frontendRoot, "daemon");
const outPath = join(outDir, process.platform === "win32" ? "ao.exe" : "ao");

// Go version preflight: read required version from go.mod and check against installed Go.
const goMod = readFileSync(join(backendRoot, "go.mod"), "utf-8");
const requiredGo = goMod.match(/^go\s+(\S+)/m)?.[1];
if (!requiredGo) {
	console.error("Could not parse Go version from go.mod");
	process.exit(1);
}
const installedGo = String(execSync("go version", { encoding: "utf-8" })).match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1];
if (!installedGo) {
	console.error("Could not detect installed Go version — is Go installed?");
	process.exit(1);
}
// Simple semver comparison: split each into [major, minor, patch], compare left to right.
const cmp = (a, b) => {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va !== vb) return va - vb;
	}
	return 0;
};
if (cmp(installedGo, requiredGo) < 0) {
	console.error(`Go ${requiredGo}+ required, found ${installedGo} — upgrade at https://go.dev/dl/`);
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
