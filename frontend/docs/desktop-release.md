# Desktop release & auto-update

The desktop app ships an in-app auto-updater (`update-electron-app`). The **code**
is wired; making it **go live** needs infrastructure only the team can provision
(an Apple Developer certificate, notarization, and CI secrets). This is the
checklist.

## What already works (in this repo)

- `update-electron-app` is wired in `src/main.ts` (`initAutoUpdates()`), guarded
  by `app.isPackaged` so it is a no-op in `npm run dev`. It reads the GitHub
  Releases feed directly via the Releases API — no `latest-mac.yml` files needed.
- `forge.config.ts > publishers` uses `@electron-forge/publisher-github`, pointed
  at the GitHub Releases feed (draft releases by default).
- `.github/workflows/frontend-release.yml` builds on a `desktop-v*` tag and runs
  `npm run publish` (`electron-forge publish`), which makes the installers and
  uploads them to a GitHub Release.

## What the team must add (auto-update is inert until these exist)

1. **Apple Developer cert + notarization** (macOS hard requirement — an unsigned
   app cannot auto-update):
   - Enroll in the Apple Developer Program.
   - Export a "Developer ID Application" certificate as a `.p12`.
   - Signing is already gated in `forge.config.ts` on the env vars below:
     `osxSign` activates when `CSC_LINK` is set, `osxNotarize` when `APPLE_ID`
     is set. No config edit needed — just provide the secrets.
2. **GitHub repository secrets** (Settings → Secrets → Actions):
   - `CSC_LINK` — base64 of the `.p12` certificate.
   - `CSC_KEY_PASSWORD` — the `.p12` password.
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — for notarization.
   - `GITHUB_TOKEN` is provided automatically; the workflow already grants
     `contents: write` to publish the Release.
3. **(Optional) Windows / Linux** — the `forge.config.ts` makers already include
   NSIS (Windows, via `makers/maker-nsis.ts`), deb, and rpm. To publish them, add
   the matching matrix runners to `frontend-release.yml`; Windows code-signing
   needs its own certificate (still a follow-up, see issue #401).

## Cutting a release

```bash
# bump frontend/package.json "version", commit, then:
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The workflow publishes a GitHub Release with the installers. Installed apps check
the Releases feed on launch (`update-electron-app`) and prompt to restart when an
update is downloaded.

## Bundled tmux provenance (issue #2443)

macOS/Linux installers ship a static tmux at `Resources/tmux-dist/tmux` as a
**private fallback**: the daemon resolves `AO_TMUX_BIN` (explicit override) →
system tmux on `PATH` → this bundle → clear `RUNTIME_PREREQUISITE_MISSING`
error. A system tmux always wins; nothing is installed onto the user's machine.

- **Where the binaries come from.** The manual-dispatch
  `.github/workflows/tmux-artifacts.yml` workflow compiles tmux + libevent +
  ncurses from official source tarballs whose sha256s are pinned in the
  workflow env, natively per target (macOS arm64/x64: static deps, dynamic
  only against libSystem, deployment target 11.0; Linux x64: musl fully-static
  on alpine, with terminfo search dirs `/etc/terminfo:/lib/terminfo:/usr/share/terminfo`
  and compiled-in xterm/screen/tmux fallbacks so terminfo-less hosts work).
  It publishes a `tmux-artifacts-v<tmuxver>-<rev>` GitHub release with a
  `checksums.txt` and full provenance notes.
- **How packaging consumes them.** `scripts/fetch-tmux.mjs` (run by the
  `prepackage`/`premake`/`publish` hooks, before signing) downloads the asset
  for the build host's platform/arch and verifies it against the sha256 map
  pinned at the top of that script, then Forge ships `tmux-dist` as an
  `extraResource` so macOS signing/notarization seals it into the bundle.
  `AO_SKIP_TMUX_FETCH=1` skips the fetch for offline dev packaging (the build
  then has no bundled fallback). deb/rpm additionally declare a system tmux
  dependency.
- **Rolling a new tmux version.** Dispatch the workflow with the new versions
  (update the source-tarball sha256s in the workflow env first), wait for the
  `tmux-artifacts-v*` release, then update `TMUX_DIST_TAG` and the binary
  sha256 map in `scripts/fetch-tmux.mjs` from the release's `checksums.txt`.
- **Licenses.** tmux ISC, libevent BSD-3-Clause, ncurses MIT-X11 — all
  redistribution-compatible; the artifact release notes restate them.
