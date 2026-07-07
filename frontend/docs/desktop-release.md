# Desktop release runbook

How to cut a stable desktop release, end to end. Written from the v0.10.2 cut
(2026-07-04); v0.10.1 followed the same recipe.

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
- On `main`, `frontend/package.json` stays at whatever it last was; nightlies
  stamp the version at build time and stable stamps it on a tag-only commit.
  Do not bump the version on `main` itself.

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

### 2. Create the tag-only stamp commit

The stamp commit bumps `frontend/package.json` to `X.Y.Z` and lives only on
the tag, not on `main`:

```bash
git checkout --detach upstream/main
# edit frontend/package.json: "version": "X.Y.Z"
git add frontend/package.json
git commit -m "chore(release): stamp desktop app version X.Y.Z"
git tag -a desktop-vX.Y.Z -m "Desktop release X.Y.Z: <one-line highlights with PR numbers>"
git checkout -            # get off the detached HEAD; the tag keeps the commit alive
```

### 3. Push the tag (this triggers the release)

```bash
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
