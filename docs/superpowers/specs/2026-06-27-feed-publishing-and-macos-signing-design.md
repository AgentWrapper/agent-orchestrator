# Feed publishing + macOS signing (auto-update prerequisites)

_Design spec. 2026-06-27. Branch off `main`. Closes the #2220 feed-publishing
gap and folds in the macOS-signing half of Track B, so the auto-update runtime
(PR #2221) becomes functional. Ships as ONE PR._

## Goal

The auto-update runtime (electron-updater wiring, settings, prompts) landed inert
in PR #2221 because **no platform publishes an electron-updater feed**. This spec
makes the feed exist and makes macOS updates actually apply:

1. **Feed publishing (all 3 platforms).** Generate and upload the channel
   metadata (`latest*.yml` / `nightly*.yml`) and per-artifact `.blockmap`
   sidecars to each GitHub release, so electron-updater can see and download
   updates.
2. **macOS code-signing + notarization in CI.** Squirrel.Mac (the native updater
   electron-updater drives on macOS) refuses to apply an update to an
   unsigned/unnotarized app. Without this, the mac feed is generated but inert.

Both land together in one PR so a single review unblocks the whole feature.

## Background: why the feed is missing today (verified)

- The custom `maker-nsis.ts` and `maker-appimage.ts` call app-builder-lib's
  `buildForge` with `config.publish: null`. With `publish: null`,
  `createUpdateInfoTasks` short-circuits, so NO `*.yml` / `.blockmap` is emitted
  on Windows or Linux.
- macOS uses `@electron-forge/maker-zip`, which never emitted updater metadata.
- Net: as built, no platform produces a feed; the updater is inert everywhere.

`publish: null` is load-bearing (it stops electron-builder from inferring a
GitHub target and racing forge on the upload). This spec does NOT touch it.

## Verified contracts (ground truth, read from installed packages)

Versions installed: `app-builder-lib@26.15.3`, `builder-util-runtime@9.7.0`,
`electron-updater@6.8.9`. **There is no `app-builder` CLI / `app-builder-bin`
package** in this tree.

1. **Blockmap generation is pure JS**, not a CLI. `buildBlockMap(inFile,
compressionFormat, outFile)` in
   `app-builder-lib/out/targets/blockmap/blockmap.js`. Sidecar mode
   (`compressionFormat: "gzip"`, `outFile` set) writes a gzipped `.blockmap`
   file and returns `{ size, sha512 }` (raw file size, base64 SHA-512 of the
   **unmodified** file); it does NOT modify the artifact and does NOT return
   `blockMapSize`.
2. **yml schema** (`builder-util-runtime/out/updateInfo.d.ts`): per-file entry is
   `{ url, sha512, size?, blockMapSize? }`; top level is
   `{ version, files[], path (deprecated), sha512 (deprecated), releaseDate }`.
   When `blockMapSize` is absent, the client uses the **sidecar** delta path
   (`GenericDifferentialDownloader`, fetches `<url>.blockmap`) on all platforms.
3. **macOS multi-arch** (`MacUpdater.filterFilesForArch`): one merged
   `latest-mac.yml` listing both arch zips is correct; the updater picks by the
   literal substring **`arm64`** in the file url (no arch field). AO's versioned
   mac zip names already contain `arm64` / `x64`.
4. **macOS delta** (`MacUpdater` + `AppUpdater.differentialDownloadInstaller`):
   uses a **sidecar `<name>-mac.zip.blockmap`**; `blockMapSize` is ignored on
   mac; first install is always a full download (no prior cached zip), then the
   zip is cached for next time. Old-version blockmap URL is derived by
   substituting the version string in the artifact path, so the feed MUST
   reference **versioned** asset names.
5. **channel -> filename** (`Provider.getChannelFilePrefix` + `getChannelFilename`):
   `autoUpdater.channel` of `latest` / `nightly` maps to
   `latest.yml`|`latest-mac.yml`|`latest-linux.yml` and the `nightly*`
   equivalents; the OS/arch suffix is added client-side. We pass only the bare
   channel name (already done in PR #2221's `auto-updater.ts`).
6. **Signing is enforced by native Squirrel.Mac**, not by electron-updater JS.
   The app must be code-signed + notarized for the mac update to apply.

## Approach (chosen): sidecar-only post-matrix join job

Rejected: in-build generation by flipping `publish:null` to a generic provider.
It needs a separate mac join anyway, sits next to the load-bearing `publish:null`,
and its only edge (canonical embedded-AppImage blockmap) is moot because the
client accepts sidecar blockmaps whenever `blockMapSize` is absent.

Chosen: a single job per workflow, after the build matrix, that hashes the
already-uploaded versioned artifacts, emits sidecar blockmaps + the channel yml,
and uploads them. No maker changes, no artifact mutation, one mechanism for all
three platforms, and the mac arch-merge falls out naturally because the join job
sees all artifacts at once.

## Component 1: feed publishing

### Pure module: `frontend/scripts/feed.mjs` (+ `feed.test.mjs`)

Mirrors the existing `nightly-version.mjs` (+ `.test.mjs`) pattern.

- Input: `{ channel: "latest" | "nightly", version, platform, files: [paths] }`.
- For each file: compute base64 SHA-512 + byte size; call `buildBlockMap(file,
"gzip", file + ".blockmap")` (via a one-file wrapper around the internal
  import, see Risks) to write the sidecar.
- Assemble the platform yml:
  - win: `latest.yml` -> `files: [{ url: <exe>, sha512, size }]`.
  - linux x64: `latest-linux.yml` -> `files: [{ url: <AppImage>, sha512, size }]`.
  - mac: `latest-mac.yml` -> `files: [{ url: <arm64.zip>, ... }, { url: <x64.zip>, ... }]`,
    arm64 entry first; top-level deprecated `path`/`sha512` point at the first zip.
  - `version`, `releaseDate: new Date().toISOString()` (normal CI node; the
    Workflow-sandbox `Date` restriction does not apply here).
  - `blockMapSize` is deliberately omitted (forces sidecar delta).
- Output: the yml text + the list of written `.blockmap` files. Pure except for
  reading/hashing the input files.

`feed.test.mjs`: run against a real small fixture artifact and assert (a) the
yml's `sha512`/`size` match precomputed values, (b) the mac case yields two
`files` entries with correct `arm64`/`x64` urls, (c) a `.blockmap` sidecar is
written, (d) no `blockMapSize` key is present.

### Workflow wiring (both `frontend-release.yml` and `frontend-nightly.yml`)

Add a `publish-feed` job, `needs:` all build-matrix jobs, single ubuntu runner:

1. `gh release download <tag>` the **versioned** installers only: the win `*.exe`,
   the linux `*.AppImage`, and both `*-darwin-arm64-*.zip` / `*-darwin-x64-*.zip`.
   Exclude `.deb` / `.rpm` (not electron-updater-managed; the OS package manager
   owns those).
2. `node scripts/feed.mjs` over the downloaded files to produce
   `latest*.yml`|`nightly*.yml` + the `.blockmap` sidecars. Channel is `latest`
   for the release workflow, `nightly` for the nightly workflow.
3. `gh release upload <tag> --clobber` the yml + sidecars to the same release.

The tag is the forge-created `v<version>` release. Asset names are discovered
from the downloaded files (not hardcoded).

## Component 2: macOS signing + notarization

The manual local flow is proven (runbook: `~/.me/instructions/ao-macos-signed-release.md`):
Developer ID + hardened runtime + notarytool + staple works for AO, and forge's
`osxSign` already signs the nested Go daemon (`Contents/Resources/daemon/ao` ->
`flags=0x10000(runtime)` + Developer ID authority). The CI task is to reproduce
that flow on the runners.

**Notarization uses the App Store Connect API key (`.p8`) path**, matching the
proven local creds (the `ao-notary` keychain profile) — NOT the Apple ID +
app-specific-password path. The cert and key belong to an external Team "holder";
the API key reuses material already in hand, so it needs nothing new from the
holder.

Already present: the `osxSign` activation in `forge.config.ts` (keys on
`APPLE_SIGNING_IDENTITY` / `CSC_LINK`) and the `CSC_LINK` / `CSC_KEY_PASSWORD`
secret passthrough in both workflows. Gaps to fill:

1. **Keychain provisioning** (the missing piece — forge/`@electron/osx-sign` does
   NOT decode `CSC_LINK` itself, unlike electron-builder). Add the maintained
   `apple-actions/import-codesign-certs` action on the macOS matrix legs, before
   `npm run publish`, to import the Developer ID Application cert from the base64
   p12 into a temporary keychain. Do not hand-roll `security` commands. Set
   `APPLE_SIGNING_IDENTITY` so signing is deterministic.
2. **Entitlements**: add `frontend/build/entitlements.mac.plist` with the
   hardened-runtime entitlements Electron requires (`com.apple.security.cs.allow-jit`,
   `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`,
   `disable-library-validation`), and point `osxSign` at it. Required for a
   working notarized Electron app.
3. **Rewire `osxNotarize` to the API-key (`apiKey`) variant** and delete the
   `as unknown as ...` double cast (the one known typecheck error). New branch:
   `{ appleApiKey: <path to .p8>, appleApiKeyId: <APPLE_API_KEY_ID>, appleApiIssuer:
<APPLE_API_ISSUER> }`. Since `appleApiKey` is a file PATH, a CI step decodes
   the base64 `.p8` secret to a temp file and exports `APPLE_API_KEY` to it before
   `npm run publish`. Keep the local `AO_NOTARY_PROFILE` (`keychainProfile`)
   branch for the manual runbook; just fix its typing.
4. **Pin Node 22** on the macOS signing legs — `npm run make` crashes on Node 26
   (per the runbook). Confirm/align the workflow's Node version.

### Human prerequisites (release owner provides as repository secrets)

- `CSC_LINK` — base64 of the Developer ID Application `.p12` (self-served by
  exporting the identity from the local keychain; the private key is the owner's
  via the original CSR).
- `CSC_KEY_PASSWORD` — the `.p12` export password.
- `APPLE_SIGNING_IDENTITY` — `Developer ID Application: <Holder> (<TEAMID>)`.
- `APPLE_API_KEY_BASE64` — base64 of the holder's App Store Connect `.p8` (needs
  the original file; cannot be extracted back out of the `ao-notary` profile).
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — the key's ID + issuer UUID.

Only `APPLE_API_KEY_BASE64`/ID/issuer require the original `.p8`; if lost, the
holder re-issues an App Store Connect API key (their only possible involvement).
Set on the fork for testing, on AgentWrapper for prod.

**Out of scope:** Windows code signing (separate EV-cert concern; Windows
auto-update works unsigned). This component is macOS-only because Squirrel.Mac is
the actual blocker.

## Ordering / coupling

The two components are order-independent and both fit in one PR. The feed job
hashes whatever bytes the build uploaded: once signing is active the build
produces signed mac zips and the feed job naturally hashes the signed bytes, so
there is no sequencing constraint between them.

## Error handling / graceful degradation

- Missing prior blockmap / first install: full download, then cache. Normal.
- If sidecar delta does not engage on a platform, electron-updater full-downloads
  the installer (still correct; delta is only a bandwidth optimization).
- Unsigned/un-notarized mac build (e.g. secrets absent on the fork): the build
  stays unsigned, the mac feed is generated but Squirrel.Mac will not apply it;
  win/linux are unaffected. Same inert-but-harmless posture as before.

## Risks (all CI-verifiable; all degrade gracefully)

1. **Internal import path.** `buildBlockMap` lives at an internal app-builder-lib
   path (`out/targets/blockmap/blockmap.js`) that could move on a major upgrade.
   Mitigate: pin `app-builder-lib`, isolate the import in one wrapper module, and
   add a smoke check that the function is callable.
2. **Sidecar delta on NSIS-one-file / AppImage** when `blockMapSize` is absent:
   high confidence from the client's downloader-selection logic, but only
   provable on CI. Failure mode is a silent full-download (still correct).
3. **forge `maker-zip` shape**: confirm the mac zip is the `.app`-at-root shape
   Squirrel.Mac expects for an update payload. Partially de-risked: the runbook's
   verify step unzips the maker-zip output to a launchable, Gatekeeper-accepted
   signed `.app`, so the zip is well-formed; only the updater-payload path is
   still CI-unverified.
4. **First CI notarization** via the `.p8` API-key path + entitlements (standard
   but first-time-in-CI; the same creds are proven locally via the `ao-notary`
   profile).

## Components (isolation)

- `feed.mjs` (pure-ish): yml + blockmap assembly. Unit-tested.
- `blockmap` wrapper (one file): isolates the internal app-builder-lib import.
- `publish-feed` workflow job: download -> generate -> upload. CI-only.
- `entitlements.mac.plist` + the keychain step + `forge.config.ts` tweak:
  signing. CI-only.

## What this unblocks

With this PR + the already-open #2221 merged: win/linux auto-update is live
immediately; macOS auto-update is live as soon as the signing secrets are present
on the production (AgentWrapper) repo. Only then may v1 copy promise auto-update.
