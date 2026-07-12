import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./main-module.mjs";

let cleanup = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((f) => f()));
});

async function tempScript() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-main-module-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const script = path.join(dir, "script.mjs");
	await writeFile(script, "console.log('main');\n");
	return { dir, script };
}

describe("isMainModule", () => {
	it("returns false without an argv path", () => {
		assert.equal(isMainModule("file:///tmp/script.mjs", ""), false);
	});

	it("matches a raw argv path", async () => {
		const { script } = await tempScript();
		assert.equal(isMainModule(pathToFileURL(script).href, script), true);
	});

	it("matches a symlink argv path by realpath", async () => {
		const { dir, script } = await tempScript();
		const current = path.join(dir, "current");
		await mkdir(current);
		const link = path.join(current, "script.mjs");
		await symlink(script, link);

		assert.equal(isMainModule(pathToFileURL(script).href, link), true);
	});

	it("matches a preserved main symlink argv path before realpathing", async () => {
		const { dir, script } = await tempScript();
		const link = path.join(dir, "preserved.mjs");
		await symlink(script, link);

		assert.equal(isMainModule(pathToFileURL(link).href, link), true);
	});

	it("returns false for a missing argv path that does not raw-match", async () => {
		const { dir, script } = await tempScript();
		assert.equal(isMainModule(pathToFileURL(script).href, path.join(dir, "missing.mjs")), false);
	});

	it("returns false for an unrelated path", async () => {
		const { dir, script } = await tempScript();
		const other = path.join(dir, "other.mjs");
		await writeFile(other, "console.log('other');\n");

		assert.equal(isMainModule(pathToFileURL(script).href, other), false);
	});
});
