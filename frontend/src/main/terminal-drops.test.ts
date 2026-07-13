import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveDroppedFile } from "./terminal-drops";

const tmpDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-drops-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("saveDroppedFile", () => {
	it("writes the bytes and keeps only a sanitized basename so a drop cannot escape the dir", async () => {
		const dir = await tempDir();
		const bytes = new Uint8Array([1, 2, 3, 4]);

		const target = await saveDroppedFile(dir, { name: "../../etc/pa ss!.png", bytes }, 1700000000000);

		expect(path.dirname(target)).toBe(dir);
		expect(path.basename(target)).toMatch(/^1700000000000-[0-9a-f-]{36}-pa_ss_\.png$/);
		expect(new Uint8Array(await readFile(target))).toEqual(bytes);
	});

	it("falls back to a default name when the dropped name is empty or all-unsafe", async () => {
		const dir = await tempDir();
		const target = await saveDroppedFile(dir, { name: "///", bytes: new Uint8Array([0]) }, 1700000000000);
		expect(path.basename(target)).toMatch(/-dropped$/);
	});

	it("gives distinct targets to two files saved in the same millisecond with the same name", async () => {
		const dir = await tempDir();
		const a = await saveDroppedFile(dir, { name: "shot.png", bytes: new Uint8Array([1]) }, 1700000000000);
		const b = await saveDroppedFile(dir, { name: "shot.png", bytes: new Uint8Array([2]) }, 1700000000000);

		expect(a).not.toBe(b);
		expect(new Uint8Array(await readFile(a))).toEqual(new Uint8Array([1]));
		expect(new Uint8Array(await readFile(b))).toEqual(new Uint8Array([2]));
		expect((await readdir(dir)).length).toBe(2);
	});

	it("prunes copies older than the retention window but keeps still-fresh ones", async () => {
		const dir = await tempDir();
		const now = Date.parse("2026-01-02T00:00:00Z");
		const stale = path.join(dir, "stale.png");
		await writeFile(stale, "old");
		const twoDaysBefore = new Date(now - 2 * 24 * 60 * 60 * 1000);
		await utimes(stale, twoDaysBefore, twoDaysBefore);
		const recent = path.join(dir, "recent.png");
		await writeFile(recent, "keep");
		const oneHourBefore = new Date(now - 60 * 60 * 1000);
		await utimes(recent, oneHourBefore, oneHourBefore);

		await saveDroppedFile(dir, { name: "fresh.png", bytes: new Uint8Array([9]) }, now);

		const remaining = await readdir(dir);
		expect(remaining).not.toContain("stale.png");
		expect(remaining).toContain("recent.png");
		expect(remaining.some((name) => name.endsWith("-fresh.png"))).toBe(true);
	});

	it("rejects malformed input before touching the filesystem", async () => {
		const dir = await tempDir();

		await expect(
			saveDroppedFile(dir, { name: "shot.png", bytes: "text" as unknown as Uint8Array }, 1700000000000),
		).rejects.toThrow(/Uint8Array/);
		await expect(
			saveDroppedFile(dir, { name: 123 as unknown as string, bytes: new Uint8Array([1]) }, 1700000000000),
		).rejects.toThrow();
		await expect(
			saveDroppedFile(dir, undefined as unknown as { name: string; bytes: Uint8Array }, 1700000000000),
		).rejects.toThrow();

		expect(await readdir(dir)).toEqual([]);
	});

	it("rejects when the target directory cannot be created", async () => {
		const dir = await tempDir();
		const fileWhereDirExpected = path.join(dir, "not-a-dir");
		await writeFile(fileWhereDirExpected, "x");

		await expect(
			saveDroppedFile(fileWhereDirExpected, { name: "shot.png", bytes: new Uint8Array([1]) }, 1700000000000),
		).rejects.toThrow();
	});
});
