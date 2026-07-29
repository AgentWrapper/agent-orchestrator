# Desktop release runbook

How to cut a stable desktop release, end to end, for the Tauri desktop app
(`.github/workflows/tauri-release.yml`). This replaces the retired
electron-forge/electron-builder pipeline (`frontend-release.yml`,
`feature-release.yml`, `feature-release-cleanup.yml`, `build-artifacts.yml`,
`testing-build.yml`, `desktop-testing.yml`, `release-latest-guard.yml`),
removed in M7 once the Tauri app was validated as the sole desktop shell.

## How releases work

- **Stable** releases are triggered by pushing a `desktop-tauri-vX.Y.Z` tag to
  `AgentWrapper/agent-orchestrator`. `.github/workflows/tauri-release.yml`
  builds on four native runners (macOS arm64, macOS Intel, Windows, Linux),
  signs and notarizes the macOS builds, signs every bundle with a minisign
  updater key, and publishes a GitHub Release.
- Unlike the old electron-forge pipeline, **the pushed tag is authoritative**:
  the workflow derives the version directly from the tag name
  (`desktop-tauri-vX.Y.Z` → `X.Y.Z`) and stamps it into `package.json` and
  `src-tauri/tauri.conf.json` at build time. There is no separate "bump
  `package.json` via a PR, then tag the merge commit" step — tagging `main`
  (or any commit) directly is sufficient.
- **Feature releases** (see below) reuse the same workflow via
  `workflow_dispatch`, with version `<base>-pr<N>.<UTCts>+<sha>` derived from
  `frontend/package.json` at the PR's head commit.
- There is currently no automated **nightly** release for the Tauri app (the
  old `frontend-nightly.yml`-style schedule was never ported); cut a stable
  release manually until/unless that gap is addressed.

## Prerequisites

- Push access to `AgentWrapper/agent-orchestrator` (the tag push is the trigger).
- Authenticated `gh` CLI for the notes/verify steps.
- A release approver available (see "Who can approve" below); the build jobs
  wait on the `release` environment until someone approves.

## Cutting a stable release

Throughout, `X.Y.Z` is the new version and `upstream` is the
`AgentWrapper/agent-orchestrator` remote.

### 1. Decide the version and review what ships

```bash
git fetch upstream main
# last stable tag reachable from main:
git tag --merged upstream/main --sort=-creatordate | grep -E '^desktop-tauri-v' | grep -v nightly | head -1
# commits that will ship:
git log desktop-tauri-v<last-stable>..upstream/main --oneline
```

Stable versions bump the patch unless something warrants minor/major.

### 2. Tag the commit and push (this triggers the release)

No version-bump PR is needed — the tag itself is the source of truth.

```bash
git fetch upstream main
git tag -a desktop-tauri-vX.Y.Z upstream/main -m "Desktop release X.Y.Z: <highlights with PR numbers>"
git push upstream desktop-tauri-vX.Y.Z
```

### 3. Approve the `release` environment

The run appears under Actions > "Tauri desktop release" in `waiting` state
(each of the four build-matrix jobs, plus the fan-in manifest job, gate on the
same `release` environment). An approver either clicks "Review deployments" >
approve in the run page, or from the CLI:

```bash
run_id=$(gh run list -R AgentWrapper/agent-orchestrator --workflow tauri-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh api repos/AgentWrapper/agent-orchestrator/actions/runs/$run_id/pending_deployments \
  --jq '.[] | {env: .environment.id, can_approve: .current_user_can_approve}'
gh api -X POST repos/AgentWrapper/agent-orchestrator/actions/runs/$run_id/pending_deployments \
  -F 'environment_ids[]=<env id from above>' -f state=approved -f comment='Release X.Y.Z approved'
```

Then wait:

```bash
gh run watch $run_id -R AgentWrapper/agent-orchestrator --exit-status --interval 60
```

The first build job to finish creates the GitHub Release (non-draft,
non-prerelease for a stable build); the other matrix jobs' `gh release
create` calls harmlessly no-op ("already exists"). Each job then uploads its
signed bundle + `.sig` sidecar with `--clobber`. The fan-in `manifest` job
downloads every asset, runs `scripts/tauri-manifest.mjs` to build the
tauri-plugin-updater manifest (`latest.json` for a stable release), and
uploads it to the same release.

### 4. Attach release notes

The release is created with a placeholder body ("Tauri desktop build for
<tag>."). Generate the standard What's Changed / New Contributors / Full
Changelog body and attach it:

```bash
gh api repos/AgentWrapper/agent-orchestrator/releases/generate-notes \
  -f tag_name=desktop-tauri-vX.Y.Z -f previous_tag_name=desktop-tauri-v<last-stable> --jq '.body' > /tmp/notes.md
gh release edit desktop-tauri-vX.Y.Z -R AgentWrapper/agent-orchestrator --notes-file /tmp/notes.md
```

### 5. Verify

```bash
# published, not draft/prerelease:
gh release view desktop-tauri-vX.Y.Z -R AgentWrapper/agent-orchestrator \
  --json isDraft,isPrerelease,assets --jq '{isDraft,isPrerelease,count:(.assets|length)}'
# updater manifest carries the new version:
gh release download desktop-tauri-vX.Y.Z -R AgentWrapper/agent-orchestrator -p latest.json -O - | jq '.version'
```

Expected assets per stable release: one signed updater bundle + `.sig` per
platform (macOS `.app.tar.gz`, Windows `.nsis.zip` or `.msi.zip`, Linux
`.AppImage.tar.gz`, each with a sibling `.sig`), plus the `latest.json`
updater manifest. Unlike the old electron-forge pipeline this does NOT publish
version-free alias assets (`agent-orchestrator-darwin-arm64.zip`,
`agent-orchestrator-linux-x64.AppImage`, etc.). **`ao start` /
`backend/internal/cli/start.go` still fetches those old electron-builder
alias names from the retired pipeline and has not been repointed at this
release's assets** — flagged here for the team to decide on, not changed by
this doc update.

If a platform leg fails, re-run the failed job from the Actions UI; the
upload steps use `--clobber`, so re-runs replace assets safely.

## Who can approve releases

Approval is governed by required reviewers on the `release` environment
(repo Settings > Environments > release) — the same gate the retired Electron
pipeline used. Readable by anyone with repo access:

```bash
gh api repos/AgentWrapper/agent-orchestrator/environments/release \
  --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login'
```

Anyone with write access can push a `desktop-tauri-v*` tag, but the build jobs
stay in `waiting` until an approver above approves the run. Repo admins can
bypass the gate.

## Fork test releases (dev loop)

Test releases go to the fork, never to AgentWrapper: push a
`desktop-tauri-v*` tag to the fork, or run `tauri-release.yml` via
`workflow_dispatch` from the fork's Actions tab. `AO_RELEASE_REPO` is derived
from `github.repository`, so a fork run publishes to the fork with no source
edit.

## Signing infrastructure (reference)

- **macOS signing + notarization** is driven by the same secrets the
  retired Electron pipeline used (`CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`), consumed by `.github/actions/macos-signing-setup`,
  which remaps them to Tauri's expected env vars
  (`APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY`/
  `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`).
- **Updater signing** is new for Tauri: `TAURI_SIGNING_PRIVATE_KEY` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (a minisign keypair from `tauri signer
  generate`) sign every bundle; the matching public key is injected from the
  `TAURI_UPDATER_PUBKEY` secret at build time, replacing the throwaway
  placeholder pubkey committed in `tauri.conf.json` (which cannot verify a
  real signature — the build fails fast if the secret is unset).
- Windows code-signing is still a follow-up, same as it was under Electron.

---

## Feature releases

A **feature release** is a signed, installable build of a single **unmerged**
PR, cut manually so the PR can be dogfooded or demoed in isolation. Cut via
`workflow_dispatch` on `tauri-release.yml` with a `pr` input (same workflow as
stable releases, not a separate one). It is not for merged PRs.

### What it is and when to cut one

|                       |                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Use when**          | You want to share or test a specific PR before it merges.                                                            |
| **Do not use when**   | The PR is already merged.                                                                                             |
| **Channel isolation** | Builds publish an isolated `pr<N>.json` manifest only; `latest.json` is never written for a feature build.           |

### Cutting a build

1. Go to **Actions > Tauri desktop release** and click **Run workflow**.
2. Fill in the inputs:

   | Input        | Required | Description                                                                        |
   | ------------ | -------- | ----------------------------------------------------------------------------------- |
   | `pr`         | Yes      | PR number to build. Must be open at dispatch time.                                  |
   | `slug`       | No       | Short display label (e.g. `fix-crash`). Display-only; never in the version or tag.   |
   | `allow_fork` | No       | Set to `true` to build a cross-repository (fork) PR. Off by default.                |

3. Dispatch the workflow. The `guard` job runs first (no secrets, inspectable) and:
   - Fails fast if 5 feature releases are already active ("retire one first").
   - Confirms the PR is open; rejects fork PRs unless `allow_fork=true`.
   - Computes the version from `frontend/package.json` at the PR head:
     `<base>-pr<N>.<UTCts>+<sha>` (tag: `v<base>-pr<N>.<ts>`).

4. The build-matrix jobs then pause for **environment approval** (the same
   `release` environment required-reviewer gate as the stable release).

   **Security rule: the approver must inspect the PR's head SHA before
   approving.** These jobs check out and build unmerged code with access to
   the signing secrets. Every dispatch is a fresh approval. Fork PRs require
   `allow_fork=true` to even reach this gate.

5. After approval each platform builds, signs (macOS notarized, updater
   bundles minisign-signed), and uploads to the release; the first job to
   finish also deletes any prior release for the same PR ("one live build per
   PR"), publishes the prerelease, and annotates it with the marker:
   ```
   <!-- ao-feature-build: {"pr":<N>,"sha":"<sha>","slug":"<slug>"} -->
   ```
   The release name is set to `[feature] PR #<N>: <title>`. The fan-in job
   then generates and uploads `pr-<N>.json`.

### Lifecycle and limits — gap flagged for the team

The retired Electron pipeline had a dedicated `feature-release-cleanup.yml`
workflow (immediate cleanup on `pull_request: closed`, plus a daily cron
sweep for builds older than 7 days). **That workflow was deleted in M7 and
has no Tauri equivalent yet.** `tauri-release.yml` only deletes a PR's
*prior* build when a *new* build for the same PR is cut ("one live build per
PR"); a feature build for a PR that is simply closed/merged, or one that
just ages out past 7 days without a rebuild, is not automatically retired.
Until this is addressed, retire stale feature releases manually:

```bash
gh release delete <tag> -R AgentWrapper/agent-orchestrator --cleanup-tag --yes
```

### How users consume feature releases

Unchanged from the Electron-era UX: Feature Releases is gated behind
**Developer Mode** (off by default) in **Settings > Updates**. Enabling it
surfaces a **Feature Releases** channel with a dropdown of currently live
builds; picking one pins that PR's channel without disturbing the user's
Stable/Nightly home choice, and "Return home" reverts to it.
