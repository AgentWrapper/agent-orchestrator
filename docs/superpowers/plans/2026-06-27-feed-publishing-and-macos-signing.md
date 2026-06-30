# Feed publishing + macOS signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged auto-update runtime (#2221) functional by publishing electron-updater feeds (`latest*.yml`/`nightly*.yml` + `.blockmap` sidecars) on all three platforms and code-signing + notarizing the macOS build in CI.

**Architecture:** A post-matrix feed job per workflow hashes the already-uploaded versioned installers, writes gzip sidecar blockmaps + the channel yml (no `blockMapSize`, forcing the sidecar differential path), and uploads them. Blockmaps come from app-builder-lib's pure-JS `buildBlockMap`, isolated behind one wrapper module. macOS signing reproduces the proven local runbook in CI via a reusable composite action (keychain provisioning + App Store Connect API-key notarization).

**Tech Stack:** Node ESM scripts (mirroring `frontend/scripts/nightly-version.mjs`), vitest, electron-forge, `app-builder-lib@26.15.3` (transitive), GitHub Actions, `apple-actions/import-codesign-certs`.

## Global Constraints

- **Git author email:** `dev@theharshitsingh.com`. Each commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Use `git -c user.email=dev@theharshitsingh.com commit`.
- **No em dashes** anywhere (prose, code, comments, commit messages).
- **No `git add -A`** — add explicit paths only. Keep `status.md` / `handoff.md` untracked.
- **No backticks in `git commit -m`** — the messages in this plan contain none; keep it that way.
- **yml never emits `blockMapSize`** — its absence forces electron-updater onto the sidecar differential path on all platforms (verified contract).
- **Feed references versioned asset names** — electron-updater derives the old-version blockmap URL by string-substituting the version, so only versioned installers (not the `ao start` aliases) belong in the feed.
- **macOS zip arch discriminator is the literal substring `arm64` in the url** — the arm64 entry must contain `arm64`; the x64 entry must not. The arm64 entry is listed first.
- **Exclude `.deb` / `.rpm`** from feeds (system-package-managed, not electron-updater).
- **Channel names:** `latest` (stable workflow) and `nightly` (nightly workflow) -> `latest*.yml` / `nightly*.yml`.
- **Node stays at 20** on all runners (below the Node-26 `npm run make` crash ceiling per the runbook). Do not bump.
- **macOS signing creds (repo secrets):** `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY_BASE64` (base64 `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- **Windows code signing is out of scope.**
- **Spec deviations (intentional, evidence-based):** (a) no custom `entitlements.mac.plist` — the runbook proves default `@electron/osx-sign` entitlements notarize the app + daemon successfully; add one only if CI notarization rejects on an entitlement. (b) no Node bump — CI is already on a safe version.

---

### Task 1: Blockmap wrapper module

Isolate the single fragile dependency: app-builder-lib's internal pure-JS blockmap generator. Everything that could break on an app-builder-lib upgrade lives in this one file, and it is smoke-tested first so the risk surfaces immediately.

**Files:**

- Create: `frontend/scripts/blockmap.mjs`
- Test: `frontend/scripts/blockmap.test.mjs`

**Interfaces:**

- Produces: `writeBlockmap(filePath: string): Promise<{ sha512: string, size: number }>` — writes `<filePath>.blockmap` (gzip sidecar) and returns the file's base64 SHA-512 and raw byte size.

- [ ] **Step 1: Write the failing test**

```js
// frontend/scripts/blockmap.test.mjs
import { describe, it, expect } from "vitest";
import { writeBlockmap } from "./blockmap.mjs";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

describe("writeBlockmap", () => {
	it("writes a gzip sidecar and returns the file's base64 sha512 + size", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bm-"));
		const file = join(dir, "artifact.bin");
		// ~200KB of varied bytes so the chunker produces multiple chunks.
		const buf = Buffer.alloc(200_000);
		for (let i = 0; i < buf.length; i++) buf[i] = (i * 37) % 256;
		writeFileSync(file, buf);

		const { sha512, size } = await writeBlockmap(file);

		expect(size).toBe(buf.length);
		// Must match electron-updater's expectation: base64 SHA-512 of the raw file.
		expect(sha512).toBe(createHash("sha512").update(buf).digest("base64"));
		// Sidecar exists, is non-empty, and is gzip (magic bytes 1f 8b).
		expect(existsSync(`${file}.blockmap`)).toBe(true);
		const sidecar = readFileSync(`${file}.blockmap`);
		expect(sidecar.length).toBeGreaterThan(0);
		expect(sidecar[0]).toBe(0x1f);
		expect(sidecar[1]).toBe(0x8b);
		expect(statSync(`${file}.blockmap`).size).toBe(sidecar.length);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run scripts/blockmap.test.mjs`
Expected: FAIL — `Cannot find module './blockmap.mjs'` (or `writeBlockmap is not a function`).

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/scripts/blockmap.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// The ONE fragile import. app-builder-lib 26.x generates blockmaps in pure JS
// (there is no app-builder CLI / app-builder-bin in this tree). This internal
// path is pinned via package-lock; if it moves on a major upgrade, only this
// file changes. Smoke-tested by blockmap.test.mjs.
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");

// writeBlockmap creates "<filePath>.blockmap" (gzip sidecar) and returns the
// file's base64 sha512 + byte size, exactly as electron-updater reads them from
// the feed yml. We deliberately do NOT surface blockMapSize: omitting it from
// the yml forces the client onto the sidecar differential path on every
// platform (verified against MacUpdater / NsisUpdater / AppImage).
export async function writeBlockmap(filePath) {
	const { sha512, size } = await buildBlockMap(filePath, "gzip", `${filePath}.blockmap`);
	return { sha512, size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run scripts/blockmap.test.mjs`
Expected: PASS (1 test). If it fails on the import, the internal path changed — stop and report; the wrapper is the agreed isolation point.

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/blockmap.mjs frontend/scripts/blockmap.test.mjs
git -c user.email=dev@theharshitsingh.com commit -m "feat(feed): blockmap sidecar wrapper over app-builder-lib"
```

---

### Task 2: Feed module (installer selection + yml assembly)

The pure, tested heart of the feature. Given a directory of downloaded release assets, a version, and a channel, it picks the right installers, writes sidecar blockmaps, and emits the channel yml files.

**Files:**

- Create: `frontend/scripts/feed.mjs`
- Test: `frontend/scripts/feed.test.mjs`

**Interfaces:**

- Consumes: `writeBlockmap` from Task 1.
- Produces:
  - `selectInstallers(filenames: string[], version: string): { win: string[], linux: string[], macArm64: string[], macX64: string[] }`
  - `feedFilename(channel: string, platform: "win"|"linux"|"mac"): string`
  - `buildYml(version: string, files: {url,sha512,size}[], releaseDate: string): string`
  - CLI: `node scripts/feed.mjs <dir> <version> <channel>` writes `<dir>/<channel>*.yml` + `<dir>/<asset>.blockmap`.

- [ ] **Step 1: Write the failing test**

```js
// frontend/scripts/feed.test.mjs
import { describe, it, expect } from "vitest";
import { selectInstallers, feedFilename, buildYml } from "./feed.mjs";

const V = "0.10.4";
const NAMES = [
	"Agent.Orchestrator.Setup.0.10.4.exe", // win versioned
	"Agent.Orchestrator-0.10.4.AppImage", // linux versioned
	"Agent.Orchestrator-darwin-arm64-0.10.4.zip", // mac arm64 versioned
	"Agent.Orchestrator-darwin-x64-0.10.4.zip", // mac x64 versioned
	"agent-orchestrator-darwin-arm64.zip", // ao-start alias (no version) -> excluded
	"agent-orchestrator-win32-x64.exe", // alias (no version) -> excluded
	"agent-orchestrator_0.10.4_amd64.deb", // deb -> excluded by extension
	"agent-orchestrator-0.10.4.x86_64.rpm", // rpm -> excluded by extension
];

describe("selectInstallers", () => {
	it("keeps only versioned exe/AppImage/darwin-zip, split by arch", () => {
		const s = selectInstallers(NAMES, V);
		expect(s.win).toEqual(["Agent.Orchestrator.Setup.0.10.4.exe"]);
		expect(s.linux).toEqual(["Agent.Orchestrator-0.10.4.AppImage"]);
		expect(s.macArm64).toEqual(["Agent.Orchestrator-darwin-arm64-0.10.4.zip"]);
		expect(s.macX64).toEqual(["Agent.Orchestrator-darwin-x64-0.10.4.zip"]);
	});
});

describe("feedFilename", () => {
	it("maps channel + platform to electron-updater names", () => {
		expect(feedFilename("latest", "win")).toBe("latest.yml");
		expect(feedFilename("latest", "mac")).toBe("latest-mac.yml");
		expect(feedFilename("latest", "linux")).toBe("latest-linux.yml");
		expect(feedFilename("nightly", "win")).toBe("nightly.yml");
		expect(feedFilename("nightly", "mac")).toBe("nightly-mac.yml");
		expect(feedFilename("nightly", "linux")).toBe("nightly-linux.yml");
	});
});

describe("buildYml", () => {
	it("serializes one file with deprecated top-level fields and no blockMapSize", () => {
		const yml = buildYml(
			"0.10.4",
			[{ url: "Agent.Orchestrator.Setup.0.10.4.exe", sha512: "AA/BB+cc==", size: 123 }],
			"2026-06-27T12:00:00.000Z",
		);
		expect(yml).toBe(
			"version: 0.10.4\n" +
				"files:\n" +
				"  - url: Agent.Orchestrator.Setup.0.10.4.exe\n" +
				"    sha512: AA/BB+cc==\n" +
				"    size: 123\n" +
				"path: Agent.Orchestrator.Setup.0.10.4.exe\n" +
				"sha512: AA/BB+cc==\n" +
				"releaseDate: '2026-06-27T12:00:00.000Z'\n",
		);
		expect(yml).not.toContain("blockMapSize");
	});

	it("lists both mac arches with arm64 first and points top-level at arm64", () => {
		const yml = buildYml(
			"0.10.4",
			[
				{ url: "Agent.Orchestrator-darwin-arm64-0.10.4.zip", sha512: "ARM==", size: 10 },
				{ url: "Agent.Orchestrator-darwin-x64-0.10.4.zip", sha512: "X64==", size: 20 },
			],
			"2026-06-27T12:00:00.000Z",
		);
		const lines = yml.split("\n");
		expect(lines[2]).toBe("  - url: Agent.Orchestrator-darwin-arm64-0.10.4.zip");
		expect(lines[5]).toBe("  - url: Agent.Orchestrator-darwin-x64-0.10.4.zip");
		expect(yml).toContain("path: Agent.Orchestrator-darwin-arm64-0.10.4.zip");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run scripts/feed.test.mjs`
Expected: FAIL — `Cannot find module './feed.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/scripts/feed.mjs
// Generates electron-updater feed metadata (latest*.yml / nightly*.yml) plus
// gzip sidecar blockmaps for a release's versioned installers. Dependency-free
// ESM (mirrors nightly-version.mjs) so CI runs `node scripts/feed.mjs` directly
// and vitest unit-tests the pure functions. The only non-stdlib reach is the
// blockmap wrapper (Task 1).
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeBlockmap } from "./blockmap.mjs";

// selectInstallers picks the versioned, auto-updatable installers from a release
// download dir, grouped by platform/arch. Excludes the ao-start aliases (no
// version string in their names) and deb/rpm (system-package-managed). The mac
// arch split keys on the literal "arm64" substring, the same discriminator the
// updater (MacUpdater.filterFilesForArch) uses.
export function selectInstallers(filenames, version) {
	const versioned = filenames.filter((f) => f.includes(version));
	const isDarwinZip = (f) => f.endsWith(".zip") && f.includes("darwin");
	return {
		win: versioned.filter((f) => f.endsWith(".exe")),
		linux: versioned.filter((f) => f.endsWith(".AppImage")),
		macArm64: versioned.filter((f) => isDarwinZip(f) && f.includes("arm64")),
		macX64: versioned.filter((f) => isDarwinZip(f) && !f.includes("arm64")),
	};
}

// feedFilename maps (channel, platform) to electron-updater's expected feed name.
// The updater adds its own OS/arch suffix client-side; we name the published
// asset to match: "" (win), "-mac", "-linux" (x64 Linux).
export function feedFilename(channel, platform) {
	const suffix = platform === "mac" ? "-mac" : platform === "linux" ? "-linux" : "";
	return `${channel}${suffix}.yml`;
}

// buildYml serializes one platform's feed. files is [{ url, sha512, size }];
// for mac the arm64 entry comes first. The deprecated top-level path/sha512
// point at files[0]. blockMapSize is never written (forces sidecar differential).
export function buildYml(version, files, releaseDate) {
	const lines = [`version: ${version}`, "files:"];
	for (const f of files) {
		lines.push(`  - url: ${f.url}`);
		lines.push(`    sha512: ${f.sha512}`);
		lines.push(`    size: ${f.size}`);
	}
	lines.push(`path: ${files[0].url}`);
	lines.push(`sha512: ${files[0].sha512}`);
	lines.push(`releaseDate: '${releaseDate}'`);
	return lines.join("\n") + "\n";
}

// generateFeeds writes the yml + sidecar blockmaps for every platform present in
// dir. version may carry +build metadata (nightly); strip it for the yml.
async function generateFeeds(dir, rawVersion, channel, releaseDate) {
	const version = rawVersion.split("+")[0];
	const sel = selectInstallers(readdirSync(dir), version);
	const groups = [
		{ platform: "win", names: sel.win },
		{ platform: "linux", names: sel.linux },
		{ platform: "mac", names: [...sel.macArm64, ...sel.macX64] }, // arm64 first
	];
	for (const { platform, names } of groups) {
		if (names.length === 0) continue;
		const files = [];
		for (const name of names) {
			const { sha512, size } = await writeBlockmap(join(dir, name));
			files.push({ url: name, sha512, size });
		}
		writeFileSync(join(dir, feedFilename(channel, platform)), buildYml(version, files, releaseDate));
	}
}

// CLI: node scripts/feed.mjs <dir> <version> <channel>
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , dir, version, channel] = process.argv;
	if (!dir || !version || !channel) {
		process.stderr.write("usage: node feed.mjs <dir> <version> <channel>\n");
		process.exit(2);
	}
	generateFeeds(dir, version, channel, new Date().toISOString()).catch((err) => {
		process.stderr.write(`${err.stack || err}\n`);
		process.exit(1);
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run scripts/feed.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full scripts test set to confirm no regression**

Run: `cd frontend && npx vitest run scripts/`
Expected: PASS — `blockmap.test.mjs`, `feed.test.mjs`, `nightly-version.test.mjs` all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/scripts/feed.mjs frontend/scripts/feed.test.mjs
git -c user.email=dev@theharshitsingh.com commit -m "feat(feed): installer selection + electron-updater yml assembly"
```

---

### Task 3: Rewire macOS notarization to the App Store Connect API key

Switch `osxNotarize` to the `.p8` API-key variant (matching the proven local creds) and delete the `as unknown as ...` double cast that was the one known typecheck error. `osxSign` is unchanged — the runbook proves `{ identity }` + default entitlements notarize the app and the bundled daemon.

**Files:**

- Modify: `frontend/forge.config.ts:46-57`

**Interfaces:**

- Produces: a `forge.config.ts` whose `osxNotarize` reads `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` in CI (and keeps `AO_NOTARY_PROFILE` for the local runbook), consumed by the workflows in Tasks 5-6.

- [ ] **Step 1: Confirm the current typecheck error exists**

Run: `cd frontend && npm run typecheck`
Expected: exactly one error, at `forge.config.ts` around line 50, on the `as unknown as ForgeConfig["packagerConfig"]["osxNotarize"]` cast. (This is the documented pre-existing error.)

- [ ] **Step 2: Replace the `osxNotarize` block**

Replace `frontend/forge.config.ts:46-57` (the current `osxNotarize: process.env.AO_NOTARY_PROFILE ? ({ tool: "notarytool", ... } as unknown as ...) : process.env.APPLE_ID ? { appleId, ... } : undefined,`) with:

```ts
		// Notarization. Two paths:
		//  - CI: an App Store Connect API key. APPLE_API_KEY is a PATH to the .p8
		//    (the workflow decodes APPLE_API_KEY_BASE64 to a temp file), plus the
		//    key id + issuer uuid. Matches the proven local runbook creds.
		//  - Local: AO_NOTARY_PROFILE, a notarytool keychain profile created with
		//    `notarytool store-credentials`. See ao-macos-signed-release runbook.
		// Both are valid NotaryToolCredentials, so no cast is needed.
		osxNotarize: process.env.AO_NOTARY_PROFILE
			? { keychainProfile: process.env.AO_NOTARY_PROFILE }
			: process.env.APPLE_API_KEY
				? {
						appleApiKey: process.env.APPLE_API_KEY,
						appleApiKeyId: process.env.APPLE_API_KEY_ID!,
						appleApiIssuer: process.env.APPLE_API_ISSUER!,
					}
				: undefined,
```

Also update the signing comment block above `osxSign` (`forge.config.ts:34-40`) so the CI line reads: `CI: set CSC_LINK/CSC_KEY_PASSWORD + APPLE_SIGNING_IDENTITY for signing, and APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER for notarization.` Leave the `osxSign` expression itself unchanged.

- [ ] **Step 3: Run typecheck to verify the error is gone**

Run: `cd frontend && npm run typecheck`
Expected: PASS — zero errors (the cast is gone and both notarize branches are correctly typed).

- [ ] **Step 4: Commit**

```bash
git add frontend/forge.config.ts
git -c user.email=dev@theharshitsingh.com commit -m "feat(sign): notarize via App Store Connect API key; drop osxNotarize cast"
```

---

### Task 4: macOS signing-setup composite action

One reusable action provisions everything signing/notarization needs on the macOS runners: imports the Developer ID cert into a keychain (forge does not decode `CSC_LINK` itself), decodes the `.p8`, and exports the notarization env. Used by both workflows so they cannot drift.

**Files:**

- Create: `.github/actions/macos-signing-setup/action.yml`

**Interfaces:**

- Consumes (inputs): `csc-link`, `csc-key-password`, `apple-api-key-base64`, `apple-api-key-id`, `apple-api-issuer`, `apple-signing-identity`.
- Produces (via `$GITHUB_ENV`, for the later Publish step in the same job): `APPLE_API_KEY` (path to the decoded `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_SIGNING_IDENTITY`.

- [ ] **Step 1: Create the composite action**

```yaml
# .github/actions/macos-signing-setup/action.yml
name: macOS signing setup
description: >
  Import the Developer ID certificate into a keychain and stage App Store Connect
  API-key notarization credentials for a subsequent electron-forge publish.
inputs:
  csc-link:
    description: Base64 of the Developer ID Application .p12
    required: true
  csc-key-password:
    description: Password for the .p12
    required: true
  apple-api-key-base64:
    description: Base64 of the App Store Connect API key (.p8)
    required: true
  apple-api-key-id:
    description: App Store Connect API key id
    required: true
  apple-api-issuer:
    description: App Store Connect issuer uuid
    required: true
  apple-signing-identity:
    description: "Developer ID Application: <Holder> (<TEAMID>)"
    required: true
runs:
  using: composite
  steps:
    # Imports the .p12 into a temporary keychain so @electron/osx-sign can find
    # the identity (forge, unlike electron-builder, does not decode CSC_LINK).
    - uses: apple-actions/import-codesign-certs@v3
      with:
        p12-file-base64: ${{ inputs.csc-link }}
        p12-password: ${{ inputs.csc-key-password }}
    # Decode the .p8 to a file and export notarization env for the Publish step.
    # @electron/notarize's appleApiKey is a FILE PATH, so we must materialize it.
    # Inputs are passed via env (never interpolated into the script body) so a
    # value's special characters cannot break or inject into the shell. Decoding
    # is done with node (portable; avoids BSD-vs-GNU base64 flag differences on
    # the macOS runner).
    - shell: bash
      env:
        APPLE_API_KEY_BASE64: ${{ inputs.apple-api-key-base64 }}
        APPLE_API_KEY_ID: ${{ inputs.apple-api-key-id }}
        APPLE_API_ISSUER: ${{ inputs.apple-api-issuer }}
        APPLE_SIGNING_IDENTITY: ${{ inputs.apple-signing-identity }}
      run: |
        key_path="$RUNNER_TEMP/AuthKey.p8"
        node -e "require('fs').writeFileSync('$key_path', Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64'))"
        {
          echo "APPLE_API_KEY=$key_path"
          echo "APPLE_API_KEY_ID=$APPLE_API_KEY_ID"
          echo "APPLE_API_ISSUER=$APPLE_API_ISSUER"
          echo "APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY"
        } >> "$GITHUB_ENV"
```

- [ ] **Step 2: Validate the action YAML parses**

Run (from the repo root): `cd frontend && node -e "const y=require('js-yaml'); y.load(require('fs').readFileSync('../.github/actions/macos-signing-setup/action.yml','utf8')); console.log('ok')"`
Expected: prints `ok`. (`js-yaml` resolves from `frontend/node_modules` — it is a transitive dep of app-builder-lib, present after `npm ci`.)

- [ ] **Step 3: Commit**

```bash
git add .github/actions/macos-signing-setup/action.yml
git -c user.email=dev@theharshitsingh.com commit -m "feat(ci): macOS signing-setup composite action"
```

---

### Task 5: Wire the stable release workflow (signing + feed job)

Add the signing-setup step on the macOS legs, swap the publish env to the API-key creds, and append a post-matrix `publish-feed` job that emits the `latest*` feed.

**Files:**

- Modify: `.github/workflows/frontend-release.yml` (the `release` job steps around `:62-77`; add a new `publish-feed` job at the end)

**Interfaces:**

- Consumes: `macos-signing-setup` (Task 4); `frontend/scripts/feed.mjs` (Task 2).
- Produces: `latest.yml` / `latest-mac.yml` / `latest-linux.yml` + `.blockmap` sidecars on the `v<version>` release.

- [ ] **Step 1: Add the signing-setup step on macOS, before Publish**

In `.github/workflows/frontend-release.yml`, between the `- run: npm ci` step and the `- name: Publish` step, insert:

```yaml
- name: macOS signing setup
  if: startsWith(matrix.os, 'macos')
  uses: ./.github/actions/macos-signing-setup
  with:
    csc-link: ${{ secrets.CSC_LINK }}
    csc-key-password: ${{ secrets.CSC_KEY_PASSWORD }}
    apple-api-key-base64: ${{ secrets.APPLE_API_KEY_BASE64 }}
    apple-api-key-id: ${{ secrets.APPLE_API_KEY_ID }}
    apple-api-issuer: ${{ secrets.APPLE_API_ISSUER }}
    apple-signing-identity: ${{ secrets.APPLE_SIGNING_IDENTITY }}
```

Note: `uses:` steps cannot set `working-directory`, which is fine — the composite action manages its own paths.

- [ ] **Step 2: Replace the Publish step's apple env**

In the `- name: Publish` step's `env:` block, replace the five lines `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` with a comment only — the signing-setup step already exported `APPLE_API_KEY*` and `APPLE_SIGNING_IDENTITY` via `$GITHUB_ENV`, and the cert is in the keychain. Resulting env block:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  AO_RELEASE_REPO: ${{ github.repository }}
  # macOS signing + notarization env (APPLE_SIGNING_IDENTITY, APPLE_API_KEY,
  # APPLE_API_KEY_ID, APPLE_API_ISSUER) is exported by the "macOS signing
  # setup" step above via $GITHUB_ENV; the Developer ID cert is in the
  # keychain. No-op on non-macOS runners.
```

- [ ] **Step 3: Append the `publish-feed` job**

At the end of `.github/workflows/frontend-release.yml`, add a new top-level job (sibling of `release`):

```yaml
# After every platform has built and uploaded its installers, generate the
# electron-updater feed (latest*.yml + .blockmap sidecars) from the versioned
# assets and upload them to the same release. Runs once, on Linux: it only
# hashes already-built artifacts, so it needs no per-OS runner.
publish-feed:
  needs: release
  runs-on: ubuntu-latest
  permissions:
    contents: write
  defaults:
    run:
      working-directory: frontend
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
        cache-dependency-path: frontend/package-lock.json
    # feed.mjs imports app-builder-lib's blockmap generator, so deps are needed.
    - run: npm ci
    - name: Generate and upload the latest feed
      shell: bash
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        # Forge publishes to v<package.json version> (not the git tag).
        tag="v$(node -p "require('./package.json').version")"
        mkdir -p dist
        gh release download "$tag" --dir dist --clobber
        node scripts/feed.mjs dist "${tag#v}" latest
        shopt -s nullglob
        assets=(dist/latest*.yml dist/*.blockmap)
        if [ ${#assets[@]} -eq 0 ]; then echo "no feed assets generated" >&2; exit 1; fi
        gh release upload "$tag" "${assets[@]}" --clobber
```

- [ ] **Step 4: Validate the workflow YAML parses**

Run: `cd frontend && node -e "const y=require('js-yaml'); y.load(require('fs').readFileSync('../.github/workflows/frontend-release.yml','utf8')); console.log('ok')"`
Expected: prints `ok`. If `actionlint` is installed, also run `actionlint .github/workflows/frontend-release.yml` from the repo root and expect no errors.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/frontend-release.yml
git -c user.email=dev@theharshitsingh.com commit -m "feat(ci): sign macOS + publish latest feed in the release workflow"
```

---

### Task 6: Wire the nightly workflow (signing + feed job)

Mirror Task 5 on the nightly workflow, with `channel=nightly` and the tag derived from the guard job's computed version (the nightly version is stamped in-memory on the build runners only, so the feed job cannot read it from `package.json`).

**Files:**

- Modify: `.github/workflows/frontend-nightly.yml` (the `release` job steps around `:70-89`; add a `publish-feed` job)

**Interfaces:**

- Consumes: `macos-signing-setup` (Task 4); `frontend/scripts/feed.mjs` (Task 2); `needs.guard.outputs.version` (existing).
- Produces: `nightly.yml` / `nightly-mac.yml` / `nightly-linux.yml` + `.blockmap` sidecars on the nightly prerelease.

- [ ] **Step 1: Add the signing-setup step on macOS, before Publish**

In `.github/workflows/frontend-nightly.yml`, between the `- name: Stamp nightly version` step and the `- name: Publish` step, insert the same block as Task 5 Step 1:

```yaml
- name: macOS signing setup
  if: startsWith(matrix.os, 'macos')
  uses: ./.github/actions/macos-signing-setup
  with:
    csc-link: ${{ secrets.CSC_LINK }}
    csc-key-password: ${{ secrets.CSC_KEY_PASSWORD }}
    apple-api-key-base64: ${{ secrets.APPLE_API_KEY_BASE64 }}
    apple-api-key-id: ${{ secrets.APPLE_API_KEY_ID }}
    apple-api-issuer: ${{ secrets.APPLE_API_ISSUER }}
    apple-signing-identity: ${{ secrets.APPLE_SIGNING_IDENTITY }}
```

- [ ] **Step 2: Replace the Publish step's apple env**

In the nightly `- name: Publish` step's `env:` block, replace the five `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` lines with the same comment-only note as Task 5 Step 2, keeping `GITHUB_TOKEN`, `AO_RELEASE_REPO`, and `AO_RELEASE_PRERELEASE: "true"`:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  AO_RELEASE_REPO: ${{ github.repository }}
  AO_RELEASE_PRERELEASE: "true"
  # macOS signing + notarization env is exported by the "macOS signing
  # setup" step above via $GITHUB_ENV; the cert is in the keychain.
```

- [ ] **Step 3: Append the `publish-feed` job**

At the end of `.github/workflows/frontend-nightly.yml`, add:

```yaml
# Generate the nightly electron-updater feed from the versioned prerelease
# assets. The nightly version is only stamped in-memory on the build runners,
# so derive the tag from the guard job's computed version, not package.json.
publish-feed:
  needs: [guard, release]
  runs-on: ubuntu-latest
  permissions:
    contents: write
  defaults:
    run:
      working-directory: frontend
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
        cache-dependency-path: frontend/package-lock.json
    - run: npm ci
    - name: Generate and upload the nightly feed
      shell: bash
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        NIGHTLY_VERSION: ${{ needs.guard.outputs.version }}
      run: |
        # Forge stamps package.json to VERSION without +build metadata and
        # publishes to v<that>. Match it.
        version="${NIGHTLY_VERSION%%+*}"
        tag="v$version"
        mkdir -p dist
        gh release download "$tag" --dir dist --clobber
        node scripts/feed.mjs dist "$version" nightly
        shopt -s nullglob
        assets=(dist/nightly*.yml dist/*.blockmap)
        if [ ${#assets[@]} -eq 0 ]; then echo "no feed assets generated" >&2; exit 1; fi
        gh release upload "$tag" "${assets[@]}" --clobber
```

- [ ] **Step 4: Validate the workflow YAML parses**

Run: `cd frontend && node -e "const y=require('js-yaml'); y.load(require('fs').readFileSync('../.github/workflows/frontend-nightly.yml','utf8')); console.log('ok')"`
Expected: prints `ok`. If `actionlint` is installed, run it on the file too.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/frontend-nightly.yml
git -c user.email=dev@theharshitsingh.com commit -m "feat(ci): sign macOS + publish nightly feed in the nightly workflow"
```

---

## Post-implementation verification (CI-only, after the PR is up)

These cannot be checked locally; record them on the PR and validate on the first real run (test on the fork first, per the spec's human-prerequisites section):

1. A fork `desktop-v*` run produces `latest.yml` / `latest-mac.yml` / `latest-linux.yml` + `.blockmap` sidecars on the `v<version>` release (HTTP 200 each).
2. `latest-mac.yml` lists two `files` entries, the `arm64` one first, and neither carries `blockMapSize`.
3. The macOS zips and the bundled daemon are signed + notarized: `spctl -a -t exec -vvv <app>` reports `source=Notarized Developer ID` (reuse the runbook's verify block).
4. An installed older build auto-updates: win/linux end to end; macOS once the signing secrets are present.
5. Risk to watch: forge `maker-zip`'s mac zip being a Squirrel.Mac-acceptable update payload (the runbook proves it is a launchable signed `.app`; the updater-payload path is the last unknown).
