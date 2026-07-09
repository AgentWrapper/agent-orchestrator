#!/usr/bin/env node
// Self-check for ao-phone-proxy.js: boots a mock daemon that records the
// Origin header it receives (and echoes it as ACAO, like the real CORS
// middleware), starts the proxy against it as a child process, and asserts
// the Origin/ACAO rewrites for REST, preflight, and WebSocket upgrade.
// TOFU pinning is not exercised here (everything is 127.0.0.1); it is
// unchanged first-IP-wins logic.
//
// No deps. Run:  node packages/mobile/scripts/ao-phone-proxy.test.js

const assert = require("assert");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROXY_PORT = 34011;
const UPSTREAM_PORT = 34012;
const REAL_ORIGIN = "http://remote.example:8081";

// --- mock daemon -----------------------------------------------------------
const seen = { rest: null, upgrade: null };
const upstream = http.createServer((req, res) => {
	seen.rest = req.headers.origin ?? null;
	res.writeHead(200, {
		"content-type": "application/json",
		// Mirror the daemon: echo ACAO = the Origin it received.
		...(req.headers.origin ? { "access-control-allow-origin": req.headers.origin } : {}),
	});
	res.end(JSON.stringify({ ok: true }));
});
upstream.on("upgrade", (req, socket) => {
	seen.upgrade = req.headers.origin ?? null;
	socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
	socket.write("hello-from-upstream");
});

function request(options) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, agent: false, ...options }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function main() {
	await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

	const proxy = spawn(process.execPath, [path.join(__dirname, "ao-phone-proxy.js")], {
		env: {
			...process.env,
			PORT: String(PROXY_PORT),
			TARGET: String(UPSTREAM_PORT),
			STATE: path.join(os.tmpdir(), `ao-proxy-test-${process.pid}.json`),
			RESET: "1",
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("proxy did not start")), 5000);
		proxy.stdout.on("data", (d) => {
			if (String(d).includes("AO phone bridge")) {
				clearTimeout(t);
				resolve();
			}
		});
		proxy.on("exit", (code) => reject(new Error(`proxy exited early (${code})`)));
	});

	try {
		// 1. REST: Origin rewritten upstream; ACAO rewritten back to the real origin.
		const rest = await request({ path: "/api/sessions", headers: { origin: REAL_ORIGIN } });
		assert.strictEqual(rest.status, 200);
		assert.strictEqual(seen.rest, "http://localhost", "upstream must see a loopback Origin");
		assert.strictEqual(
			rest.headers["access-control-allow-origin"],
			REAL_ORIGIN,
			"browser must see its real origin in ACAO",
		);
		assert.ok(String(rest.headers.vary ?? "").toLowerCase().includes("origin"), "response must vary on Origin");
		assert.strictEqual(JSON.parse(rest.body).ok, true, "body must stream through");

		// 2. No-Origin request (phone fetch / curl): passed through untouched.
		seen.rest = "unset";
		const bare = await request({ path: "/healthz" });
		assert.strictEqual(bare.status, 200);
		assert.strictEqual(seen.rest, null, "proxy must not invent an Origin");

		// 3. Preflight answered at the proxy; never reaches upstream.
		seen.rest = "unset";
		const pre = await request({
			method: "OPTIONS",
			path: "/api/sessions",
			headers: {
				origin: REAL_ORIGIN,
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		assert.strictEqual(pre.status, 204);
		assert.strictEqual(pre.headers["access-control-allow-origin"], REAL_ORIGIN);
		assert.ok(pre.headers["access-control-allow-methods"].includes("POST"));
		assert.strictEqual(pre.headers["access-control-allow-headers"], "content-type");
		assert.strictEqual(seen.rest, "unset", "preflight must not reach upstream");

		// 4. WebSocket upgrade: Origin rewritten; bytes pipe through after 101.
		await new Promise((resolve, reject) => {
			const req = http.request({
				host: "127.0.0.1",
				port: PROXY_PORT,
				path: "/mux",
				agent: false,
				headers: {
					origin: REAL_ORIGIN,
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
				},
			});
			req.on("upgrade", (res, socket, head) => {
				try {
					assert.strictEqual(res.statusCode, 101);
					assert.strictEqual(seen.upgrade, "http://localhost", "upstream upgrade must see a loopback Origin");
					const gotData = (buf) => {
						try {
							assert.strictEqual(String(buf), "hello-from-upstream", "post-upgrade bytes must pipe through");
							socket.destroy();
							resolve();
						} catch (e) {
							reject(e);
						}
					};
					if (head && head.length) gotData(head);
					else socket.once("data", gotData);
				} catch (e) {
					reject(e);
				}
			});
			req.on("error", reject);
			req.end();
			setTimeout(() => reject(new Error("upgrade timed out")), 5000).unref();
		});

		console.log("ok - all proxy self-checks passed");
		proxy.kill();
		upstream.close();
		process.exit(0);
	} catch (e) {
		proxy.kill();
		upstream.close();
		throw e;
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
