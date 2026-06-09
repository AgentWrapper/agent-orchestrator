---
name: onboarding-test
description: Verify a published @aoagents/ao npm version onboards cleanly (install → ao start → dashboard up → ao stop), fully isolated from any real ao install/runtime on the machine.
trigger: You want to confirm your PR/release does not break first-run onboarding, or to smoke-test a published version before/after a release.
---

# Onboarding Test Skill

Prove that a **published** `@aoagents/ao` version onboards end-to-end on a fresh
machine — `npm install -g` → `ao start` → dashboard serves → `ao stop` — without
touching any real ao install or running daemon on the box.

The whole flow is one script: [`scripts/test-onboarding.sh`](../../scripts/test-onboarding.sh).

## When to use

- Before cutting a release: `--version nightly` (tracks main) should be green.
- After publishing: `--version latest` confirms the released tarball onboards.
- On a machine that already runs ao (your dev box): `--mode coexist` proves the
  test leaves your real daemon, sessions, tmux, and ports untouched.

## Run it

```bash
# Canonical clean onboarding (clean CI / new machine):
scripts/test-onboarding.sh --version latest --mode fresh

# On a machine already running ao — proves ZERO change to the real install:
scripts/test-onboarding.sh --version latest --mode coexist

# A specific published version, or the nightly tag:
scripts/test-onboarding.sh --version 0.9.1 --mode fresh
scripts/test-onboarding.sh --version nightly --mode fresh
```

Exit code `0` = onboarding works. Non-zero = it does not — read the printed step
that failed. Use `--keep` to leave the sandbox in place for debugging, and
`--port N` to pin the dashboard port (otherwise a free one is auto-allocated).

## Testing a branch instead of a release

This harness deliberately tests the **published tarball**, because the bugs it
catches (e.g. a plugin's `dist` requiring a `package.json` that the published
`files` list omits) only exist in the packed artifact — a plain source/branch
build resolves those paths fine and would give a false green. So a branch must
be **published somewhere** first. Two faithful routes:

1. **Merged to `main` — zero setup.** Every commit on main publishes a nightly:
   ```bash
   npm view @aoagents/ao versions          # find 0.x.y-nightly-<sha> for your commit
   scripts/test-onboarding.sh --version 0.x.y-nightly-<sha> --mode fresh
   ```
   That installs and exercises the **real packaged artifact** of that exact
   commit. This is how you confirm a merged fix (e.g. a release retarget) before
   it reaches `latest`.

2. **Unmerged PR branch — throwaway local registry.** Publish the branch's
   packages to [verdaccio](https://verdaccio.org/) and point the harness at it
   with `--registry`:
   ```bash
   npx verdaccio &                         # http://localhost:4873
   pnpm -r publish --registry http://localhost:4873 --no-git-checks
   scripts/test-onboarding.sh --registry http://localhost:4873 \
     --version <the-version-you-published> --mode fresh
   ```
   `--registry` only changes where `npm install` pulls from — every isolation
   guarantee below still holds.

Do **not** try to onboarding-test a branch by `npm link`/source build: it cannot
reproduce packaging bugs, which is the whole point of this harness.

Requirements on the runner: `node`, `npm`, `git`, `curl` (all present on CI and
dev machines). `tmux` is **not** required — the test uses `runtime: process`.

## Two modes

| Mode | Assumes | What it adds |
|------|---------|--------------|
| `fresh` | No existing ao (clean CI / new machine) | Canonical clean onboarding path. |
| `coexist` | Machine already runs ao | Snapshots the **real** `~/.agent-orchestrator/running.json`, `tmux ls`, and listening TCP ports BEFORE and AFTER, then asserts they are byte-for-byte identical. Fails loudly if the test perturbed anything. |

## Isolation guarantees (why it is safe to run next to a live daemon)

The script enforces all of these — it never mutates real state:

- **Temp npm prefix.** `npm install -g --prefix <tmp>`; that `bin/` goes first on
  `PATH`. Real global `node_modules` are never touched.
- **Sandbox `HOME`.** A temp `HOME` means `~/.agent-orchestrator` (running.json,
  last-stop.json, sessions, locks) is a separate tree. The sandbox `ao stop`
  reads only the sandbox `running.json`, so it can only kill the sandbox daemon.
- **Auto-allocated free ports** for the dashboard and both terminal WS servers;
  the script refuses the reserved `3001` / `14800` / `14801`.
- **`runtime: process`**, not tmux — the sandbox shares no tmux server with the
  real ao, so it cannot see or kill real tmux sessions. (This is the
  "dedicated tmux socket *or equivalent*" requirement: process runtime sidesteps
  the shared default tmux socket entirely.)
- **Throwaway git repo** (`git init` + one commit) as the onboarded project.
- **Non-interactive:** `AO_CALLER_TYPE=agent` plus `ao start --no-orchestrator`
  (no LLM key needed — scoped to install + CLI + dashboard-up + clean stop).
- **One temp root**, removed on `trap EXIT` (success, failure, or interrupt):
  graceful sandbox `ao stop --all`, then kill the recorded daemon pid tree, then
  a final `pkill -f <temp-root>` safety net (the path is unique to the run, so it
  can never match the real ao), then `rm -rf` the root.

The env knobs the script sets (verified against `packages/core/src/paths.ts`,
`config.ts`, `global-config.ts`, and `packages/cli/src/lib/running-state.ts`):
`HOME` (controls `~/.agent-orchestrator`), `AO_CONFIG_PATH` + `AO_GLOBAL_CONFIG`
(config location), `AO_CALLER_TYPE=agent` (non-interactive), `PORT` /
`TERMINAL_PORT` / `DIRECT_TERMINAL_PORT` (server ports).

## What it verifies

1. `npm install -g` of the published package succeeds and `ao` resolves to the
   sandbox prefix.
2. `ao --version` runs.
3. `ao start --no-orchestrator` registers `running.json` in the sandbox HOME.
4. The dashboard serves (`GET /api/sessions` → 200) on the sandbox port.
5. `ao stop --all` exits cleanly, the daemon pid dies, `running.json` is removed,
   and the port is released.
6. In `coexist` mode, the real ao snapshot is unchanged.

## CI

This harness is a **local / on-demand** test — run it by hand (or wire it into
your own pipeline). It is intentionally not gated per-PR: a PR's own code is not
yet published, so testing the *published* package belongs after a build is
published (nightly tracks main; a release publishes `latest`), not on the PR.

For per-PR, source-build onboarding coverage see the existing "Test Fresh
Onboarding" job in `.github/workflows/onboarding-test.yml`.

To run it in CI later, a single step suffices on a Node 20 runner with `git` and
`curl` available:

```yaml
- run: bash scripts/test-onboarding.sh --version nightly --mode fresh
```

## Onboarding-test your own PR/version

1. Land your change and let it publish (a `nightly` build of main is published
   automatically; a release publishes `latest`).
2. Run `scripts/test-onboarding.sh --version nightly --mode fresh` (or the exact
   `0.x.y-nightly-<sha>` once you know it from `npm view @aoagents/ao dist-tags`).
3. If you are on a machine with a live ao daemon, prefer `--mode coexist` so you
   also prove your test run did not disturb your working daemon.
4. Green = onboarding intact. Red = read the failing step; `--keep` then inspect
   `<temp-root>/ao-start.log`.
