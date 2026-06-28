# Dashboard Legacy-Migration Popup + `app-state.json` Marker: Design

> **Status:** ready for plan. Grounded against `upstream/main` @ `514946fd8`
> (`feat(cli): ao start fetches + opens the desktop app … (#2201)`) on 2026-06-26.
> Every "current state" claim carries a `file:line` reference.
>
> Builds on the marker concept from the `ao start` bootstrapper spec
> (`docs/ao-start-bootstrapper-and-npm-deprecation.md`, §5). Deferred Settings
> work is tracked in AgentWrapper/agent-orchestrator#2205.

---

## 0. Goal

`ao start` no longer runs the legacy import (it now fetches+opens the desktop
app; the daemon-spawn path and `maybeFirstBootImport` are gone). The spec's §6.4
left an open decision: where does the legacy first-boot import go? This design
answers it: **the desktop app offers the import on launch via a popup, gated on a
persisted `migration` marker in `~/.ao/app-state.json`.** If the user hasn't
migrated (and legacy data exists), the app prompts. The import runs through the
app-owned daemon and is idempotent; legacy files are never modified, so a failed
or declined import loses nothing.

---

## 1. Ground truth (what the code is today)

| Fact                     | Value                                                                                                    | Source                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Marker file              | `~/.ao/app-state.json`, **app is sole writer**, written every launch                                     | `frontend/src/main/app-state.ts`; spec §5, invariant 3     |
| Marker fields today      | `schemaVersion, appPath, version, installedAt, lastReconciledAt, installSource`                          | `frontend/src/main/app-state.ts` `AppStateMarker`          |
| Marker write call site   | `app.whenReady()` before `createWindow()`                                                                | `frontend/src/main.ts:859` (inside `whenReady`, `:868`)    |
| Go reader of marker      | read-only, ignores unknown JSON fields, does NOT gate on `schemaVersion`                                 | `backend/internal/cli/start.go` `appState` struct (~`:38`) |
| Import engine            | `internal/legacyimport` (projects + per-project settings + orchestrator + transcripts) + `ao import` CLI | present from #314                                          |
| Import **daemon API**    | **does not exist on main** (no `service/importer`, no `httpd/controllers/imports.go`)                    | verified                                                   |
| Daemon ownership         | the app spawns + owns the daemon                                                                         | `frontend/src/main.ts` `startDaemon`                       |
| HTTP client (renderer)   | `apiClient` over the daemon loopback API                                                                 | `frontend/src/renderer/lib/api-client.ts:81`               |
| IPC bridge               | `contextBridge.exposeInMainWorld("ao", api)`; renderer calls `window.ao.<ns>.*`                          | `frontend/src/preload.ts:73`                               |
| IPC handler pattern      | `ipcMain.handle("<ns>:<action>", …)` in main                                                             | `frontend/src/main.ts:773-796`                             |
| Dashboard route          | `_shell.index.tsx` (the board)                                                                           | `frontend/src/renderer/routes/`                            |
| **Global Settings page** | **none** — only per-project `_shell.projects.$projectId_.settings.tsx`                                   | verified                                                   |

---

## 2. Decisions locked

1. **Approach A:** daemon import API (detect + run) + app-side marker. The
   renderer uses `apiClient`; the app stores only the decision in
   `app-state.json`. (User-approved.)
2. **App is the sole writer of `app-state.json`** (invariant 3); the **daemon is
   the sole writer of the DB**. The import runs through the daemon; the app
   records the marker.
3. **Import scope = projects + per-project settings only** (no orchestrator
   sessions, no transcripts). The daemon API is the projects-only engine from the
   import-offer plan (`docs/plans/2026-06-26-import-offer.md`).
4. **Popup actions:** **Proceed** (run), **Skip** (re-prompt next launch),
   **Don't Migrate** (red; permanently declines). Small print points to a future
   Settings redo path.
5. **Settings "Migration" section is deferred** to AgentWrapper/agent-orchestrator#2205.
   v1 ships the popup only. Until #2205 lands, `declined` is effectively
   permanent, so v1 copy must NOT promise a working Settings path (see §6).

---

## 3. Scope

**In scope:**

- Backend: the projects-only import daemon API: `GET /api/v1/import` (availability)
  and `POST /api/v1/import` (run), plus `service/importer`, DTOs, OpenAPI regen.
  (= the import-offer plan, with the status-semantics tweak in §5.2.)
- App marker: add a `migration` block to `app-state.json` (`schemaVersion` → 2),
  preserved across launches; an IPC getter/setter.
- Renderer: a launch-time `MigrationPopup` gated on (marker not terminal) AND
  (daemon reports legacy data available); the three-action UX; failure
  reassurance.

**Out of scope (deferred / separate):**

- Global Settings page + the Migration section / redo entry point → #2205.
- The engine simplification details themselves live in the import-offer plan; this
  design consumes that API, it does not re-specify the engine internals.
- Track B (signing/auto-update) and anything in the bootstrapper spec's out-of-scope.

---

## 4. Invariants (load-bearing)

1. **Filesystem/DB is the source of truth; the marker is a hint.** A `completed`
   marker is never trusted to mean the rows exist; re-running is always safe
   (idempotent engine). (Mirrors bootstrapper invariant 2.)
2. **App is the sole writer of `app-state.json`.** The renderer never writes it
   directly; it goes through the main process over IPC.
3. **The import never deletes or modifies legacy files.** This is what makes a
   failed/declined import lossless, and it is the promise the failure copy makes.
4. **The import is idempotent.** Existing rows are skipped, so Skip-then-Proceed,
   double-clicks, and Settings re-runs never duplicate or clobber.

---

## 5. Backend: the import daemon API

### 5.1 Surface (from the import-offer plan)

- `GET /api/v1/import` → `{ available: bool, legacyRoot: string }`.
- `POST /api/v1/import` → `{ report: { dryRun, projectsImported, projectsSkipped, notes? } }`.
- `internal/service/importer` wraps `legacyimport` (projects-only); wired into
  `daemon.go` as `Import: importsvc.New(importsvc.Deps{Store: store})`.
- A nil service answers OpenAPI-backed `501`. OpenAPI + `schema.ts` regenerated.

### 5.2 Status semantics (the one change vs the import-offer plan)

The import-offer plan computed `available = HasLegacyData(root) && len(projects)==0`
(the empty-DB heuristic). **Here the marker governs whether to prompt**, so the DB
heuristic is redundant and can be wrong (a user who added projects but never
imported legacy still has legacy data). Define:

```
available = legacyimport.HasLegacyData(root)
```

The "already decided / don't nag" logic moves entirely to the app marker;
idempotency keeps a re-run safe regardless of DB contents.

---

## 6. App marker: `migration` block in `app-state.json`

Bump `SCHEMA_VERSION` to `2` and extend `AppStateMarker`
(`frontend/src/main/app-state.ts`):

```ts
export type MigrationStatus = "pending" | "completed" | "declined" | "failed";

export interface MigrationState {
	status: MigrationStatus; // absent file => treated as "pending"
	lastAttemptAt?: string; // last Proceed attempt (success or failure)
	completedAt?: string; // set when status -> completed
	report?: { projectsImported: number; projectsSkipped: number };
	error?: string; // last failure message (status === "failed")
}

export interface AppStateMarker {
	schemaVersion: number;
	appPath: string;
	version: string;
	installedAt: string;
	lastReconciledAt: string;
	installSource: string;
	migration?: MigrationState; // new; preserved across launches
}
```

- **Preservation:** the launch-time `writeAppStateMarker` must carry an existing
  `migration` block through untouched (the same way it preserves `installedAt` /
  `installSource`). It never sets `migration` itself.
- **Setter:** a new `updateMigration(stateDir, partial, now)` does an atomic
  read-modify-write (temp + rename, same as `writeAppStateMarker`) so the marker
  is updated without clobbering the launch-written fields.
- **Go reader:** unchanged. `start.go`'s `appState` ignores the unknown
  `migration` field and does not gate on `schemaVersion`, so bumping to 2 is safe
  (verified). Adding a mirrored `Migration` field there is optional and not needed
  for v1.

Terminal states (never auto-prompt): `completed`, `declined`. Prompting states:
`pending`, `failed`.

---

## 7. Renderer: detection, gate, popup

### 7.1 IPC additions

- main: `ipcMain.handle("appState:getMigration", …)` → returns `MigrationState`
  (or `{status:"pending"}` when absent); `ipcMain.handle("appState:setMigration",
(_e, partial) => updateMigration(...))`.
- preload: extend the `ao` bridge with
  `appState: { getMigration, setMigration }`.

### 7.2 Gate (where the popup decides to show)

A `useMigrationOffer()` hook, consumed on the dashboard (`_shell.index.tsx`):

1. read `window.ao.appState.getMigration()`,
2. if `status ∈ {completed, declined}` → render nothing,
3. else `GET /api/v1/import`; show the popup only when `available === true`
   (a 501 / unreachable daemon resolves to "not available", never an error).

`Skip` sets an in-memory dismissed flag for the session (no marker write) so the
popup returns next launch. This matches "re-prompt until complete" for Skip while
keeping `Don't Migrate` permanent.

### 7.3 Popup actions / data flow

| Action                  | Effect                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proceed**             | `POST /api/v1/import`. On success: `setMigration({status:"completed", completedAt, report})`, then invalidate the workspace query so projects appear. On failure: `setMigration({status:"failed", lastAttemptAt, error})` and show the reassurance inline. |
| **Skip**                | session-only dismiss; no marker write; re-prompts next launch.                                                                                                                                                                                             |
| **Don't Migrate** (red) | `setMigration({status:"declined", lastAttemptAt})`; never auto-prompts again.                                                                                                                                                                              |

### 7.4 Copy

- Heading: "Import projects from your earlier AO?"
- Body: names the legacy root; "Importing brings in your projects. Your old files
  are never modified, and you can do this later." (projects-only; **no orchestrator
  mention**.)
- Failure: "Migration failed: `<error>`. Your legacy projects are untouched
  (nothing is ever deleted). You can retry." with a Retry that re-POSTs.
- Small print: a neutral "You can run this again later." **v1 must not promise a
  Settings location** (Settings is deferred to #2205); the Settings wording lands
  with that issue.

---

## 8. Components / files

**Backend** (per the import-offer plan, projects-only; status tweak §5.2):
`internal/service/importer/*`, `internal/httpd/controllers/imports.go`,
`dto.go`, `apispec/specgen/build.go`, `api.go`, `daemon.go`, regenerated
`openapi.yaml` + `frontend/src/api/schema.ts`.

**App / renderer (new in this design):**

- `frontend/src/main/app-state.ts` — `MigrationState`, schema v2, preserve +
  `updateMigration`.
- `frontend/src/main.ts` — `appState:getMigration` / `appState:setMigration`
  handlers.
- `frontend/src/preload.ts` — `ao.appState` bridge methods.
- `frontend/src/renderer/hooks/useMigrationOffer.ts` — gate (IPC marker + daemon
  GET).
- `frontend/src/renderer/components/MigrationPopup.tsx` — the three-action dialog
  (built from `components/ui/*`).
- `frontend/src/renderer/routes/_shell.index.tsx` — mount the popup on the board.

---

## 9. Error handling

- Daemon unreachable / 501 on `GET` → "not available" → no popup (never blocks).
- `POST` failure → `failed` marker + lossless-reassurance copy + Retry.
- Corrupt/missing marker → treated as `pending` (self-healing, like the existing
  reader).
- Atomic temp+rename for every marker write → a concurrent `ao start` reader never
  sees a partial file.

---

## 10. Testing

- **`app-state.ts`:** v2 round-trip; launch write preserves an existing
  `migration` block; `updateMigration` merges without clobbering `appPath`/etc.;
  corrupt file → `pending`.
- **Backend:** import service status (`available` = `HasLegacyData` only) + run +
  idempotency; controller GET/POST + 501; route↔spec parity. (From the plan.)
- **`useMigrationOffer` / `MigrationPopup`:** popup shows only when not-terminal +
  available; Proceed success → completed + workspace invalidated + popup retires;
  Proceed failure → reassurance + Retry; Skip → no marker write; Don't Migrate →
  `declined` and stays hidden.

---

## 11. Open decisions

1. **Settings redo path** → deferred to #2205 (locked: not in v1).
2. **Mirror `migration` into the Go `appState` struct?** Not needed for v1; add
   only if a CLI surface ever needs to read migration status.
3. **Where exactly to mount the popup** — board (`_shell.index.tsx`) vs the shell
   layout (`_shell.tsx`) so it shows on any route. Default: board, since that is
   the first-run landing surface; revisit if it should be shell-wide.
