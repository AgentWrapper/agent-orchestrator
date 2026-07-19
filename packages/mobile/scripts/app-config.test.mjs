import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appConfig = JSON.parse(
	await readFile(new URL("../app.json", import.meta.url), "utf8"),
);

test("iOS explains why AO needs local network access", () => {
	assert.equal(
		typeof appConfig.expo?.ios?.infoPlist?.NSLocalNetworkUsageDescription,
		"string",
	);
	assert.ok(
		appConfig.expo.ios.infoPlist.NSLocalNetworkUsageDescription.trim().length > 0,
	);
});
