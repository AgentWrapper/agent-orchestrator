# Fleet pause/resume switch (web + CLI) with drain semantics — design

Tracks GH #161. Backend/daemon change → **vanilla rule** applies: upstream-shaped,
upstream PR opened regardless; touches sensitive paths, so the merge parks for a human.

## Problem

There is no first-class way to turn the fleet off and back on. The 2026-07-08 pause
was done by blanking `trackerIntake` on every project and disabling a service by hand —
which destroys stored config, leaves no marker distinguishing "paused" from "broken",
and does nothing about in-flight workers. We need a switch: CLI + web toggle, with
well-defined stop semantics and a resume that restores exactly the prior behavior.

## Resolved design decisions (with Nick, 2026-07-10)

1. **Global pause is a distinct daemon-global flag**, not an "all projects paused" fan-out.
   A new project registered while the fleet is paused starts paused, because enforcement
   reads the global flag directly rather than a per-project bit that was never set.
2. **Slack/alerts stay on during pause.** Non-critical notifications are not suppressed.
   (Note: there is no Slack integration in the backend today; the dashboard notification
   stream is the only alert surface, and pause does not touch it.)
3. **Orchestrators are kept alive and told to idle** once the drain completes on a plain
   (non-`--hard`) pause. `--hard --all` is the separate emergency-teardown path.

## Core principle: pause is a bit, not config surgery

`paused` is persisted **independently of `ProjectConfig`** so that pausing then resuming
leaves the project config byte-identical (AC-1). Concretely:

- Per-project: a dedicated `paused` column on the `projects` table, surfaced as
  `ProjectRecord.Paused` — **not** a field on `ProjectConfig` (which round-trips through a
  single JSON blob that collapses to SQL NULL when zero and is wiped by `set-config --clear`).
- Fleet-global: a new single-row `daemon_settings` table (there is no daemon-global
  persisted store today) holding `fleet_paused`.

Resume = flip the bit back. Nothing else in config is touched.

## Enforcement model (two-layer stop, default = drain)

1. **Intake gate — immediate.** The `trackerintake` observer `Poll` skips a project when
   `fleetPaused || project.Paused`, from the next tick. No new issues dispatched, config
   preserved. A fleet-paused daemon short-circuits the whole tick, so newly-registered
   projects never get dispatched either.
2. **Spawn guard — authoritative.** `session/Service.Spawn` (every spawn path funnels
   through it: CLI, HTTP, intake) rejects with a typed `PROJECT_PAUSED` conflict when
   `fleetPaused || project.Paused` and `!Force`. `ao spawn --force` (→ `SpawnConfig.Force`)
   overrides for deliberate manual spawns.
3. **In-flight workers — run to completion (default).** Not killed. A **drain sweeper**
   (new component, reaper-cadence tick) terminates a paused project's workers **only** as
   each reaches a terminal/idle state: `deriveStatus(rec, prs) ∈ {terminated, merged, idle}`
   (i.e. `IsTerminated`, or no open PR and not active and not needs-input). It calls the
   existing clean `session Manager.Kill` (which does `runtime.Destroy` → no zombie tmux).
   We deliberately keep the **reaper fact-only** (its documented contract) and put drain in
   a separate sweeper rather than injecting a terminate capability into the reaper.
4. **`--hard`** (emergencies): terminate all of a paused project's workers immediately via
   the existing `Kill`/`TeardownProject` path; `--hard --all` includes orchestrators.
5. **Orchestrators.** On pause, the daemon sends live orchestrators a "fleet paused —
   finish in-flight work, spawn nothing new" message (`session Service.Send`). The 30s
   ensure-loop keeps existing orchestrators alive but must **not** treat pause as a reason
   to (re)spawn a fresh orchestrator for a drained paused project.

## Observable state

`running → draining (N workers finishing) → paused`, computed from the paused bit plus the
live worker count (`worker_capacity` already tracks `ActiveWorkers`). Surfaced in:

- `GET /api/v1/projects` — a `state` (+ `paused`) field on `project.Summary`.
- `ao status` (global banner) and `ao project ls` (STATE column) / `ao project get`.
- Web: per-project toggle on the sidebar + a global switch; paused/draining visual state.
- A **drain-complete notification** (new `NotificationDrainComplete` type via
  `notify.Manager`) when a paused project reaches zero live workers.

## Phase plan

| Phase                               | Scope                                                                                                                                                                                       | Sensitive?               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **0 — Persistence**                 | migration `0036` (project `paused` col + `daemon_settings` table); sqlc queries + regen; `ProjectRecord.Paused`; store `SetProjectPaused` / `Get`+`SetFleetPaused`. **No behavior change.** | storage                  |
| **1 — Enforcement**                 | `SpawnConfig.Force`; `Service.Spawn` pause guard (typed `PROJECT_PAUSED`); intake `Poll` skip + fleet short-circuit.                                                                        | session_manager, observe |
| **2 — API + state**                 | project `Pause`/`Resume` + fleet pause/resume; `state`/`paused` on `Summary`/`Project`; HTTP endpoints; OpenAPI regen (`go generate` + `npm run api:ts`).                                   | httpd                    |
| **3 — CLI**                         | `ao pause [project\|--all] [--hard]`, `ao resume`; `ao project ls/get` state; `ao status` banner; `ao spawn --force`.                                                                       | cli                      |
| **4 — Drain + supervisor + notify** | drain sweeper (terminal/idle Kill); `--hard`/`--hard --all`; supervisor pause-awareness + "fleet paused" Send; `NotificationDrainComplete`.                                                 | **daemon, lifecycle**    |
| **5 — Frontend**                    | thread `paused`/state through `useWorkspaceQuery`→`WorkspaceSummary`; per-project toggle (Sidebar) + global switch (GlobalSettingsForm); visual state; drive-the-UI verification.           | frontend (ours)          |

Phases 1 and 4 touch sensitive paths → opt-in `phase-review`. The whole feature parks for
human merge regardless (sensitive paths + `POLYPOWERS_AUTOMERGE` unset).

## Test strategy (TDD, failing test first each phase)

- **AC pause↔config identity:** store test asserts the `config` JSON blob is byte-identical
  across pause→resume (the headline AC).
- **AC intake:** observer test — paused project dispatches nothing next tick; unpaused peer
  still dispatches; running workers untouched.
- **AC spawn rejection:** `Service.Spawn` returns `PROJECT_PAUSED` for paused (project or
  fleet), succeeds with `Force`.
- **AC drain vs hard:** drain sweeper terminates only terminal/idle workers, leaves
  mid-PR/active/needs-input alone; `--hard` terminates immediately; both leave sessions
  cleanly terminated (assert `runtime.Destroy` called → no zombie).
- **AC state:** `running→draining→paused` transitions with a live count; drain-complete
  emits a notification.
- **AC supervisor:** ensure-loop skips respawn for a drained paused project; manual spawn
  rejected; live orchestrator receives the paused message.
- **AC fleet-global:** a project registered while fleet-paused is treated as paused.
- **Frontend:** component tests for the toggles + a driven-UI visual check (screenshot).

## Upstream (vanilla rule)

Backend slice is upstream-shaped; an upstream PR is opened against the ao upstream repo
regardless of local merge (we carry the delta), mirroring the per-session `--model` and
codex-fugu adapter patterns. Frontend (browser-mode web surface) is ours and does not gate
on upstream.
