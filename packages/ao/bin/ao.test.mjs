import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const shimSource = path.join(here, "ao.js");

let cleanup = [];

beforeEach(() => {
	cleanup = [];
});

afterEach(async () => {
	await Promise.all(
		cleanup
			.splice(0)
			.reverse()
			.map((item) => item()),
	);
});

// --- M10 (#293): the shim promised conventional 128+signal exit codes and did not
// deliver them.
//
// `if (result.signal) process.exit(1)` collapsed EVERY signal termination to exit
// 1 — indistinguishable from an ordinary command failure. A user pressing Ctrl-C,
// or a supervisor SIGTERMing the daemon, looked exactly like `ao` had errored, so
// wrappers, shells and CI could not tell cancellation from failure.
describe("@aoagents/ao npm shim", () => {
	it("maps SIGINT to the conventional 128+SIGINT exit code", async () => {
		const shim = await installShim("kill -INT $$");

		const result = await run(process.execPath, [shim]);

		assert.equal(result.code, 128 + os.constants.signals.SIGINT, "Ctrl-C must not look like a generic failure");
	});

	it("maps SIGTERM to the conventional 128+SIGTERM exit code", async () => {
		const shim = await installShim("kill -TERM $$");

		const result = await run(process.execPath, [shim]);

		assert.equal(result.code, 128 + os.constants.signals.SIGTERM);
	});

	it("passes an ordinary non-zero exit code straight through", async () => {
		const shim = await installShim("exit 3");

		const result = await run(process.execPath, [shim]);

		assert.equal(result.code, 3, "a real failure must keep its own status, not be rewritten");
	});

	it("passes a successful exit through", async () => {
		const shim = await installShim("exit 0");

		const result = await run(process.execPath, [shim]);

		assert.equal(result.code, 0);
	});
});

// Stage the real shim beside a fake platform package, so require.resolve finds a
// binary we control. The shim resolves `@aoagents/ao-<platform>-<arch>` relative
// to its OWN path, so node_modules must sit above it.
async function installShim(binaryBody) {
	const root = await mkdtemp(path.join(os.tmpdir(), "ao-shim-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));

	const pkg = `ao-${process.platform}-${process.arch}`;
	const pkgDir = path.join(root, "node_modules", "@aoagents", pkg);
	await mkdir(path.join(pkgDir, "bin"), { recursive: true });
	await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: `@aoagents/${pkg}`, version: "0.0.0" }));

	const binary = path.join(pkgDir, "bin", process.platform === "win32" ? "ao.exe" : "ao");
	await writeFile(binary, `#!/bin/sh\n${binaryBody}\n`);
	await chmod(binary, 0o755);

	const shimDir = path.join(root, "bin");
	await mkdir(shimDir, { recursive: true });
	const shim = path.join(shimDir, "ao.js");
	await cp(shimSource, shim);
	return shim;
}

function run(command, args) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => (stderr += c));
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}
