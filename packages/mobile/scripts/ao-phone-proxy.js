#!/usr/bin/env node
// Minimal LAN bridge for the AO mobile app - trust-on-first-connect.
//
// The AO daemon stays bound to localhost (127.0.0.1:3001) - fully local and
// unexposed. This script opens ONE LAN port and forwards it to the daemon.
// The FIRST device that connects is pinned as the only allowed device; every
// other IP is refused. No discovery, no manual allowlist. (Like SSH's TOFU.)
//
// The pairing is saved, so it survives restarts. To pair a different phone,
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

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3011", 10);
const TARGET = parseInt(process.env.TARGET || "3001", 10);
const STATE = process.env.STATE || path.join(os.homedir(), ".ao", "phone-allow.json");

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

const server = net.createServer((client) => {
	const ip = norm(client.remoteAddress);

	if (!pinned) {
		pair(ip); // first device wins
	} else if (ip !== pinned) {
		console.log(`[BLOCK]  ${ip} (paired device is ${pinned})`);
		client.destroy();
		return;
	}

	const upstream = net.connect(TARGET, "127.0.0.1");
	client.pipe(upstream);
	upstream.pipe(client);
	client.on("error", () => upstream.destroy());
	upstream.on("error", () => client.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(
		`AO phone bridge: 0.0.0.0:${PORT} -> 127.0.0.1:${TARGET}  | ` +
			(pinned ? `paired to ${pinned}` : "waiting for first device (trust-on-first-connect)"),
	);
});
