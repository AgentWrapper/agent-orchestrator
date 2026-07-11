import assert from "node:assert/strict";
import test from "node:test";
import { parsePairingPayload } from "./pairing.ts";

test("parsePairingPayload ignores password fields from QR payloads", () => {
	const parsed = parsePairingPayload(JSON.stringify({ v: 1, host: "100.64.1.2", port: 3011, password: "secret" }));
	assert.deepEqual(parsed, { host: "100.64.1.2", port: "3011" });
});

test("parsePairingPayload rejects non-pairing payloads", () => {
	assert.equal(parsePairingPayload("not json"), null);
	assert.equal(parsePairingPayload(JSON.stringify({ v: 2, host: "100.64.1.2", port: 3011 })), null);
	assert.equal(parsePairingPayload(JSON.stringify({ v: 1, host: "", port: 3011 })), null);
});
