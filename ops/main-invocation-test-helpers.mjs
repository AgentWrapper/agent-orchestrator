import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function repoRootFrom(testUrl) {
	return path.resolve(path.dirname(fileURLToPath(testUrl)), "..");
}

export async function releaseSymlinkScript({ cleanup, prefix, repoRoot, script }) {
	const releaseRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
	const releaseDir = path.join(releaseRoot, "releases", "abc123");
	const releaseSource = path.join(releaseDir, "source");
	const current = path.join(releaseRoot, "current");
	await mkdir(releaseDir, { recursive: true });
	await symlink(repoRoot, releaseSource, "dir");
	await symlink(releaseDir, current, "dir");
	cleanup.push(async () => {
		await rm(current, { force: true });
		await rm(releaseSource, { force: true });
		await rm(releaseRoot, { recursive: true, force: true });
	});
	return path.join(current, "source", script);
}

export async function emptyEnvPath(cleanup, prefix) {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return path.join(dir, ".env");
}

export async function listen(server, cleanup) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanup.push(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert(address && typeof address === "object");
	return {
		host: `127.0.0.1:${address.port}`,
		port: address.port,
		url: `http://127.0.0.1:${address.port}`,
	};
}

export async function freePort() {
	const server = http.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object");
	const { port } = address;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

export function childEnv(overrides, { stripPrefixes = [] } = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (stripPrefixes.some((prefix) => key.startsWith(prefix))) delete env[key];
	}
	return { ...env, ...overrides };
}

export function spawnNode(args, { cleanup, env }) {
	const output = { stderr: "", stdout: "" };
	const child = spawn(process.execPath, args, {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => {
		output.stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		output.stderr += chunk.toString("utf8");
	});
	cleanup.push(() => stopChild(child));
	return { child, output };
}

export async function waitForOutput({ child, output, pattern, timeoutMs = 3000 }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pattern.test(output.stdout) || pattern.test(output.stderr)) return;
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(
				`process exited before matching ${pattern}: exit=${child.exitCode} signal=${child.signalCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${pattern}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
}

export async function waitForExit({ child, output, timeoutMs = 3000 }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			return { code: child.exitCode, signal: child.signalCode };
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for process exit\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
}

export async function waitForHttp(url, options = {}) {
	const deadline = Date.now() + (options.timeoutMs ?? 3000);
	let lastError = new Error("server did not start");
	while (Date.now() < deadline) {
		if (options.child && (options.child.exitCode !== null || options.child.signalCode !== null)) {
			throw new Error(
				`server process exited before serving ${url}: exit=${options.child.exitCode} signal=${options.child.signalCode}\nstdout:\n${options.output?.stdout ?? ""}\nstderr:\n${options.output?.stderr ?? ""}`,
			);
		}
		try {
			const response = await fetch(url);
			await response.arrayBuffer();
			return response;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw lastError;
}

function stopChild(child) {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}

		let sigkillTimer;
		let failTimer;
		const done = () => {
			clearTimeout(sigkillTimer);
			clearTimeout(failTimer);
			resolve();
		};
		sigkillTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}, 2000);
		failTimer = setTimeout(() => {
			child.off("exit", done);
			reject(new Error(`child process did not exit after SIGTERM/SIGKILL: pid=${child.pid}`));
		}, 3000);

		child.once("exit", done);
		child.kill("SIGTERM");
	});
}
