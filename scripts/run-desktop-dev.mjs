import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(scriptDir, ".."));
const frontendRoot = join(repoRoot, "frontend");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const worktreeID = `wt-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)}`;

const childEnv = { ...process.env, AO_DEV_INSTANCE: worktreeID };
delete childEnv.AO_DATA_DIR;
delete childEnv.AO_RUN_FILE;
delete childEnv.AO_PORT;

console.log(`Starting isolated desktop instance ${worktreeID}`);
const child = spawn(npmCommand, ["run", "dev"], {
	cwd: frontendRoot,
	env: childEnv,
	detached: process.platform !== "win32",
	stdio: ["pipe", "inherit", "inherit"],
});

let stopping = false;
const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;

function stopChild(signal) {
	if (stopping || child.exitCode !== null || child.signalCode !== null) return;
	stopping = true;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T"], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}

function restoreStdin() {
	if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
	process.stdin.pause();
}

if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (data) => {
		if (data.includes(3)) {
			stopChild("SIGINT");
			return;
		}
		child.stdin?.write(data);
	});
} else {
	process.stdin.pipe(child.stdin);
}

process.once("SIGINT", () => stopChild("SIGINT"));
process.once("SIGTERM", () => stopChild("SIGTERM"));

child.on("error", (error) => {
	restoreStdin();
	console.error(`Could not start desktop development mode: ${error.message}`);
	process.exitCode = 1;
});

child.on("exit", (code, signal) => {
	restoreStdin();
	process.exitCode = stopping ? 0 : (code ?? (signal === "SIGINT" ? 130 : 1));
});
