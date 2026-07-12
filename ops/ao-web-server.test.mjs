import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createAoWebServer } from "./ao-web-server.mjs";
import {
	childEnv,
	freePort,
	listen as listenWithCleanup,
	releaseSymlinkScript,
	repoRootFrom,
	spawnNode,
	waitForHttp,
} from "./main-invocation-test-helpers.mjs";

const REPO_ROOT = repoRootFrom(import.meta.url);

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

describe("ao web production server", () => {
	it("serves built assets and falls back to index.html for SPA routes", async () => {
		const distDir = await makeDist();
		const server = await listen(createAoWebServer({ distDir, apiTarget: "http://127.0.0.1:9" }));

		const index = await fetchText(`${server.url}/projects/agent/sessions/one`);
		assert.match(index.body, /<div id="root"><\/div>/);
		assert.equal(index.headers.get("cache-control"), "no-store");

		const asset = await fetchText(`${server.url}/assets/app.js`);
		assert.equal(asset.body, "console.log('ao');\n");
		assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

		const missingAsset = await fetchText(`${server.url}/assets/missing.js`);
		assert.equal(missingAsset.status, 404);
	});

	it("serves the browser favicon from the built static bundle", async () => {
		const distDir = await makeDist();
		const server = await listen(createAoWebServer({ distDir, apiTarget: "http://127.0.0.1:9" }));

		const favicon = await fetchText(`${server.url}/favicon.ico`);
		assert.equal(favicon.status, 200);
		assert.equal(favicon.body, "ico");
		assert.equal(favicon.headers.get("content-type"), "image/x-icon");
		assert.equal(favicon.headers.get("cache-control"), "public, max-age=31536000, immutable");
	});

	it("proxies daemon HTTP routes", async () => {
		let seenOrigin;
		const daemon = await listen(
			http.createServer((request, response) => {
				assert.equal(request.url, "/api/v1/projects");
				assert.equal(request.headers.host, daemon.host);
				seenOrigin = request.headers.origin;
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ projects: [{ id: "ao" }] }));
			}),
		);
		const distDir = await makeDist();
		const server = await listen(
			createAoWebServer({
				distDir,
				apiTarget: daemon.url,
				publicUrl: "https://mirrorborn.tailc1fd9.ts.net/",
			}),
		);

		const response = await fetch(`${server.url}/api/v1/projects`, {
			headers: { Origin: "https://mirrorborn.tailc1fd9.ts.net" },
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { projects: [{ id: "ao" }] });
		assert.equal(seenOrigin, undefined);
	});

	it("rejects proxied browser requests from untrusted origins before they reach the daemon", async () => {
		let daemonHit = false;
		const daemon = await listen(
			http.createServer((_request, response) => {
				daemonHit = true;
				response.end("{}");
			}),
		);
		const distDir = await makeDist();
		const server = await listen(
			createAoWebServer({
				distDir,
				apiTarget: daemon.url,
				publicUrl: "https://mirrorborn.tailc1fd9.ts.net/",
			}),
		);

		const response = await fetch(`${server.url}/api/v1/projects`, {
			headers: { Origin: "https://evil.example" },
		});
		assert.equal(response.status, 403);
		assert.equal(daemonHit, false);
	});

	it("proxies terminal mux websocket upgrades", async () => {
		let seenOrigin;
		const daemon = await listen(
			http.createServer().on("upgrade", (request, socket) => {
				assert.equal(request.url, "/mux");
				seenOrigin = request.headers.origin;
				socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
				socket.end("mux-opened");
			}),
		);
		const distDir = await makeDist();
		const server = await listen(
			createAoWebServer({
				distDir,
				apiTarget: daemon.url,
				publicUrl: "https://mirrorborn.tailc1fd9.ts.net/",
			}),
		);

		const socket = net.connect(server.port, "127.0.0.1");
		const response = await new Promise((resolve, reject) => {
			let data = "";
			socket.on("connect", () => {
				socket.write(
					[
						"GET /mux HTTP/1.1",
						`Host: ${server.host}`,
						"Connection: Upgrade",
						"Upgrade: websocket",
						"Origin: https://mirrorborn.tailc1fd9.ts.net",
						"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
						"Sec-WebSocket-Version: 13",
						"\r\n",
					].join("\r\n"),
				);
			});
			socket.on("data", (chunk) => {
				data += chunk.toString("utf8");
			});
			socket.on("end", () => resolve(data));
			socket.on("error", reject);
		});

		assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
		assert.match(response, /mux-opened/);
		assert.equal(seenOrigin, undefined);
	});

	it("rejects websocket upgrades from untrusted origins before they reach the daemon", async () => {
		let daemonHit = false;
		const daemon = await listen(
			http.createServer().on("upgrade", (_request, socket) => {
				daemonHit = true;
				socket.end();
			}),
		);
		const distDir = await makeDist();
		const server = await listen(
			createAoWebServer({
				distDir,
				apiTarget: daemon.url,
				publicUrl: "https://mirrorborn.tailc1fd9.ts.net/",
			}),
		);

		const socket = net.connect(server.port, "127.0.0.1");
		const response = await new Promise((resolve, reject) => {
			let data = "";
			socket.on("connect", () => {
				socket.write(
					[
						"GET /mux HTTP/1.1",
						`Host: ${server.host}`,
						"Connection: Upgrade",
						"Upgrade: websocket",
						"Origin: https://evil.example",
						"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
						"Sec-WebSocket-Version: 13",
						"\r\n",
					].join("\r\n"),
				);
			});
			socket.on("data", (chunk) => {
				data += chunk.toString("utf8");
			});
			socket.on("end", () => resolve(data));
			socket.on("error", reject);
		});

		assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
		assert.equal(daemonHit, false);
	});

	it("starts when invoked through the release current symlink", async () => {
		const distDir = await makeDist();
		const server = await startReleaseSymlinkServer(distDir);

		const response = await fetchText(server.url);
		assert.equal(response.status, 200);
		assert.match(response.body, /<div id="root"><\/div>/);
	});

	it("starts through the release symlink when Node preserves the main symlink", async () => {
		const distDir = await makeDist();
		const server = await startReleaseSymlinkServer(distDir, ["--preserve-symlinks-main"]);

		const response = await fetchText(server.url);
		assert.equal(response.status, 200);
		assert.match(response.body, /<div id="root"><\/div>/);
	});
});

async function makeDist() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-web-dist-"));
	await writeFile(path.join(dir, "index.html"), '<!doctype html><div id="root"></div>\n');
	await writeFile(path.join(dir, "favicon.ico"), "ico");
	await mkdir(path.join(dir, "assets"));
	await writeFile(path.join(dir, "assets", "app.js"), "console.log('ao');\n");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function listen(server) {
	return listenWithCleanup(server, cleanup);
}

async function startReleaseSymlinkServer(distDir, nodeArgs = []) {
	const script = await releaseSymlinkScript({
		cleanup,
		prefix: "ao-web-release-",
		repoRoot: REPO_ROOT,
		script: "ops/ao-web-server.mjs",
	});

	const port = await freePort();
	const { child, output } = spawnNode([...nodeArgs, script], {
		cleanup,
		env: childEnv(
			{
				AO_WEB_DIST: distDir,
				AO_WEB_PORT: String(port),
			},
			{ stripPrefixes: ["AO_WEB_"] },
		),
	});

	const url = `http://127.0.0.1:${port}/`;
	await waitForHttp(url, { child, output });
	return { child, output, url };
}

async function fetchText(url) {
	const response = await fetch(url);
	return {
		body: await response.text(),
		headers: response.headers,
		status: response.status,
	};
}
