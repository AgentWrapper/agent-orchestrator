#!/usr/bin/env node
// LAN bridge for the AO mobile app AND the mobile-web browser build -
// trust-on-first-connect.
//
// The AO daemon stays bound to localhost (127.0.0.1:3001) - fully local and
// unexposed. This script opens ONE LAN port and forwards it to the daemon.
// The FIRST device that connects is pinned as the only allowed device; every
// other IP is refused. No discovery, no manual allowlist. (Like SSH's TOFU.)
//
// Unlike the old raw TCP pipe, this is an HTTP-aware reverse proxy, because
// a BROWSER on another machine must pass the daemon's Origin guard
// (backend/internal/httpd/cors.go): the daemon 403s any non-loopback Origin
// not in AO_ALLOWED_ORIGINS, and a browser cannot spoof its Origin. So:
//   - the incoming Origin is rewritten to http://localhost before
//     forwarding (the daemon's isLoopbackOrigin check passes it),
//   - Access-Control-Allow-Origin on responses is rewritten BACK to the
//     browser's real origin (the browser requires ACAO == the page origin;
//     the daemon echoed the rewritten one),
//   - CORS preflights (OPTIONS) are answered here and never reach the daemon,
//   - WebSocket upgrades (/mux) get the same Origin rewrite; no ACAO rewrite
//     is needed because browsers don't run the CORS response check on WS.
// Phones (React Native fetch sends no Origin; its WebSocket pins a loopback
// one) pass through unchanged, so this remains the phone bridge too.
//
// The pairing is saved, so it survives restarts. To pair a different device,
// run once with RESET=1 (or delete the state file).
//
// Usage (from the repo root, or anywhere - the path is what matters):
//   node packages/mobile/scripts/ao-phone-proxy.js         # first device pairs
//   RESET=1 node packages/mobile/scripts/ao-phone-proxy.js # forget + re-pair
//   PORT=3011 TARGET=3001 node packages/mobile/scripts/ao-phone-proxy.js
//
// Env:
//   PORT    LAN port to expose      (default 3011)
//   TARGET  loopback daemon port    (default 3001)
//   STATE   pairing file path       (default ~/.ao/phone-allow.json)
//   RESET   "1" clears the pairing before starting
//
// Self-check: node packages/mobile/scripts/ao-phone-proxy.test.js

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3011", 10);
const TARGET = parseInt(process.env.TARGET || "3001", 10);
const STATE = process.env.STATE || path.join(os.homedir(), ".ao", "phone-allow.json");

// The daemon's isLoopbackOrigin accepts this, so rewritten requests pass.
const LOOPBACK_ORIGIN = "http://localhost";

// Hop-by-hop headers describe a single connection and must not be forwarded;
// Node re-frames bodies itself (a copied Transfer-Encoding or Connection
// would corrupt the relayed message). Everything else streams through.
const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

function stripHopByHop(headers) {
	for (const name of HOP_BY_HOP) delete headers[name];
	return headers;
}

// Normalize IPv4-mapped IPv6 (e.g. "::ffff:192.168.1.50") to plain IPv4.
const norm = (ip) => (ip || "").replace(/^::ffff:/, "");

if (process.env.RESET === "1") {
	try {
		fs.unlinkSync(STATE);
		console.log(`pairing reset (removed ${STATE})`);
	} catch {
		/* nothing to reset */
	}
}

let pinned = null;
try {
	pinned = JSON.parse(fs.readFileSync(STATE, "utf8")).ip || null;
} catch {
	/* not paired yet */
}

function pair(ip) {
	pinned = ip;
	try {
		fs.mkdirSync(path.dirname(STATE), { recursive: true });
		fs.writeFileSync(STATE, JSON.stringify({ ip, pairedAt: new Date().toISOString() }, null, 2));
	} catch (e) {
		console.log("warn: could not persist pairing:", e.message);
	}
	console.log(`[paired] ${ip} is now the only allowed device (RESET=1 to re-pair)`);
}

// Trust-on-first-connect, shared by the request and upgrade paths.
function allowed(ip) {
	if (!pinned) {
		pair(ip); // first device wins
		return true;
	}
	if (ip === pinned) return true;
	console.log(`[BLOCK]  ${ip} (paired device is ${pinned})`);
	return false;
}

// REST: stream the request upstream with a loopback Origin, stream the
// response back with ACAO rewritten to the browser's real origin.
const server = http.createServer((req, res) => {
	if (!allowed(norm(req.socket.remoteAddress))) {
		req.socket.destroy();
		return;
	}

	const realOrigin = req.headers.origin;

	// Answer CORS preflights here: the daemon would echo the REWRITTEN origin,
	// which the browser rejects, and upstream needs nothing from a preflight.
	if (req.method === "OPTIONS" && realOrigin && req.headers["access-control-request-method"]) {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": realOrigin,
			"Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
			"Access-Control-Max-Age": "600",
			Vary: "Origin",
		});
		res.end();
		return;
	}

	const headers = stripHopByHop({ ...req.headers });
	headers.host = `127.0.0.1:${TARGET}`;
	if (realOrigin) headers.origin = LOOPBACK_ORIGIN;

	const upstream = http.request(
		{ host: "127.0.0.1", port: TARGET, method: req.method, path: req.url, headers },
		(upRes) => {
			const outHeaders = stripHopByHop({ ...upRes.headers });
			if (realOrigin) {
				// The daemon echoed ACAO = the rewritten (loopback) origin; the
				// browser requires ACAO to equal the page's REAL origin.
				outHeaders["access-control-allow-origin"] = realOrigin;
				outHeaders.vary = "Origin";
			}
			res.writeHead(upRes.statusCode, outHeaders);
			upRes.pipe(res);
		},
	);
	upstream.on("error", (e) => {
		console.log(`[502] ${req.method} ${req.url}: ${e.message}`);
		if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
		res.end("upstream error");
	});
	req.pipe(upstream);
});

// WebSocket (/mux): replay the upgrade handshake with the Origin rewritten,
// then pipe raw bytes both ways. rawHeaders preserves the exact handshake
// (Connection/Upgrade/Sec-WebSocket-*); only Origin is swapped.
server.on("upgrade", (req, socket, head) => {
	if (!allowed(norm(socket.remoteAddress))) {
		socket.destroy();
		return;
	}
	const upstream = net.connect(TARGET, "127.0.0.1", () => {
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const name = req.rawHeaders[i];
			const value = name.toLowerCase() === "origin" ? LOOPBACK_ORIGIN : req.rawHeaders[i + 1];
			lines.push(`${name}: ${value}`);
		}
		upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head && head.length) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	socket.on("error", () => upstream.destroy());
	upstream.on("error", () => socket.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(
		`AO phone bridge: 0.0.0.0:${PORT} -> 127.0.0.1:${TARGET}  | ` +
			(pinned ? `paired to ${pinned}` : "waiting for first device (trust-on-first-connect)"),
	);
});
