import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const viteBin = resolve(scriptDir, "../node_modules/vite/bin/vite.js");
const args = [viteBin, "--config", "vite.renderer.config.ts", ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
	env: {
		...process.env,
		VITE_NO_ELECTRON: "1",
	},
	stdio: "inherit",
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 1);
});

child.on("error", (error) => {
	console.error(error);
	process.exit(1);
});
