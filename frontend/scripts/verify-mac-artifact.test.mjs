import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Smoke coverage for scripts/verify-mac-artifact.sh.
//
// Honest scope: the three real checks (codesign, spctl, stapler) cannot be
// exercised here. Mocking them convincingly would require real Apple signing
// material, and a mock that always passes proves nothing about the gate. The
// meaningful verification of the core logic is the release pipeline's
// post-staple gate running this script against real published artifacts
// (#3288 workstream 1).
//
// What IS covered here, on any platform with no signing material at all:
// the script parses, and every usage/precondition path exits 2 with a clear
// message before touching macOS-only tooling. That is the half that a
// non-macOS CI runner can honestly assert.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verify-mac-artifact.sh");

function run(args) {
	return new Promise((resolve) => {
		execFile("bash", [SCRIPT, ...args], (err, stdout, stderr) => {
			resolve({ code: err?.code ?? 0, stdout, stderr });
		});
	});
}

let dir;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "verify-mac-artifact-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("verify-mac-artifact.sh", () => {
	it("is committed executable so CI and humans invoke it the same way", () => {
		expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
	});

	it("parses under bash", async () => {
		const { code } = await new Promise((resolve) => {
			execFile("bash", ["-n", SCRIPT], (err) => resolve({ code: err?.code ?? 0 }));
		});
		expect(code).toBe(0);
	});

	it("exits 2 with usage when given no arguments", async () => {
		const { code, stderr } = await run([]);
		expect(code).toBe(2);
		expect(stderr).toContain("usage: verify-mac-artifact.sh");
	});

	it("exits 2 when given more than one argument", async () => {
		const { code } = await run(["a.zip", "b.zip"]);
		expect(code).toBe(2);
	});

	it("exits 2 for a nonexistent file", async () => {
		const missing = join(dir, "not-here.zip");
		const { code, stderr } = await run([missing]);
		expect(code).toBe(2);
		expect(stderr).toContain("no such file");
	});

	it("exits 2 for a non-zip, non-app input", async () => {
		const txt = join(dir, "notes.txt");
		writeFileSync(txt, "not an artifact\n");
		const { code, stderr } = await run([txt]);
		expect(code).toBe(2);
		expect(stderr).toContain("unsupported artifact type");
	});

	it("exits 2 when a .zip path is actually a directory", async () => {
		const fake = join(dir, "bundle.zip");
		mkdirSync(fake, { recursive: true });
		const { code, stderr } = await run([fake]);
		expect(code).toBe(2);
		expect(stderr).toContain("expected a .zip file");
	});

	it("exits 2 when a .app path is not a directory", async () => {
		const fake = join(dir, "Fake.app");
		writeFileSync(fake, "");
		const { code, stderr } = await run([fake]);
		expect(code).toBe(2);
		expect(stderr).toContain("expected an .app bundle directory");
	});

	// A .dmg is a first-class input now: forge.config.ts's postMake seals the dmg
	// and then gates on this script (#3267 decision 3 step 4). Same usage
	// contract, so the same paths have to exit 2 rather than fall through to
	// macOS-only tooling.
	it("accepts .dmg as a known artifact type", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(SCRIPT, "utf8");
		expect(src).toContain("*.dmg)");
		const { stderr } = await run([]);
		expect(stderr).toContain(".dmg");
	});

	it("exits 2 when a .dmg path is actually a directory", async () => {
		const fake = join(dir, "bundle.dmg");
		mkdirSync(fake, { recursive: true });
		const { code, stderr } = await run([fake]);
		expect(code).toBe(2);
		expect(stderr).toContain("expected a .dmg file");
	});

	it("exits 2 for a nonexistent .dmg", async () => {
		const { code, stderr } = await run([join(dir, "not-here.dmg")]);
		expect(code).toBe(2);
		expect(stderr).toContain("no such file");
	});

	it("encodes the verified command set (ditto, spctl -vv, stapler validate)", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(SCRIPT, "utf8");
		// These exact forms are load-bearing and were each verified empirically;
		// see the header comment. A drive-by "simplification" of any of them
		// silently turns the gate into a no-op, so pin them here.
		expect(src).toContain("ditto -x -k");
		expect(src).not.toMatch(/^\s*unzip /m);
		expect(src).toContain("codesign --verify --deep --strict");
		expect(src).toContain("xcrun stapler validate");
		// The .zip/.app path must keep assessing executable code...
		expect(src).toContain("spctl -a -vv -t exec");
		// ...and the dmg container must be assessed on open against the primary
		// signature (#3267 decision 3 step 4), never with -t exec.
		expect(src).toContain("spctl -a -vv -t open --context context:primary-signature");
	});
});
