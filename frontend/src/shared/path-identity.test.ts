import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathInside, samePath } from "./path-identity";

const tempDirs: string[] = [];

function tempDir() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "ao-path-identity-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("path identity", () => {
	it("matches paths that resolve to the same real directory", () => {
		const dir = tempDir();
		const real = realpathSync.native(dir);
		expect(samePath(path.join(real, "."), real)).toBe(true);
	});

	it("treats Windows paths as case-insensitive", () => {
		expect(samePath("C:\\Users\\me\\AO\\backend", "c:\\users\\me\\ao\\backend", "win32")).toBe(true);
	});

	it("uses realpath canonical casing on macOS case-insensitive volumes", () => {
		if (process.platform !== "darwin") return;

		const current = realpathSync.native(process.cwd());
		const lowerCased = current.toLowerCase();
		try {
			if (realpathSync.native(lowerCased) !== current) return;
		} catch {
			return;
		}

		expect(samePath(lowerCased, current, "darwin")).toBe(true);
	});

	it("detects non-existent children after canonicalization", () => {
		const dir = tempDir();
		const child = path.join(dir, "nested", "future");

		expect(pathInside(child, dir)).toBe(true);
		expect(pathInside(dir, child)).toBe(false);
	});

	it("does not confuse sibling path prefixes with children", () => {
		const dir = tempDir();
		expect(pathInside(`${dir}-other`, dir)).toBe(false);
	});
});
