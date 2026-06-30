# Auto-update with stable + nightly channels

_Design spec. 2026-06-26. Branch `feat/ao-auto-update` (off `main`)._

## Goal

Give the Agent Orchestrator desktop app channel-aware auto-update with two
channels:

- **stable**: real semver releases (`vX.Y.Z`), cut manually by a human.
- **nightly**: built and published automatically every day.

Both channels auto-update via Electron. The user opts in to auto-update and
picks a channel in-app; choosing nightly requires acknowledging an
instability/data-loss disclaimer.

## Scope (this spec)

**In scope (implement now):**

1. In-app channel-aware updater (the `electron-updater` runtime wiring +
   channel-switch API + the three persisted settings + opt-in/disclaimer
   prompts).
2. The nightly release pipeline (daily CI cron) and the version scheme for
   both channels, including the build version stamping that nightly forces.

**Captured here but NOT implemented now (deferred / tracked elsewhere):**

- Polished channel-selection settings UI: issue #2207 (a minimal selector on
  the Global Settings page is acceptable now; full UI is #2207).
- Global Settings page itself: done in #2218 (was blocked as #2205).

**Hard prerequisites (must land for the feature to fully function):**

- **CI code signing + notarization** (Track B). macOS auto-update (Squirrel.Mac
  via electron-updater) refuses to apply updates to an unsigned/unnotarized
  build. Until signing lands, macOS nightly/stable are download-only; win/linux
  can still auto-update. This is a functional blocker for the macOS half, not a
  nicety.
- **Stable version stamping** off `0.0.0` (Track B). Nightly solves stamping for
  its own builds (below); stable still needs its tag-derived version stamped in.

## Mechanism: electron-updater

Chosen over `update.electronjs.org` (stable-only, no channels) and a custom
GitHub-releases updater (reimplements the risky download/verify/install glue)
and a hosted update server (extra ops). electron-updater has native channels,
per-OS atomic install, signature verification, and delta downloads.

### Runtime (`frontend/src/main.ts`)

- Add the `electron-updater` dependency. Remove `update-electron-app`.
- Replace `updateElectronApp()` in `initAutoUpdates()` with an `autoUpdater`
  setup that:
  - Resolves the GitHub provider from the same release-repo source `ao start`
    uses (`AgentWrapper/agent-orchestrator` by default, override-aware).
  - Sets `autoUpdater.channel` from the saved user choice
    (`latest` | `nightly`).
  - Gates `autoUpdater.autoDownload` on the user's auto-update opt-in.
  - Sets `allowDowngrade = true` so a nightly -> stable channel switch can move
    to a lower semver.
  - Stays a thin shell over a pure, testable module (see Testing).
- **Forge nuance:** electron-forge does not generate electron-updater's
  `app-update.yml` (electron-builder normally does). Configure the feed
  programmatically with `autoUpdater.setFeedURL(...)` at startup so the feed
  config lives in one place in `main.ts` and we do not depend on a build-time
  file forge will not produce.
- Keep the existing guard: skip entirely when `!app.isPackaged` (no feed in
  dev).

### Feed (release assets the app reads)

electron-updater reads per-platform, per-channel metadata from the GitHub
release:

- stable: `latest-mac.yml`, `latest.yml`, `latest-linux.yml` (+ `.blockmap`s).
- nightly: `nightly-mac.yml`, `nightly.yml`, `nightly-linux.yml` (+ blockmaps).

**CORRECTION (verified 2026-06-26, final review):** the original assumption that
"Windows and Linux emit this metadata naturally via the electron-builder makers"
is FALSE. Both `maker-nsis.ts` and `maker-appimage.ts` set `config.publish: null`
(deliberately, so electron-builder does not try to upload, forge owns publishing).
With `publish: null`, `getPublishConfigs` returns null and
`artifactCreatedWithoutExplicitPublishConfig` returns early BEFORE
`createUpdateInfoTasks` runs (app-builder-lib `PublishManager.js:143`,`356`,`163`),
so NO feed `*.yml` is generated on Windows or Linux either. macOS (forge
`maker-zip`) never emitted it. Net: as currently built, no platform produces a
feed, so the updater is inert everywhere until this is fixed.

Generating the feed `*.yml` (and `.blockmap`) on all three platforms WITHOUT
letting electron-builder upload (forge does the upload), then uploading the yml
to each release, is its own coherent "feed-publishing" workstream. It is
verifiable only on real CI and is coupled to Track-B macOS signing. It is OUT OF
SCOPE for this spec's implementation and tracked separately (see Open
prerequisites). The runtime half (the in-app updater, settings, prompts, and
nightly build) ships first as groundwork and is inert-but-harmless until the
feed exists, the same state the prior `update-electron-app` was in.

## Version scheme

```
stable:   X.Y.Z                                  e.g. 0.10.4
nightly:  X.Y.(Z+1)-nightly.<UTC-timestamp>+<short-sha>
          e.g. 0.10.4-nightly.202606270300+ab12cd3
```

Rationale:

- **Ordered.** A bare `{sha}` prerelease is not monotonic (two nightlies do not
  order by time), so the updater could not tell newer from older. The
  `nightly.<UTC-timestamp>` component is monotonic and orders by build time.
- **Channel-tagged.** electron-builder derives the channel from the prerelease
  tag's first identifier, so `-nightly.<...>` publishes to the `nightly`
  channel (`nightly*.yml`); a bare `X.Y.Z` (no prerelease) publishes to
  `latest`.
- **Traceable.** `+<short-sha>` is semver build metadata: ignored for ordering
  but visible in the UI and ties a build to its commit. Preserves the original
  "{sha}" intent without breaking ordering.
- **Next-patch base (`Z+1`).** A nightly always sorts ahead of the last stable
  (`0.10.4-nightly.* > 0.10.3`) and behind the eventual `0.10.4` stable.
  Intuitive when a user on nightly is waiting for the release to catch up.

## Release pipeline

### Stable (manual)

Unchanged trigger: a human pushes `desktop-vX.Y.Z`. The desktop-release workflow
builds all platforms and, in addition to the installers + existing `ao start`
stable aliases, now generates and uploads electron-updater's `latest*.yml` +
`.blockmap`s to the release. The build version is the tag's version (stable
stamping).

### Nightly (daily cron)

A GitHub Actions `schedule` workflow on `main` that:

1. Computes `X.Y.(Z+1)-nightly.<UTC-timestamp>+<short-sha>`, with `X.Y.Z` from
   the latest stable tag.
2. Stamps the version into the build: `frontend/package.json` version and the
   daemon `-ldflags` version. (This is the version-stamping work, solved for
   nightly here.)
3. Builds all platforms and publishes a **prerelease** GitHub release carrying
   installers + `nightly*.yml`.
4. **Skips when there are no new commits since the last nightly** (no empty
   builds).

macOS nightly auto-update needs signing (prereq); until then macOS nightly is
download-only.

## In-app UX

Minimal now; polished UI is #2207 on the Global Settings page (#2218).

Three persisted settings under `~/.ao` (app settings / app-state, never an
OS-default location):

- `autoUpdate.enabled` (bool)
- `autoUpdate.channel` (`latest` | `nightly`)
- `autoUpdate.nightlyAck` (bool)

Flow:

- First-run opt-in prompt: enable auto-updates? which channel?
- Choosing nightly shows the "may be unstable, data may be lost" disclaimer and
  requires explicit acknowledgement (`nightlyAck`).
- `main.ts` reads these settings, configures `autoUpdater` (channel,
  `autoDownload`), and on `update-downloaded` notifies the user and installs on
  quit.
- A minimal channel selector can live on the Global Settings page; full UI is
  #2207.

## Error handling

- No feed / offline: log and retry on the next interval; never crash.
- Unsigned macOS: the updater errors; swallow it gracefully, no nagging.
- Channel switch downgrade: handled by `allowDowngrade = true`.
- Dev / unpackaged: skip (as today).

## Testing

Pull version computation, channel detection, and settings read/write into a
thin, pure module with unit tests:

- nightly version is monotonic by timestamp;
- nightly base is the next patch;
- channel derives correctly from the prerelease tag;
- sha is build metadata (ignored for ordering, present in the string).

The Electron `autoUpdater` wiring stays a thin shell around this module and is
not unit-tested (Electron runtime).

## Components (isolation)

- `version` module (pure): compute/parse the nightly + stable version, derive
  channel. Testable in isolation.
- `update-settings` module (pure-ish): read/write the three `~/.ao` settings.
- `auto-updater` shell (`main.ts`): wires `electron-updater` to the two modules;
  no logic of its own beyond Electron event glue.
- nightly CI workflow: version computation (reuses the same logic, shell form)
  - build + publish.
- macOS feed step in the release workflow: emit + upload `*-mac.yml`.

## Open prerequisites summary

| Item                                      | Status                  | Blocks                                               |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------- |
| Feed `*.yml` publishing (all 3 platforms) | NOT done (verified gap) | ALL auto-update (no feed = updater inert everywhere) |
| CI signing + notarization                 | Track B, not done       | macOS auto-update (functional)                       |
| Stable version stamping                   | Track B, not done       | stable channel correctness                           |
| Polished channel UI (#2207)               | deferred                | nicety only; minimal selector now                    |
| Global Settings page (#2218)              | done                    | (unblocks #2207)                                     |

The feed-publishing item is the load-bearing prerequisite the original spec
missed. The runtime implemented here does nothing useful until it lands.
