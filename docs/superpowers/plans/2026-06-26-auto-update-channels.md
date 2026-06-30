# Auto-update Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship channel-aware auto-update (stable + nightly) for the desktop app via electron-updater, plus a daily nightly release pipeline with an ordered, channel-tagged version scheme.

**Architecture:** electron-updater replaces update-electron-app in the Electron main process; its channel and auto-download are driven by three user settings persisted under `~/.ao`. Stable releases stay manual (`desktop-vX.Y.Z`); a daily GitHub Actions cron builds and publishes nightly prereleases versioned `X.Y.(Z+1)-nightly.<UTC-ts>+<short-sha>`. The release workflows also publish electron-updater feed metadata (`*.yml`) per platform.

**Tech Stack:** Electron, electron-updater, TypeScript, Node ESM, electron-forge, GitHub Actions, vitest.

## Global Constraints

- All app state, including the new update settings, resolves under `~/.ao` (honor `AO_DATA_DIR`/`AO_RUN_FILE`); never an OS-default app-data location.
- No em dashes anywhere (prose, code comments, commit messages, copy).
- Git author email `dev@theharshitsingh.com`; end commits with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; no backticks inside `git commit -m` (use `-F -` heredoc).
- `git add` explicit paths only; never `git add -A`.
- Version scheme is exact: stable `X.Y.Z`; nightly `X.Y.(Z+1)-nightly.<UTC-timestamp YYYYMMDDHHMM>+<short-sha>`.
- electron-updater channels: stable -> `latest`, nightly -> `nightly`. `allowDowngrade = true`.
- Skip auto-update entirely when `!app.isPackaged`.
- macOS auto-update requires a signed + notarized build (Track-B prereq); nightly macOS is download-only until signing lands. Do NOT claim macOS auto-update works in any copy.

---

## File Structure

- `frontend/scripts/nightly-version.mjs` (new): pure ESM, computes the nightly version string. Used by the nightly CI workflow and unit-tested.
- `frontend/scripts/nightly-version.test.mjs` (new): vitest tests for the version compute.
- `frontend/src/main/update-settings.ts` (new): read/write the three update settings under `~/.ao` (atomic, mirrors `app-state.ts`).
- `frontend/src/main/update-settings.test.ts` (new): vitest tests.
- `frontend/src/main/auto-updater.ts` (new): thin shell that configures electron-updater from settings. No business logic beyond Electron event glue.
- `frontend/src/main.ts` (modify): replace `update-electron-app` usage in `initAutoUpdates()` with the new shell.
- `frontend/package.json` (modify): remove `update-electron-app`, add `electron-updater`.
- `.github/workflows/frontend-nightly.yml` (new): daily cron that builds + publishes the nightly prerelease.
- `.github/workflows/frontend-release.yml` (modify): emit + upload electron-updater macOS feed metadata (`latest-mac.yml`) alongside the existing assets.

---

# Group A: Versioning + nightly pipeline

## Task 1: Nightly version compute module

**Files:**

- Create: `frontend/scripts/nightly-version.mjs`
- Test: `frontend/scripts/nightly-version.test.mjs`

**Interfaces:**

- Produces: `computeNightlyVersion(latestStableTag: string, now: Date, shortSha: string): string` returning `X.Y.(Z+1)-nightly.<YYYYMMDDHHMM>+<shortSha>`. Accepts `latestStableTag` either bare (`0.10.3`) or tag-prefixed (`v0.10.3` / `desktop-v0.10.3`).
- Produces (CLI): `node scripts/nightly-version.mjs <latestStableTag> <shortSha>` prints the version using the current UTC time, for the CI workflow.

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/scripts/nightly-version.test.mjs
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeNightlyVersion } from "./nightly-version.mjs";

const now = new Date("2026-06-27T03:00:00.000Z");

describe("computeNightlyVersion", () => {
	it("bumps the patch and formats a UTC-timestamped nightly prerelease with sha build metadata", () => {
		expect(computeNightlyVersion("0.10.3", now, "ab12cd3")).toBe("0.10.4-nightly.202606270300+ab12cd3");
	});

	it("strips a v / desktop-v tag prefix", () => {
		expect(computeNightlyVersion("v0.10.3", now, "ab12cd3")).toBe("0.10.4-nightly.202606270300+ab12cd3");
		expect(computeNightlyVersion("desktop-v0.10.3", now, "ab12cd3")).toBe("0.10.4-nightly.202606270300+ab12cd3");
	});

	it("orders monotonically by timestamp for the same base", () => {
		const earlier = computeNightlyVersion("0.10.3", new Date("2026-06-27T03:00:00Z"), "aaaaaaa");
		const later = computeNightlyVersion("0.10.3", new Date("2026-06-27T04:00:00Z"), "bbbbbbb");
		// prerelease identifiers compare lexically; zero-padded fixed-width timestamp sorts correctly
		expect(later > earlier).toBe(true);
	});

	it("rejects a non-semver base tag", () => {
		expect(() => computeNightlyVersion("not-a-version", now, "ab12cd3")).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run scripts/nightly-version.test.mjs`
Expected: FAIL, "Failed to resolve import ./nightly-version.mjs" / `computeNightlyVersion is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/scripts/nightly-version.mjs
// Pure version math shared by the nightly CI workflow. Kept dependency-free
// ESM so `node scripts/nightly-version.mjs` runs it directly in CI and vitest
// unit-tests it. The app does NOT compute versions; it only reads its injected
// app.getVersion(), so this lives in scripts/, not src/.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// computeNightlyVersion builds X.Y.(Z+1)-nightly.<YYYYMMDDHHMM>+<shortSha>.
// Next-patch base keeps a nightly ahead of the last stable and behind the next.
// The fixed-width UTC timestamp makes prerelease ids order by build time; the
// sha is semver build metadata (ignored for ordering, kept for traceability).
export function computeNightlyVersion(latestStableTag, now, shortSha) {
	const bare = String(latestStableTag).replace(/^(desktop-)?v/, "");
	const m = SEMVER.exec(bare);
	if (!m) {
		throw new Error(`nightly-version: base tag is not X.Y.Z: ${latestStableTag}`);
	}
	const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const ts =
		String(now.getUTCFullYear()) +
		String(now.getUTCMonth() + 1).padStart(2, "0") +
		String(now.getUTCDate()).padStart(2, "0") +
		String(now.getUTCHours()).padStart(2, "0") +
		String(now.getUTCMinutes()).padStart(2, "0");
	return `${major}.${minor}.${patch + 1}-nightly.${ts}+${shortSha}`;
}

// CLI entry for CI: node scripts/nightly-version.mjs <latestStableTag> <shortSha>
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , latestStableTag, shortSha] = process.argv;
	if (!latestStableTag || !shortSha) {
		process.stderr.write("usage: node nightly-version.mjs <latestStableTag> <shortSha>\n");
		process.exit(2);
	}
	process.stdout.write(computeNightlyVersion(latestStableTag, new Date(), shortSha));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run scripts/nightly-version.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Sanity-check the CLI entry**

Run: `cd frontend && node scripts/nightly-version.mjs v0.10.3 abc1234`
Expected: prints `0.10.4-nightly.<current-UTC-YYYYMMDDHHMM>+abc1234` (no trailing newline).

- [ ] **Step 6: Commit**

```bash
git add frontend/scripts/nightly-version.mjs frontend/scripts/nightly-version.test.mjs
git commit -F - <<'EOF'
feat(release): nightly version compute module

computeNightlyVersion -> X.Y.(Z+1)-nightly.<UTC-ts>+<sha>: next-patch base,
fixed-width UTC timestamp for monotonic prerelease ordering, sha as build
metadata. Pure ESM so CI runs it and vitest tests it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

## Task 2: Nightly daily cron workflow

**Files:**

- Create: `.github/workflows/frontend-nightly.yml`

**Interfaces:**

- Consumes: `frontend/scripts/nightly-version.mjs` CLI (Task 1).
- Produces: a daily prerelease GitHub release tagged `desktop-v<nightly-version-without-build-metadata>` carrying per-platform installers + electron-updater `nightly*.yml`, on the `nightly` channel.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/frontend-nightly.yml
name: Desktop nightly

# Daily nightly build on main. Computes X.Y.(Z+1)-nightly.<UTC-ts>+<sha> from
# the latest stable desktop tag, stamps it, builds all platforms, and publishes
# a prerelease so electron-updater's `nightly` channel can resolve it. Skips when
# there are no new commits since the last nightly.
on:
  schedule:
    - cron: "0 3 * * *" # 03:00 UTC daily
  workflow_dispatch:

jobs:
  guard:
    runs-on: ubuntu-latest
    outputs:
      should_build: ${{ steps.check.outputs.should_build }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # need tags + history for the no-new-commits check
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - id: check
        shell: bash
        run: |
          # Skip if HEAD is already covered by the most recent nightly tag.
          last_nightly="$(git tag --list 'desktop-v*-nightly.*' --sort=-creatordate | head -n1)"
          if [ -n "$last_nightly" ] && [ "$(git rev-list -n1 "$last_nightly")" = "$(git rev-parse HEAD)" ]; then
            echo "should_build=false" >> "$GITHUB_OUTPUT"
          else
            echo "should_build=true" >> "$GITHUB_OUTPUT"
          fi
      - id: version
        if: steps.check.outputs.should_build == 'true'
        shell: bash
        run: |
          latest_stable="$(git tag --list 'desktop-v[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname | grep -v nightly | head -n1)"
          latest_stable="${latest_stable:-desktop-v0.0.0}"
          short_sha="$(git rev-parse --short HEAD)"
          version="$(node frontend/scripts/nightly-version.mjs "$latest_stable" "$short_sha")"
          echo "version=$version" >> "$GITHUB_OUTPUT"

  release:
    needs: guard
    if: needs.guard.outputs.should_build == 'true'
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, macos-13, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
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
      - uses: actions/setup-go@v5
        with:
          go-version-file: backend/go.mod
          cache-dependency-path: backend/go.sum
      - run: npm ci
      - name: Stamp nightly version
        shell: bash
        run: |
          node -e "const v='${{ needs.guard.outputs.version }}'.split('+')[0]; const fs=require('fs'); const p=require('./package.json'); p.version=v; fs.writeFileSync('./package.json', JSON.stringify(p,null,'\t')+'\n');"
      - name: Publish
        run: npm run publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AO_RELEASE_REPO: ${{ github.repository }}
          # Mark this a prerelease so it lands on electron-updater's nightly channel
          # and never becomes the stable `latest` GitHub release.
          AO_RELEASE_PRERELEASE: "true"
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

- [ ] **Step 2: Wire the prerelease flag in forge.config.ts**

The publisher currently hardcodes `prerelease: false`. Make it env-driven so the nightly run publishes a prerelease while stable stays non-prerelease.

In `frontend/forge.config.ts`, change the publisher config:

```typescript
                config: {
                        repository: parseReleaseRepo(process.env.AO_RELEASE_REPO),
                        prerelease: process.env.AO_RELEASE_PRERELEASE === "true",
                        draft: false,
                },
```

- [ ] **Step 3: Validate the workflow + forge change parse**

Run: `cd frontend && npm run typecheck`
Expected: only the pre-existing `forge.config.ts` `osxNotarize` error; no new errors.

Run (if available): `actionlint .github/workflows/frontend-nightly.yml`; else `ruby -ryaml -e "YAML.load_file('.github/workflows/frontend-nightly.yml')"`
Expected: parses with no error.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/frontend-nightly.yml frontend/forge.config.ts
git commit -F - <<'EOF'
feat(release): daily nightly build + publish workflow

Cron computes the nightly version from the latest stable tag, stamps it,
builds all platforms, and publishes a prerelease (nightly channel). Skips
when HEAD is already covered by the latest nightly. forge publisher prerelease
flag is now env-driven (AO_RELEASE_PRERELEASE) so stable stays non-prerelease.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

## Task 3: macOS electron-updater feed metadata

**Files:**

- Modify: `.github/workflows/frontend-release.yml` (add a macOS feed-metadata step; the same step is needed in `frontend-nightly.yml`, add it there too)

**Interfaces:**

- Produces: `latest-mac.yml` (stable) / `nightly-mac.yml` (nightly) uploaded to the release, so electron-updater can resolve macOS updates. Windows/Linux already emit their `*.yml` via the electron-builder-backed makers.

- [ ] **Step 1: Add the macOS feed step**

electron-forge's `maker-zip` does not emit electron-updater metadata. Generate it from the built zip with electron-builder's helper. Add this step to the macOS branch of both release workflows, after the existing alias upload:

```yaml
- name: Generate + upload macOS update feed (electron-updater)
  if: startsWith(matrix.os, 'macos')
  shell: bash
  run: |
    tag="v$(node -p "require('./package.json').version")"
    # electron-builder ships `app-builder`-based metadata generation; emit
    # the channel yml from the zip. Channel is derived from the version's
    # prerelease tag: stable -> latest-mac.yml, nightly -> nightly-mac.yml.
    npx --yes electron-builder --pd "$(ls -d out/*-darwin-* | head -n1)" \
      --config.publish=null --mac zip 2>/dev/null || true
    ymls="$(ls dist/latest-mac.yml dist/nightly-mac.yml 2>/dev/null || true)"
    if [ -z "$ymls" ]; then echo "no macOS update feed yml generated" >&2; exit 1; fi
    for f in $ymls; do gh release upload "$tag" "$f" --clobber; done
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> Note: the exact electron-builder invocation to emit only the mac yml from a forge-built bundle must be confirmed on the first real CI run (it cannot run on a contributor laptop without the signed bundle). The step fails loudly if no yml is produced so the run surfaces it rather than silently shipping a feed-less macOS release.

- [ ] **Step 2: Validate YAML**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/frontend-release.yml')"`
Expected: parses with no error.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/frontend-release.yml .github/workflows/frontend-nightly.yml
git commit -F - <<'EOF'
feat(release): publish macOS electron-updater feed metadata

forge maker-zip does not emit latest-mac.yml/nightly-mac.yml, so generate and
upload it for the macOS runners. Win/linux already emit their feed yml via the
electron-builder-backed makers. Exact generation command to be confirmed on the
first signed CI run; the step fails loudly if no yml is produced.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

# Group B: In-app channel-aware updater

## Task 4: Update settings module

**Files:**

- Create: `frontend/src/main/update-settings.ts`
- Test: `frontend/src/main/update-settings.test.ts`

**Interfaces:**

- Produces:
  - `type UpdateChannel = "latest" | "nightly"`
  - `interface UpdateSettings { enabled: boolean; channel: UpdateChannel; nightlyAck: boolean }`
  - `readUpdateSettings(stateDir: string): Promise<UpdateSettings>` (returns defaults `{enabled:false, channel:"latest", nightlyAck:false}` when the file is missing/garbage).
  - `writeUpdateSettings(stateDir: string, settings: UpdateSettings): Promise<void>` (atomic temp+rename, mirrors `app-state.ts`).
- Consumes: the `~/.ao` dir resolution already used for `app-state.ts` (`path.dirname(runFilePath())`).

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/main/update-settings.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readUpdateSettings, writeUpdateSettings, UPDATE_SETTINGS_FILE_NAME } from "./update-settings";

describe("update-settings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-update-settings-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns safe defaults when no file exists", async () => {
		expect(await readUpdateSettings(dir)).toEqual({ enabled: false, channel: "latest", nightlyAck: false });
	});

	it("round-trips written settings", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "nightly", nightlyAck: true });
		expect(await readUpdateSettings(dir)).toEqual({ enabled: true, channel: "nightly", nightlyAck: true });
	});

	it("falls back to defaults on garbage", async () => {
		await writeFile(path.join(dir, UPDATE_SETTINGS_FILE_NAME), "{not json", "utf8");
		expect(await readUpdateSettings(dir)).toEqual({ enabled: false, channel: "latest", nightlyAck: false });
	});

	it("coerces an unknown channel back to latest", async () => {
		await writeFile(
			path.join(dir, UPDATE_SETTINGS_FILE_NAME),
			JSON.stringify({ enabled: true, channel: "weird", nightlyAck: false }),
			"utf8",
		);
		expect((await readUpdateSettings(dir)).channel).toBe("latest");
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const entries = await readdir(dir);
		expect(entries).toEqual([UPDATE_SETTINGS_FILE_NAME]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/main/update-settings.test.ts`
Expected: FAIL, cannot resolve `./update-settings`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/src/main/update-settings.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type UpdateChannel = "latest" | "nightly";

export interface UpdateSettings {
	enabled: boolean;
	channel: UpdateChannel;
	nightlyAck: boolean;
}

/** File holding the user's auto-update preferences under the ~/.ao state dir. */
export const UPDATE_SETTINGS_FILE_NAME = "update-settings.json";

const DEFAULTS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false };

function coerce(raw: unknown): UpdateSettings {
	const o = (raw ?? {}) as Record<string, unknown>;
	return {
		enabled: o.enabled === true,
		channel: o.channel === "nightly" ? "nightly" : "latest",
		nightlyAck: o.nightlyAck === true,
	};
}

/** Read update settings, tolerating a missing or corrupt file (returns defaults). */
export async function readUpdateSettings(stateDir: string): Promise<UpdateSettings> {
	let raw: string;
	try {
		raw = await readFile(path.join(stateDir, UPDATE_SETTINGS_FILE_NAME), "utf8");
	} catch {
		return { ...DEFAULTS };
	}
	try {
		return coerce(JSON.parse(raw));
	} catch {
		return { ...DEFAULTS };
	}
}

/** Atomically write update settings (temp file + rename), mirroring app-state.ts. */
export async function writeUpdateSettings(stateDir: string, settings: UpdateSettings): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, UPDATE_SETTINGS_FILE_NAME);
	const data = `${JSON.stringify(coerce(settings), null, 2)}\n`;
	const tmp = path.join(stateDir, `.update-settings-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/main/update-settings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main/update-settings.ts frontend/src/main/update-settings.test.ts
git commit -F - <<'EOF'
feat(update): persist auto-update settings under ~/.ao

readUpdateSettings/writeUpdateSettings store {enabled, channel, nightlyAck}
with safe defaults and channel coercion, atomic temp+rename like app-state.ts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

## Task 5: electron-updater shell + main.ts wiring

**Files:**

- Modify: `frontend/package.json` (remove `update-electron-app`, add `electron-updater`)
- Create: `frontend/src/main/auto-updater.ts`
- Modify: `frontend/src/main.ts` (`initAutoUpdates` + the import)

**Interfaces:**

- Consumes: `readUpdateSettings` (Task 4); `releaseRepo` resolution (mirror the owner/repo default `AgentWrapper/agent-orchestrator`).
- Produces: `startAutoUpdates(stateDir: string): Promise<void>` that configures and starts electron-updater from settings. No-op-safe to call once on app ready.

- [ ] **Step 1: Swap the dependency**

Run:

```bash
cd frontend && npm uninstall update-electron-app && npm install electron-updater@^6
```

Expected: `package.json` no longer lists `update-electron-app`; lists `electron-updater`.

- [ ] **Step 2: Write the shell**

```typescript
// frontend/src/main/auto-updater.ts
import { autoUpdater } from "electron-updater";
import { readUpdateSettings } from "./update-settings";

// Default release repo, mirroring backend cli.releaseRepo. Override via env for
// fork test builds (AO_RELEASE_REPO=owner/repo).
const DEFAULT_RELEASE_REPO = "AgentWrapper/agent-orchestrator";

function repo(): { owner: string; name: string } {
	const [owner, name] = (process.env.AO_RELEASE_REPO || DEFAULT_RELEASE_REPO).split("/");
	if (owner && name) return { owner, name };
	const [defOwner, defName] = DEFAULT_RELEASE_REPO.split("/");
	return { owner: defOwner, name: defName };
}

// startAutoUpdates configures electron-updater from the user's ~/.ao settings.
// It is a thin shell: all policy (channel, opt-in) comes from update-settings.
// Caller guards on app.isPackaged.
export async function startAutoUpdates(stateDir: string): Promise<void> {
	const settings = await readUpdateSettings(stateDir);
	if (!settings.enabled) return;

	const { owner, name } = repo();
	autoUpdater.setFeedURL({ provider: "github", owner, repo: name });
	autoUpdater.channel = settings.channel; // "latest" | "nightly"
	autoUpdater.allowDowngrade = true; // permits a nightly -> stable channel switch
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("error", (err) => {
		// Never crash on update failure (offline, unsigned macOS, etc.).
		console.error("auto-update error:", err?.message ?? err);
	});

	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error("auto-update check failed:", err);
	}
}
```

- [ ] **Step 3: Wire it into main.ts**

In `frontend/src/main.ts`, replace the `update-electron-app` import and `initAutoUpdates` body:

Remove:

```typescript
import { updateElectronApp } from "update-electron-app";
```

Add (with the other `./main/*` imports):

```typescript
import { startAutoUpdates } from "./main/auto-updater";
```

Replace `initAutoUpdates`:

```typescript
function initAutoUpdates(): void {
	if (!app.isPackaged) return;
	const runFile = runFilePath();
	if (!runFile) return;
	void startAutoUpdates(path.dirname(runFile));
}
```

- [ ] **Step 4: Typecheck + build**

Run: `cd frontend && npm run typecheck`
Expected: only the pre-existing `forge.config.ts` `osxNotarize` error.

Run: `cd frontend && npx vitest run src/main/update-settings.test.ts scripts/nightly-version.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/main/auto-updater.ts frontend/src/main.ts
git commit -F - <<'EOF'
feat(update): channel-aware electron-updater wiring

Replace update-electron-app (stable-only, no channels) with electron-updater
driven by the user's ~/.ao settings: channel from settings, allowDowngrade for
channel switches, auto-download gated on opt-in, errors swallowed. Feed
configured via setFeedURL since forge does not emit app-update.yml.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

## Task 6: Opt-in + channel + nightly-disclaimer prompts (minimal)

**Files:**

- Modify: `frontend/src/main.ts` (first-run prompt via `dialog`)
- Modify: `frontend/src/main/auto-updater.ts` (export a helper to persist a channel choice)

**Interfaces:**

- Consumes: `writeUpdateSettings`, `readUpdateSettings` (Task 4).
- Produces: `ensureUpdatePrefs(stateDir: string): Promise<void>` that, on first run (no settings file written yet), prompts the user once for opt-in + channel and, if nightly, shows the instability/data-loss disclaimer; persists the result.

> Minimal main-process `dialog`-based prompt now; the polished Settings-page selector is #2207. This keeps the user-facing decision (opt-in + nightly disclaimer) present without depending on renderer UI work.

- [ ] **Step 1: Write the helper**

Add to `frontend/src/main/auto-updater.ts`. Extend the existing
`./update-settings` import to also pull in `writeUpdateSettings` and
`UPDATE_SETTINGS_FILE_NAME` (do NOT add a second import line from the same
module), and add the `electron`/`node:fs`/`node:path` imports:

```typescript
// extend the existing import:
//   import { readUpdateSettings, writeUpdateSettings, UPDATE_SETTINGS_FILE_NAME } from "./update-settings";
import { dialog } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

// ensureUpdatePrefs prompts once (first run, before any settings file exists)
// for auto-update opt-in + channel, with a nightly instability disclaimer.
export async function ensureUpdatePrefs(stateDir: string): Promise<void> {
	if (existsSync(path.join(stateDir, UPDATE_SETTINGS_FILE_NAME))) return;

	const optIn = await dialog.showMessageBox({
		type: "question",
		buttons: ["Enable auto-updates", "Not now"],
		defaultId: 0,
		cancelId: 1,
		message: "Keep Agent Orchestrator up to date automatically?",
		detail: "You can change this later in Settings.",
	});
	if (optIn.response !== 0) {
		await writeUpdateSettings(stateDir, { enabled: false, channel: "latest", nightlyAck: false });
		return;
	}

	const chan = await dialog.showMessageBox({
		type: "question",
		buttons: ["Stable", "Nightly"],
		defaultId: 0,
		cancelId: 0,
		message: "Which update channel?",
		detail: "Stable is released and tested. Nightly is the newest daily build.",
	});
	if (chan.response !== 1) {
		await writeUpdateSettings(stateDir, { enabled: true, channel: "latest", nightlyAck: false });
		return;
	}

	const ack = await dialog.showMessageBox({
		type: "warning",
		buttons: ["I understand, use Nightly", "Use Stable instead"],
		defaultId: 1,
		cancelId: 1,
		message: "Nightly builds can be unstable",
		detail: "Nightly is built every day and may be broken or lose data. Only use it if you are comfortable with that.",
	});
	await writeUpdateSettings(
		stateDir,
		ack.response === 0
			? { enabled: true, channel: "nightly", nightlyAck: true }
			: { enabled: true, channel: "latest", nightlyAck: false },
	);
}
```

- [ ] **Step 2: Call it before startAutoUpdates in main.ts**

Update `initAutoUpdates` in `frontend/src/main.ts`:

```typescript
function initAutoUpdates(): void {
	if (!app.isPackaged) return;
	const runFile = runFilePath();
	if (!runFile) return;
	const stateDir = path.dirname(runFile);
	void ensureUpdatePrefs(stateDir).then(() => startAutoUpdates(stateDir));
}
```

Add `ensureUpdatePrefs` to the import from `./main/auto-updater`.

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: only the pre-existing `forge.config.ts` `osxNotarize` error.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main/auto-updater.ts frontend/src/main.ts
git commit -F - <<'EOF'
feat(update): first-run opt-in + channel + nightly disclaimer prompt

Minimal main-process dialog flow: opt into auto-updates, pick stable/nightly,
and acknowledge a nightly instability/data-loss disclaimer. Persists the choice
to ~/.ao. Polished Settings-page selector is tracked in #2207.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Verification (whole feature)

- `cd frontend && npx vitest run scripts/nightly-version.test.mjs src/main/update-settings.test.ts` -> all pass.
- `cd frontend && npm run typecheck` -> only the pre-existing `osxNotarize` error.
- `ruby -ryaml -e "YAML.load_file('.github/workflows/frontend-nightly.yml')"` and same for `frontend-release.yml` -> parse clean.
- Real-CI-only (cannot run locally): first nightly cron run produces a prerelease with per-platform installers + `nightly*.yml`; the macOS feed step emits `nightly-mac.yml`. Confirm electron-updater on a packaged build resolves the channel. macOS update application requires signing (Track-B prereq).

## Deferred / prereqs (not in this plan; see spec)

- CI signing + notarization (Track B): macOS update application is blocked until this lands.
- Stable version stamping off `0.0.0` (Track B): nightly stamps its own version here; stable still needs its tag-derived stamp wired in the release workflow.
- Polished channel selector on the Global Settings page: #2207.
