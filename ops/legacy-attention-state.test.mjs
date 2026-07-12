import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadLegacyThreadMap } from "./legacy-attention-state.mjs";

const cleanup = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadLegacyThreadMap", () => {
	it("preserves thread bindings without reviving the retired notifier engine", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "ao-attention-state-"));
		cleanup.push(dir);
		const file = path.join(dir, "attention-state.json");
		await writeFile(
			file,
			JSON.stringify({
				threadMap: [["thread-1", { projectId: "ao", sessionId: "ao-7" }]],
				digest: { ts: "retired" },
				tracker: { open: ["retired"] },
			}),
		);

		assert.deepEqual(loadLegacyThreadMap(file).lookup("thread-1"), {
			projectId: "ao",
			sessionId: "ao-7",
		});
	});

	it("returns an empty map for missing or malformed state", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "ao-attention-state-"));
		cleanup.push(dir);
		const malformed = path.join(dir, "attention-state.json");
		await writeFile(malformed, "not json");

		assert.equal(loadLegacyThreadMap(malformed).lookup("thread-1"), null);
		assert.equal(loadLegacyThreadMap(path.join(dir, "missing.json")).lookup("thread-1"), null);
	});
});
