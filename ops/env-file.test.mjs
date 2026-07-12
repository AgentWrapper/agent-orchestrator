import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadEnvFile } from "./env-file.mjs";

const cleanup = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadEnvFile", () => {
	it("loads simple and quoted values without overwriting explicit environment values", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "ao-env-file-"));
		cleanup.push(dir);
		const file = path.join(dir, ".env");
		await writeFile(file, 'KEEP=file\nQUOTED="hello world"\nEMPTY=\n');
		const env = { KEEP: "explicit" };

		assert.equal(loadEnvFile(file, env), env);
		assert.deepEqual(env, { KEEP: "explicit", QUOTED: "hello world", EMPTY: "" });
	});

	it("treats a missing file as an empty overlay", () => {
		const env = { KEEP: "value" };
		assert.equal(loadEnvFile("/definitely/missing/ao.env", env), env);
		assert.deepEqual(env, { KEEP: "value" });
	});
});
