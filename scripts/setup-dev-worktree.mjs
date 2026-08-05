import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
	meetsMinimumVersion,
	parseGoVersion,
	parseMinimumGoVersion,
} from "../frontend/scripts/go-version.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const frontendRoot = join(repoRoot, "frontend");
const landingRoot = join(frontendRoot, "src", "landing");
const backendRoot = join(repoRoot, "backend");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function parseVersion(value) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function meetsMinimum(actual, minimum) {
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
	}
	return true;
}

function commandOutput(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(`${command} could not be started: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout.trim();
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) {
		throw new Error(`${command} could not be started: ${result.error.message}`);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const minimumNode = [20, 19, 0];
const actualNode = parseVersion(process.versions.node);
if (!actualNode || !meetsMinimum(actualNode, minimumNode)) {
	throw new Error(`Node.js ${minimumNode.join(".")}+ is required, found ${process.versions.node}`);
}

const npmVersionText = commandOutput(npmCommand, ["--version"]);
const actualNpm = parseVersion(npmVersionText);
if (!actualNpm || !meetsMinimum(actualNpm, [10, 0, 0])) {
	throw new Error(`npm 10+ is required, found ${npmVersionText || "unknown"}`);
}

commandOutput("git", ["--version"]);
if (process.platform !== "win32") {
	const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (tmux.error || tmux.status !== 0) {
		console.warn("Warning: tmux is not in PATH. The app can open, but it cannot start agent sessions.");
	}
}
const goVersionText = commandOutput("go", ["version"]);
const actualGo = parseGoVersion(goVersionText);
const minimumGo = parseMinimumGoVersion(readFileSync(join(backendRoot, "go.mod"), "utf8"));
if (!actualGo || !minimumGo || !meetsMinimumVersion(actualGo, minimumGo)) {
	const required = minimumGo?.join(".") ?? "the version in backend/go.mod";
	const found = actualGo?.join(".") ?? (goVersionText || "unknown");
	throw new Error(`Go ${required}+ is required, found ${found}`);
}

console.log("Installing root dependencies from package-lock.json...");
run(npmCommand, ["ci"], repoRoot);

console.log("Installing desktop dependencies from frontend/package-lock.json...");
run(npmCommand, ["ci"], frontendRoot);

console.log("Installing landing-page test dependencies from frontend/src/landing/package-lock.json...");
run(npmCommand, ["ci"], landingRoot);

console.log("Downloading Go modules...");
run("go", ["mod", "download"], backendRoot);

console.log("Worktree ready. Use npm run dev, npm test, or npm run verify from the repo root.");
