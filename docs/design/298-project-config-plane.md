# Project config plane — design (issue #298)

Status: accepted (2026-07-12)
Issue: [#298](https://github.com/polymath-ventures/agent-orchestrator/issues/298)

This is the durable design artifact for #298. The ticket consolidates seven root
causes across the project-config surface. This document records the decisions the
ticket left open, the evidence behind them, and the sequence the work lands in.

Every `file:line` below was verified against `7de537385`.

## Corrections to the ticket's premises

Four investigations re-verified the ticket against code and the live daemon. Three
premises did not survive; the design is built on the corrected picture.

### C1 — The worktree teardown failure is inverted on a nickified host

The ticket says AO's un-forced `git worktree remove` refuses on a dirty worktree,
so the AO worktree leaks forever. On this machine the opposite happens, and the
result is worse.

`.git/info/exclude` lives in the git **common dir**, which every linked worktree
shares. Verified from inside an AO worktree:

```
$ git -C ~/.ao/data/worktrees/agent-orchestrator/agent-orchestrator-6 \
      check-ignore -v .claude/worktrees/foo
/home/orchestrator/agent-orchestrator/.git/info/exclude:11:**/.claude/worktrees/
```

So an agent-created inner worktree is invisible to `git status --porcelain`. AO's
dirty probe (`isDirty`, `adapters/workspace/gitworktree/workspace.go:914`) reports
**clean**, the un-forced remove **succeeds**, and the agent's inner worktree —
including all uncommitted work — is **silently deleted**. The `ErrWorkspaceDirty`
guard (`commands.go:21-25`) is bypassed precisely because the directory was hidden
from git.

Both branches were reproduced in a throwaway repo:

| `.git/info/exclude`      | `status --porcelain` | `worktree remove` | Outcome                  |
| ------------------------ | -------------------- | ----------------- | ------------------------ |
| present (this host)      | empty → "clean"      | exit 0            | **agent's work deleted** |
| absent (fresh clone, CI) | `?? .claude/`        | exit 128          | AO worktree **leaks**    |

The ticket describes row 2. This fleet runs row 1. Fixing either without the other
just arms the other, so the tracked-ignore change and the teardown change must land
together.

The preserve subsystem has the same hole: `StashUncommitted`
(`workspace.go:424-529`) uses `git add -A` (`commands.go:56-58`), which skips
excluded paths — it says so at `workspace.go:419-420`. The one mechanism built to
protect agent work is blind to the directory agents keep their work in.

None of this fires today: all four projects are `in-place`, where `Destroy` /
`ForceDestroy` / `StashUncommitted` are no-ops (`workspace.go:321-325, 381-384,
425-430`). But the **code default is `worktree`** (`domain/projectconfig.go:151`) —
a new project that configures nothing takes the dangerous mode.

### C2 — agent-vault is no longer broken

The ticket's driving incident is repaired. All four live projects now carry a full
config of the same shape. The R1/R2 bug classes are real; there is no live fire.

### C3 — `ports.AgentModelCatalog` is already wired, and a real catalog is achievable

`service/agent/service.go:483-497` already type-asserts the port, prefers it, and
falls back to the Go switch only when no adapter implements it. There is even a
`ModelCatalogSource` enum (`:70-75`) distinguishing `adapter` / `known-set`. Nothing
implements the port, so the switch is live purely by fallback. **This is an
adapter-only change** — the service plumbing exists and is waiting.

The ticket doubted a machine-readable model list existed. It does:
`codex app-server` exposes JSON-RPC `model/list`. Called live it returned exactly
the interactive picker's ground truth (7 models, `gpt-5.6-sol` flagged default) in
~0.35s, **offline** (re-verified with the network blocked). It is cheaper than the
model prober the same HTTP handler already calls.

`codex-fugu` is a bash wrapper that `exec`s the real codex with `-p fugu`, and
`--profile` is rejected by `app-server`. Its catalog is still reachable by reading
the profile's own `model_catalog_json` (`$CODEX_HOME/fugu.config.toml` →
`~/.codex/fugu.json`, declaring `fugu` and `fugu-ultra`).

`claude` has **no** model enumeration at any layer. It can render a _verdict_
(`claude -p --model <m>` gives a clean exit-code split with a parseable rejection),
so it can have a validator but never a catalog.

### C4 — A strict `Spawnable()` gate would fail all four projects

Every live project has `prime: {agentConfig:{}}` with no harness. A gate requiring
`prime.agent` would reject **all four** configs on write, locking the config editor
fleet-wide. This is the migration trap AC2 did not account for.

## Decisions

### D1 (AC3) — Optimistic concurrency, not PATCH

**Decision: content-ETag + compare-and-swap. Reject PATCH.**

A true PATCH is **not expressible against the current struct**. Every field of
`ProjectConfig` (`domain/projectconfig.go:50-102`) is a value type — there are two
pointers in the entire config tree. With `omitempty`, "unset" and "explicitly
cleared" are byte-identical on the wire for ~20 fields, including `autonomousMerge`
(`:101`), the merge-authority bit.

The existing `trackerIntake.enabled` guard is the proof: recovering absent-vs-false
for **one** field required a hand-rolled second shadow parse of the raw body
(`httpd/controllers/projects.go:256-281`). That does not scale to 20 fields.

The decisive objection: PATCH semantics **invert the contract
`ops/project-config.mjs apply` depends on**. That script is the documented recovery
path; its job is converging live config to the committed spec, which requires that
omitting a field _removes_ it. Under PATCH, `check` → `apply` stops being a closed
loop. PATCH also does not solve the stated problem — two concurrent PATCHes on the
same field still last-write-wins.

Optimistic concurrency is both cheaper and more correct:

- The persisted config is a single deterministic JSON blob
  (`storage/sqlite/store/project_store.go:197-206`), so hashing it yields an ETag.
- CAS is a service-level compare against the stored content hash followed by a
  narrow config-column update, **not a schema change**. Zero goose migrations —
  which matters, because the highest migration on disk is `0046` and a new
  column would claim `0047` and race any other in-flight PR (the known
  migration-collision class).
- Replace semantics are **preserved**, so `ops/project-config.mjs` keeps working
  unchanged. Blind-replace writers send `If-Match: *` to opt out deliberately.
- It subsumes the one-off `trackerIntake.enabled` guard: the wipe that guard
  defends against _is_ a stale write.

If field-level PATCH is ever wanted, it is an ergonomic addition **on top of**
optimistic concurrency — never instead of it.

### D2 (AC2) — `Spawnable()` is role-scoped, and `prime` is exempt

Tracing `Manager.Spawn` (`session_manager/manager.go:414`) the true minimum runnable
set is **two** fields, and both are role-scoped and harness-conditional:

1. **A resolvable harness for the role** — `manager.go:468-470`; empty →
   `ErrMissingHarness` (`:45-47`). A non-empty `workerMix` satisfies this for the
   worker role (`:444-464` assigns the harness first).
2. **A permission mode, but only for claude-provider harnesses.** This asymmetry
   explains the original incident. Codex maps an empty mode to
   `--dangerously-bypass-approvals-and-sandbox` explicitly (`codex.go:650-655`).
   claude-code emits **no** `--permission-mode` flag and defers to
   `~/.claude/settings.json`, where `defaultMode` is **unset** on this box — so an
   unattended claude-code worker blocks on its first approval prompt. That is why
   agent-vault looked like a hang, not an error.

Everything else degrades to a working default. `Spawnable(kind)` is therefore
evaluated **per role, only for roles that can actually be spawned**. Per C4, a
blanket all-roles gate would reject every live config.

The gate is evaluated on the **result of the merge**, not on the request delta, so
the two real client surfaces (which both send a full merged object) keep working.

### D3 (AC1) — Defaults move to the daemon, at the existing chokepoint

Both write paths already funnel through `service/project/service.go` —
`Service.Add` (`:202`) and `Service.SetConfig` (`:565`) — and both already call
`validateProjectConfig`. The precedent for a write-side default is already there:
`Add` detects and persists the repo's real default branch (`:294-298`).

Defaults are applied at `Add`. `WithDefaults()` **stays** as a read-side overlay —
it is still load-bearing for unregistered projects with live sessions
(`manager.go:721-728` returns a zero record), for legacy rows, and for the
`wakeInterval` / `trackerIntake` folds. It becomes belt-and-braces rather than the
only line of defense.

Standard defaults, all confirmed canonical by live probe:

| Setting                      | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| `agentConfig.permissions`    | `bypass-permissions`                               |
| Orchestrator harness / model | `claude-code` / `opus`                             |
| Worker harness / model       | `codex` / `gpt-5.5`                                |
| Reviewer harness             | `codex-fugu` (concrete, cross-family; requires D4) |
| `env.POLYPOWERS_REPO`        | derived from the git remote at registration        |
| `workspace`                  | **`in-place`** — see D5                            |
| `defaultBranch`              | resolved from the repo                             |

### D4 (AC7) — Reviewer: type and config only

Scoped to fixing the type and the config, **not** wiring a trigger. Nothing in the
daemon calls the native review path — the only caller of `Svc.Trigger` is the HTTP
handler (`httpd/controllers/reviews.go:97`). Every real review on this fleet goes
through the skills-layer `/final-review`. Widening the type fixes a trap, not a live
system, and pretending otherwise would justify a much larger change than the value
supports.

In scope:

- Widen `ReviewerHarness` → `AgentHarness` so `codex-fugu` — 27% of the mix and the
  designated cross-family reviewer — becomes selectable at all. **No migration**:
  neither `review.harness` nor `review_run.harness` carries a CHECK constraint
  (`migrations/0012_add_review_tables.sql:12,27`), and the config side is an
  unconstrained string in an untyped JSON blob.
- Add `AgentConfig` to `ReviewerConfig` (`domain/projectconfig.go:107-109`).
  Today the reviewer adapters leave `LaunchConfig.Config` at its zero value, so the
  reviewer runs on the **account-default model** — which for claude-code on this
  account is `fable`, which our own standing rule forbids for AO-spawned sessions.
  This is an independent defect on the same surface.
- Wire the existing `AgentHarness.ModelProvider()` (`domain/harness.go:60-71`) into
  `reviewerHarness()` (`review/review.go:542-552`) to refuse a same-family reviewer.
  **`ProviderUnknown` must be special-cased as "unclassified, do not block"** —
  it is the zero value for the 21 unmapped harnesses, so a naive `!=` would treat
  two different unknown harnesses as the same family.
- Remove the `"Project default"` sentinel from the UI. It is a frontend-only value
  (`ProjectSettingsForm.tsx:849`) that saves `reviewers: undefined`, which resolves
  to **the worker's own harness** — i.e. it is the control that _selects_
  same-family self-review. All four projects are on it today by omission.

### D5 (AC8) — Worktree fix order; keep `in-place` until the fix soaks

Order (out of order is the failure):

1. **Commit the ignore.** `.claude/worktrees/` moves into the tracked `.gitignore`.
   Per C1 this is not cosmetic — it makes teardown behavior deterministic across
   hosts instead of depending on whether nickify has run.
2. **Make the recipe cwd-independent.** The canonical anchor:

   ```sh
   MAIN_ROOT="$(git worktree list --porcelain | head -1 | sed 's|^worktree ||')"
   ```

   `git worktree list` always lists the main worktree first, from any linked
   worktree, and returns an absolute path. Two traps this avoids: bare
   `--git-common-dir` returns the _relative_ string `.git` in the main checkout but
   an absolute path in a linked worktree (use `--path-format=absolute` if you must
   use it at all), and `--show-toplevel` is the **wrong anchor** — it returns the
   _current_ worktree's root, which is exactly the cwd-dependence being eliminated.

   Both the `-C` and the destination path must be anchored to `MAIN_ROOT`, so the
   inner worktree lands in the main checkout no matter where the agent's cwd is.
   This satisfies CLAUDE.md rule 2's "never inside another worktree" clause
   _mechanically_ rather than by agent discipline — which is what actually failed.

3. **Make AO notice, then handle it.** The dirty probe must detect a _registered
   inner worktree_ (not `--ignored`, which would make any worktree with
   `node_modules/` look permanently dirty and deadlock cleanup). Then teardown
   captures inner worktrees via `StashUncommitted` and force-removes **only** paths
   it has already captured — the invariant `commands.go:30-33` already licenses.

   Adding a blanket `--force` to `Destroy` is **rejected**: AO does not know whether
   the work was pushed (nothing in the `Destroy` path consults a remote, an upstream
   ref, or PR state), so it would be unconditional, unrecoverable data loss.

4. **Only then** consider flipping the default.

**The default stays `in-place`** and becomes an _explicit_ daemon-side default
(D3), so a new project cannot silently take the dangerous mode. Flipping to
worktree is revisited after the teardown fix is deployed and has soaked.

### D6 (AC5) — Dynamic catalog for codex, declarative for claude-code

Per C3, AC5's hedge is retired. The split:

- **codex** — implement `AvailableModels` via `codex app-server` JSON-RPC
  `initialize` → `initialized` → `model/list` with `includeHidden: false`.
- **codex-fugu** — read the profile's `model_catalog_json` directly (no subprocess;
  does not depend on the wrapper's `-p` semantics, which `app-server` rejects).
- **claude-code** — declarative list. No CLI surface to query exists. It gets an
  `AgentModelValidator` instead (AC4).

Copy the `ValidateModel` discipline (`codex.go:257-278`): process-group isolation
and `WaitDelay` (codex is a Node shim that spawns a vendored binary; killing the
shim leaves the grandchild holding the stderr pipe), and — critically — **a failed
catalog call must return an error so the service falls back**, never an
empty-but-successful list. An empty success would present a config surface as
having no models, which is the #182 class.

The hardcoded switch (`service/agent/service.go:556-567`) is wrong on **every**
codex line — it advertises three `*-codex` models that do not exist and omits
`fugu`, which is fugu's own default. Fix it regardless, since it remains the
fallback.

### D7 (AC4/AC12) — Model is per-harness; the scalar dies with a migration

Per the operator amendment: a model name is only meaningful relative to a harness.
The backend **already has this** — `AgentConfig.ModelByHarness`
(`domain/agentconfig.go:99-104`) is validated for provider compatibility (`:126-139`)
and already outranks the scalar at spawn (`agentconfig/resolve.go:40-66`). It has
**zero writers**: no CLI flag, no UI control. The correct representation exists and
has no front door; the broken one is what the UI exposes.

The scalar is already half-dead in practice: agent-orchestrator's
`worker.agentConfig.model = "gpt-5.5"` only survives because the provider gate drops
it for the claude-code mix bucket, which gets `opus` from `workerMix`. **The mix has
been doing per-harness models all along.**

**Removal requires a data migration.** All four projects pin their models through
the scalar. Dropping the field bare would silently un-pin every model in the fleet:
claude-code roles survive (`DefaultModelForHarness` → `opus`), but **codex workers
do not** — it returns `""` for every non-claude harness, so they would fall through
to the account default. The migration rewrites each scalar into
`ModelByHarness[<that role's harness>]`.

## Sequencing

Four PRs. Each is independently reviewable and revertible; each touches sensitive
paths (`backend/internal/daemon/**`, `session_manager/**`), so each **parks for a
human** regardless of gate state.

| PR                       | Scope                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — write safety**    | ETag + CAS (D1), `Spawnable()` (D2), daemon-side defaults (D3), field validation (`defaultBranch`, `env` keys, `projectPrefix` cap), the `config.DefaultAgent` read-model lie, the SCM-observer config clobber |
| **P2 — model plane**     | Dynamic catalog (D6), per-harness model table in UI + CLI (D7), scalar-`Model` migration, claude-code validator, loud catalog failures (AC6)                                                                   |
| **P3 — reviewer**        | Widen the type, add `AgentConfig`, cross-family refusal, drop the sentinel (D4)                                                                                                                                |
| **P4 — worktree safety** | Tracked ignore, cwd-independent recipe, dirty probe, capture-then-force teardown (D5)                                                                                                                          |

The reap of the 81 accumulated worktrees is **deliberately not in scope** — see
below.

## Deliberately out of scope

- **Reaping the 81 accumulated worktrees.** Filed as a sequenced follow-up. It is an
  irreversible bulk mutation of shared state that other agents are working in right
  now, and finding #68 records this exact accident (`ao session cleanup -y` deleting
  a live orchestrator's own cwd). **13 of them hold uncommitted work**, two with
  7-8 modified tracked files of substantive unpushed work. It is also premature:
  reaping before the fix lands just clears ground that refills at ~13/day.

  A warning for whoever writes that reaper: **`git merge-base --is-ancestor` is a
  broken merged-test on this repo.** Main is protected by a _squash_ merge queue, so
  a merged branch is never an ancestor of main — ancestry reports "not merged" for
  essentially every branch, including long-merged ones. The correct classifier is
  process-cwd (`/proc/*/cwd`, which positively identifies a live agent) +
  `git status --porcelain` + GitHub PR state.

- **Wiring a native review trigger** (D4).
- **Pause state** — verified safe by the ticket (A3); `UpsertProject` deliberately
  omits `paused` from its `ON CONFLICT DO UPDATE` set-list. Do not touch.
- **Flipping the workspace default to `worktree`** (D5) — after soak.
