import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createAoWebServer } from "./ao-web-server.mjs";

let cleanup = [];

beforeEach(() => {
	cleanup = [];
});

afterEach(async () => {
	await Promise.all(cleanup.splice(0).reverse().map((item) => item()));
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
});

async function makeDist() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-web-dist-"));
	await writeFile(path.join(dir, "index.html"), '<!doctype html><div id="root"></div>\n');
	await mkdir(path.join(dir, "assets"));
	await writeFile(path.join(dir, "assets", "app.js"), "console.log('ao');\n");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function listen(server) {
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

async function fetchText(url) {
	const response = await fetch(url);
	return {
		body: await response.text(),
		headers: response.headers,
		status: response.status,
	};
}
