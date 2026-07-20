# Desktop release runbook

How to cut a stable desktop release, end to end. Written from the v0.10.3 cut
(2026-07-12), which bumps the version on `main` via a PR and tags the merge
commit. v0.10.1/v0.10.2 used an older tag-only stamp commit that never landed
on `main`; the PR-based flow below supersedes it.

## How releases work

- **Stable** releases are triggered by pushing a `desktop-vX.Y.Z` tag to
  `AgentWrapper/agent-orchestrator`. `.github/workflows/frontend-release.yml`
  builds on four runners (macOS arm64, macOS Intel, Windows, Linux), signs and
  notarizes the macOS builds, and publishes a GitHub Release.
- **Nightly** releases run on a schedule via `frontend-nightly.yml` with no
  manual steps. The nightly version is derived from the highest `desktop-v*`
  stable tag (next patch + `-nightly.<timestamp>`), so after `desktop-v0.10.2`
  nightlies become `v0.10.3-nightly.*`.
- The version source of truth is `frontend/package.json` `"version"`.
  electron-forge's GitHub publisher names the release `v<package.json version>`,
  NOT after the git tag. The `desktop-v*` tag is only the workflow trigger, so
  the tagged commit must carry the right version (see the stamp commit below).
- The bump lands on `main` via a PR, so `main`'s `frontend/package.json`
  tracks the last released version; the `desktop-v*` tag then points at that
  merge commit. Nightlies stamp the version at build time from the highest
  `desktop-v*` tag, so they are unaffected by whatever `main` currently carries.

## Prerequisites

- Push access to `AgentWrapper/agent-orchestrator` (the tag push is the trigger).
- Authenticated `gh` CLI for the notes/verify steps.
- A release approver available (see "Who can approve" below); the build jobs
  wait on the `release` environment until someone approves.

## Cutting a stable release

Throughout, `X.Y.Z` is the new version (e.g. `0.10.2`) and `upstream` is the
`AgentWrapper/agent-orchestrator` remote.

### 1. Decide the version and review what ships

```bash
git fetch upstream main
# last stable tag reachable from main:
git tag --merged upstream/main --sort=-creatordate | grep -Ev 'nightly|desktop' | head -1
# commits that will ship:
git log v<last-stable>..upstream/main --oneline
```

Stable versions bump the patch unless something warrants minor/major.

### 2. Bump the version on `main` via a PR

Bump `frontend/package.json` to `X.Y.Z` on a branch and merge it into `main`.
This is the only version pin the stable build reads; `packages/ao*` are not
gated on the desktop release and stay as-is.

```bash
git checkout -b release-X.Y.Z upstream/main
# edit frontend/package.json: "version": "X.Y.Z"
git add frontend/package.json
git commit -m "chore(release): stamp desktop app version X.Y.Z"
git push <your-remote> release-X.Y.Z
gh pr create -R AgentWrapper/agent-orchestrator --base main \
  --head <owner>:release-X.Y.Z \
  --title "chore(release): stamp desktop app version X.Y.Z"
```

Merge the PR into `main` once it is green.

### 3. Tag the merge commit and push (this triggers the release)

Tag the merged `main` HEAD; confirm it carries the right version first, since
the release name comes from `frontend/package.json`, not the tag.

```bash
git fetch upstream main
git show upstream/main:frontend/package.json | grep '"version"'   # must read X.Y.Z
git tag -a desktop-vX.Y.Z upstream/main -m "Desktop release X.Y.Z: <highlights with PR numbers>"
git push upstream desktop-vX.Y.Z
```

### 4. Approve the `release` environment

The run appears under Actions > "Desktop release" in `waiting` state. An
approver either clicks "Review deployments" > approve in the run page, or from
the CLI:

```bash
run_id=$(gh run list -R AgentWrapper/agent-orchestrator --workflow frontend-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh api repos/AgentWrapper/agent-orchestrator/actions/runs/$run_id/pending_deployments \
  --jq '.[] | {env: .environment.id, can_approve: .current_user_can_approve}'
gh api -X POST repos/AgentWrapper/agent-orchestrator/actions/runs/$run_id/pending_deployments \
  -F 'environment_ids[]=<env id from above>' -f state=approved -f comment='Release X.Y.Z approved'
```

Then wait (roughly 30 minutes; macOS notarization dominates):

```bash
gh run watch $run_id -R AgentWrapper/agent-orchestrator --exit-status --interval 60
```

The workflow retries transient macOS sign/notary flakes on its own. The
release publishes as non-draft, non-prerelease automatically (`draft: false`
in `forge.config.ts`), so it becomes `latest` as soon as publish succeeds.

### 5. Attach release notes

The publisher creates the release with an empty body. Generate the standard
What's Changed / New Contributors / Full Changelog body and attach it:

```bash
gh api repos/AgentWrapper/agent-orchestrator/releases/generate-notes \
  -f tag_name=vX.Y.Z -f previous_tag_name=v<last-stable> --jq '.body' > /tmp/notes.md
gh release edit vX.Y.Z -R AgentWrapper/agent-orchestrator --notes-file /tmp/notes.md
```

### 6. Verify

```bash
# published, not draft/prerelease, 17 assets:
gh release view vX.Y.Z -R AgentWrapper/agent-orchestrator \
  --json isDraft,isPrerelease,assets --jq '{isDraft,isPrerelease,count:(.assets|length)}'
# latest points at the new release:
gh api repos/AgentWrapper/agent-orchestrator/releases/latest --jq '.tag_name'
# updater feed carries the new version:
curl -sL https://github.com/AgentWrapper/agent-orchestrator/releases/latest/download/latest-mac.yml | head -3
```

Expected assets (17): versioned installers for every platform
(`Agent.Orchestrator-darwin-{arm64,x64}-X.Y.Z.zip`, `Agent.Orchestrator.Setup.X.Y.Z.exe`,
`Agent.Orchestrator-X.Y.Z.AppImage`, deb, rpm) plus their `.blockmap` sidecars,
the five version-free aliases `ao start` fetches
(`agent-orchestrator-darwin-arm64.zip`, `agent-orchestrator-darwin-x64.zip`,
`agent-orchestrator-win32-x64.exe`, `agent-orchestrator-linux-x64.AppImage`,
and the deb/rpm published under versioned names), and the electron-updater
feeds `latest.yml`, `latest-mac.yml`, `latest-linux.yml`.

If a platform leg fails, re-run the failed jobs from the Actions UI; the
stable-alias upload steps use `--clobber`, so re-runs replace assets safely.

## Who can approve releases

Approval is governed by required reviewers on the `release` environment
(repo Settings > Environments > release). As of 2026-07-04 the approvers are:

- @harshitsinghbhandari
- @neversettle17-101
- @somewherelostt
- @Vaibhaav-Tiwari
- @Priyanchew

Anyone with write access can push the `desktop-v*` tag, but the build jobs
stay in `waiting` until one of the approvers above approves the run, so only
they can actually cut a release through the workflow. Self-review is allowed,
meaning a tag pusher who is also an approver may approve their own run; a
pusher who is not an approver still needs one of the five. Repo admins can
bypass the gate. The current list is readable by anyone with repo access:

```bash
gh api repos/AgentWrapper/agent-orchestrator/environments/release \
  --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login'
```

## Fork test releases (dev loop)

Test releases go to the fork, never to AgentWrapper: push a `desktop-v*` tag
to the fork or run the workflow via `workflow_dispatch` from the fork's
Actions tab. `AO_RELEASE_REPO` is derived from `github.repository`, so a fork
run publishes to the fork with no source edit. See the header comment in
`frontend-release.yml`.

## Signing infrastructure (reference)

macOS signing + notarization is driven by repo Actions secrets consumed by
`.github/actions/macos-signing-setup`: `CSC_LINK` (base64 `.p12`),
`CSC_KEY_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and the notarytool API key trio
`APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. These are
configured; releases since v0.10.1 ship signed and notarized, and the in-app
auto-updater (`update-electron-app` in `src/main.ts`, active only when
`app.isPackaged`) updates installed apps from the Releases feed. Windows
code-signing is still a follow-up (issue #401).

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
  then has no bundled fallback). deb/rpm do **not** declare a system tmux
  dependency: the whole point of the bundle is that no package manager
  install is required, so the resolver falls back to it if PATH has none.
- **Rolling a new tmux version.** Dispatch the workflow with the new versions
  (update the source-tarball sha256s in the workflow env first), wait for the
  `tmux-artifacts-v*` release, then update `TMUX_DIST_TAG` and the binary
  sha256 map in `scripts/fetch-tmux.mjs` from the release's `checksums.txt`.
- **Missing release / unpinned checksums.** The `tmux-artifacts-v*` release
  referenced by `TMUX_DIST_TAG` is published manually and may not exist yet on
  a given branch or fork. By default `fetch-tmux.mjs` treats that (and an
  unpinned sha256) as non-fatal: it warns and packages without the bundled
  fallback, same as `AO_SKIP_TMUX_FETCH=1`, so local/dev/testing-build
  packaging never breaks on it. `frontend-release.yml` and
  `frontend-nightly.yml` set `AO_REQUIRE_TMUX_FETCH=1` on their Publish steps
  so the **signed, user-facing** builds fail loudly instead of silently
  shipping without the fallback — before enabling that for a real cut, dispatch
  `tmux-artifacts.yml` and fill in the sha256 pins per the rollover step above.
- **Licenses.** tmux ISC, libevent BSD-3-Clause, ncurses MIT-X11 — all
  redistribution-compatible; the artifact release notes restate them.
