# Desktop release

How the Electron desktop app is built and released, and what that means for
contributors to this repository.

## How releases work

Releases are produced in two stages that live in two places:

1. **This repository builds the app, unsigned.**
   `.github/workflows/build-artifacts.yml` builds the desktop app for all four
   platform targets (macOS arm64, macOS Intel/x64, Windows x64, Linux x64). It
   runs only on `workflow_dispatch`, produces no signed output and creates no
   GitHub Release. It uploads the build outputs as workflow run artifacts along
   with a `digests.json` that records a content hash for each artifact.

2. **A separate, access-restricted release pipeline signs and publishes.**
   That pipeline pins a specific commit, re-runs the build, verifies the
   uploaded artifacts against `digests.json`, signs and notarizes the macOS
   builds, generates the electron-updater feeds, and publishes the GitHub
   Release with all of its assets.

This repository holds no signing or publishing secrets. Contributors do not
need any credentials to build, test, or work on the desktop app; the unsigned
build in `build-artifacts.yml` runs entirely from public inputs.

`frontend-release.yml` and `frontend-nightly.yml` remain in this repo as
build-only smoke checks (they run `npm run make` on every platform to prove the
app still builds); they publish nothing.

## Channels

All published channels are produced by the access-restricted pipeline:

- **Stable** releases: `X.Y.Z`, published as the `latest` GitHub Release.
- **Nightly** releases: semver prereleases of the form
  `X.Y.Z-nightly.<UTC-timestamp>`. The version must be valid semver because
  Windows and Linux packaging reject non-semver versions.
- **Per-PR preview** builds: a build of a single open PR, published to an
  isolated `pr<N>` electron-updater channel so it never touches the stable or
  nightly feeds. Users opt in per PR from the in-app updater settings.

## What contributors do

Open normal PRs against `main`. Contributors do not cut releases directly.

`build-artifacts.yml` is dispatch-only and is driven by the release pipeline;
there is no tag push or version-bump PR to perform as part of shipping. The
version source of truth remains `frontend/package.json` `"version"`.

## Assets

Each published GitHub Release carries:

- **Five version-free aliases** that `ao start` and the Homebrew cask resolve
  through the constant `releases/latest/download/<name>` URL:
  - `agent-orchestrator-darwin-arm64.zip`
  - `agent-orchestrator-darwin-x64.zip`
  - `agent-orchestrator-win32-x64.exe`
  - `agent-orchestrator-linux-x64.AppImage`
  - `agent-orchestrator-linux-x64.deb`
- **Versioned installers** for every platform plus their `.blockmap` sidecars,
  which the electron-updater feed references for delta updates.
- **The updater feed files** (`latest.yml`, `latest-mac.yml`,
  `latest-linux.yml`, and the per-channel equivalents for nightly and preview
  builds).

The in-app auto-updater (`update-electron-app` in `src/main.ts`, active only
when `app.isPackaged`) consumes these published feeds to update installed apps.
