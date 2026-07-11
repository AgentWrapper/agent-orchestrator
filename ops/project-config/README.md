# Config-as-code: project config specs (#250)

Each `<project>.json` here is the committed, clean-boot spec for one ao
project's per-project config — the object returned as `.project.config` by
`ao project get <project> --json`. **The system's clean-boot state is its
specification.** Config is reconstructed from these files, never from
archaeology of a running (possibly-wiped) daemon.

This exists because a July-8 full-replace config wipe deleted
`autonomousMerge`/`POLYPOWERS_AUTOMERGE` and survived three restorations that
each rebuilt config from the observed broken state or memory. With a committed
baseline, restoration is one command and drift is a loud red check.

## Why the ops layer (no daemon change)

Per the repo vanilla rule, config restoration is a workflow need, so the whole
loop wraps the **existing** `ao` CLI — there is no new `ao project apply` or
`ao doctor` command. `ops/project-config.mjs` is a thin wrapper over
`ao project get`/`ao project set-config`.

## Commands

```bash
# Restore a project's config from its committed spec — THE recovery path.
node ops/project-config.mjs apply <project>          # --dry-run to preview

# Detect drift: diff live config against the spec, exit non-zero if it diverges.
node ops/project-config.mjs check <project>
node ops/project-config.mjs check --all              # every committed spec

# Refresh a spec from live after an INTENDED config change (then commit it).
node ops/project-config.mjs capture <project>

node ops/project-config.mjs list
```

`apply` full-replaces the stored config with the spec via
`ao project set-config <project> --config-json …`. `check` compares
structurally (key-order-insensitive, array-order-sensitive) and treats an empty
container as equivalent to an absent one.

## Restoration runbook (post-wipe / post-incident)

1. `node ops/project-config.mjs check --all` — confirm which projects drifted.
2. `node ops/project-config.mjs apply <project>` — restore each drifted project
   from its committed spec.
3. `node ops/project-config.mjs check --all` — confirm clean (exit 0).

## After an intentional config change

Change config the normal way (`ao project set-config …` or the web UI), then
`capture` the new baseline and commit it, so the spec stays the source of truth
and the drift check does not flag your deliberate change:

```bash
node ops/project-config.mjs capture <project>
git add ops/project-config/<project>.json && git commit
```

## Scheduled drift compare (red-check-within-minutes)

`ops/project-config-drift.service` + `ops/project-config-drift.timer` run
`check --all` on a schedule as a systemd **user** service. They are committed
but not auto-installed. To enable:

```bash
mkdir -p ~/.config/systemd/user
cp ops/project-config-drift.service ops/project-config-drift.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now project-config-drift.timer
systemctl --user status project-config-drift.service   # last run + drift output
journalctl --user -u project-config-drift.service       # drift history
```

A drifted run exits non-zero, so `systemctl --user status` and the journal show
the failure and name the diverged fields.

## Secrets are not config

Project `env` is a non-secret forwarding mechanism (e.g. `POLYPOWERS_REPO`).
Because a spec is committed to git and drift output lands in the systemd
journal, config-as-code must never carry a credential:

- `capture` refuses to write a spec whose `env` has a secret-shaped key
  (`*TOKEN`, `*SECRET`, `*PASSWORD`, `GITHUB_PAT`, `DATABASE_URL`, …). Move the
  secret out of project env, or — for a genuine non-secret key that trips the
  heuristic — exempt exactly that key with
  `AO_PROJECT_CONFIG_ALLOW_ENV_KEYS=KEY1,KEY2` (per-key, not a global disable).
- Drift reports redact all `env` values (and any secret-keyed leaf), printing
  only the path and `<redacted>`.

This is best-effort defense-in-depth (a denylist, not an allowlist) — it covers
the real risk without rejecting every future legitimate non-secret var.

## Pause is not config

`paused`/`pauseState` (#161/#212) live as siblings of `.project.config`, never
inside it. The spec cannot manage them and pausing a project can never register
as config drift. This is asserted in `ops/project-config-core.test.mjs`.

## Formatting

These files are one-item-per-line (each array element on its own line) so drift
diffs read cleanly, and are excluded from Prettier (`.prettierignore`) so its
array-collapsing does not fight the generator. Regenerate with `capture`; do not
hand-reflow.
