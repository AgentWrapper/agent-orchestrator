# Legacy-Migration Popup + `app-state.json` Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On app launch, offer to import legacy AO projects via a dashboard popup gated on a `migration` marker in `~/.ao/app-state.json`; run the import through the app-owned daemon; never touch legacy files.

**Architecture:** Two layers. **(A) Backend:** a projects-only import daemon API (`GET`/`POST /api/v1/import`). **(B) App:** the desktop app (sole writer of `app-state.json`) stores the migration decision in the marker; a renderer popup reads the marker (over IPC) + the daemon's availability (over HTTP) and offers Proceed / Skip / Don't Migrate.

**Tech Stack:** Go (chi, code-first OpenAPI via `cmd/genspec`), Electron (main/preload IPC), React + @tanstack/react-query + openapi-fetch, @radix-ui/react-dialog, vitest.

**Design source:** `docs/superpowers/specs/2026-06-26-legacy-migration-popup-design.md`. Backend reuses `docs/plans/2026-06-26-import-offer.md`.

## Global Constraints

- Grounded on `upstream/main` @ `514946fd8`. Module path `github.com/aoagents/agent-orchestrator/backend`.
- **No em dashes** in any prose, comment, or UI copy.
- `openapi.yaml` and `frontend/src/api/schema.ts` are **generated**; never hand-edit. Run `npm run api:spec && npm run api:ts`.
- App is the **sole writer** of `~/.ao/app-state.json`; daemon is the **sole writer** of the DB. Marker writes are atomic (temp + rename).
- Import is **projects + per-project settings only** (no orchestrator sessions, no transcripts) and **idempotent**; it **never deletes or modifies** legacy files.
- v1 popup copy must **not** promise a Settings location (Settings deferred to AgentWrapper/agent-orchestrator#2205).
- Branch `ao/agent-orchestrator-3/legacy-migration-popup`; PR target `main` on `AgentWrapper/agent-orchestrator`. Commit after every task (AO worktrees can be force-removed).

## File Structure

| File                                                       | Status                   | Responsibility                                                                      |
| ---------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| (backend import API)                                       | per import-offer plan    | projects-only `legacyimport`, `service/importer`, controller, DTOs, OpenAPI, wiring |
| `backend/internal/service/importer/importer.go`            | create (modified Status) | `Status` = `HasLegacyData` only; `Run`                                              |
| `backend/internal/cli/start.go`                            | modify                   | drop the `§6.4` TODO comment (`:78`)                                                |
| `frontend/src/main/app-state.ts`                           | modify                   | `MigrationState`, schema v2, preserve, `updateMigration`, `readMigrationState`      |
| `frontend/src/main/app-state.test.ts`                      | modify                   | marker v2 + migration tests                                                         |
| `frontend/src/main.ts`                                     | modify                   | `appState:getMigration` / `appState:setMigration` IPC handlers                      |
| `frontend/src/preload.ts`                                  | modify                   | `ao.appState` bridge methods                                                        |
| `frontend/src/renderer/lib/bridge.ts`                      | modify                   | `appState` preview fallback                                                         |
| `frontend/src/renderer/hooks/useMigrationOffer.ts`         | create                   | gate: IPC marker + daemon GET                                                       |
| `frontend/src/renderer/components/MigrationPopup.tsx`      | create                   | the three-action dialog                                                             |
| `frontend/src/renderer/components/MigrationPopup.test.tsx` | create                   | popup tests                                                                         |
| `frontend/src/renderer/routes/_shell.index.tsx`            | modify                   | mount `<MigrationPopup/>` on the board                                              |

---

# Part A: Backend import API (projects-only)

Execute the committed plan `docs/plans/2026-06-26-import-offer.md`, **Tasks 1, 3, 4, 5 only**, with the Task-2 change below. **Skip** that plan's Task 2 as written, Task 6 (start.go is already headless from #2201), and Tasks 7-11 (its frontend is replaced by Part B here).

- **Task 1** (engine → projects-only): as written.
- **Task 2 REPLACEMENT** (service): see Task A2 below (simpler `Status`).
- **Task 3** (controller + DTOs): as written.
- **Task 4** (OpenAPI regen): as written. After regen, `schema.ts` must contain `/api/v1/import`, `ImportStatusResponse {available, legacyRoot}`, `ImportRunResponse {report}`.
- **Task 5** (wire api.go + daemon.go): as written, i.e. `Import: importsvc.New(importsvc.Deps{Store: store})`.

### Task A2: Import service with availability-only status

**Files:** Create `backend/internal/service/importer/importer.go`, `…/importer_test.go`

**Interfaces:**

- Produces: `importer.Status{Available bool; LegacyRoot string}`, `importer.Service` (`Status(ctx)`, `Run(ctx)`), `importer.Deps{Store, Root}`, `importer.New(Deps) *Manager`. `Store` is exactly `legacyimport.Store` (the projects-only `GetProject`/`UpsertProject`) — **no `ListProjects`** (the design drops the empty-DB heuristic; the app marker governs prompting).

- [ ] **Step 1: Write `importer.go`:**

```go
// Package importer is the controller-facing service for the legacy-AO import.
// It wraps the internal/legacyimport engine with a detection probe (is a legacy
// install present?) and a trigger that runs the import through the live daemon's
// store, so the daemon stays the sole writer. Whether to PROMPT for the import
// is the desktop app's job (the app-state.json migration marker), so this probe
// reports only physical availability, not "already imported".
package importer

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/legacyimport"
)

// Store is the storage slice the import runs through; *sqlite.Store satisfies it.
type Store interface {
	legacyimport.Store
}

// Status reports whether a legacy AO install is physically present to import.
type Status struct {
	Available  bool   `json:"available"`
	LegacyRoot string `json:"legacyRoot"`
}

// Service is the controller-facing import contract.
type Service interface {
	Status(ctx context.Context) (Status, error)
	Run(ctx context.Context) (legacyimport.Report, error)
}

// Deps bundles the import service's dependencies.
type Deps struct {
	// Store is the rewrite's durable store (the daemon's shared *sqlite.Store).
	Store Store
	// Root overrides the legacy AO root to read. Empty -> the default.
	Root string
}

// Manager implements Service over the daemon's store.
type Manager struct {
	store Store
	root  string
}

var _ Service = (*Manager)(nil)

// New constructs the import service. An empty Root falls back to the default.
func New(deps Deps) *Manager {
	root := deps.Root
	if root == "" {
		root = legacyimport.DefaultLegacyRootDir()
	}
	return &Manager{store: deps.Store, root: root}
}

// Status reports availability only: legacy data present at the root. It never
// errors on a missing legacy store; that is simply "not available".
func (m *Manager) Status(_ context.Context) (Status, error) {
	return Status{Available: legacyimport.HasLegacyData(m.root), LegacyRoot: m.root}, nil
}

// Run executes the import through the daemon's store. Idempotent: the engine
// skips rows that already exist. Legacy files are never modified.
func (m *Manager) Run(ctx context.Context) (legacyimport.Report, error) {
	return legacyimport.Run(ctx, m.store, legacyimport.Options{Root: m.root})
}
```

- [ ] **Step 2: Write `importer_test.go`:**

```go
package importer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct{ projects map[string]domain.ProjectRecord }

func newFakeStore() *fakeStore { return &fakeStore{projects: map[string]domain.ProjectRecord{}} }
func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	r, ok := f.projects[id]
	return r, ok, nil
}
func (f *fakeStore) UpsertProject(_ context.Context, r domain.ProjectRecord) error {
	f.projects[r.ID] = r
	return nil
}

func writeLegacyRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o750); err != nil {
		t.Fatal(err)
	}
	cfg := "projects:\n  alpha:\n    path: /repos/alpha\n    name: Alpha\n"
	if err := os.WriteFile(filepath.Join(root, "config.yaml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestStatus_NoLegacyData(t *testing.T) {
	svc := New(Deps{Store: newFakeStore(), Root: filepath.Join(t.TempDir(), "nope")})
	st, err := svc.Status(context.Background())
	if err != nil || st.Available {
		t.Fatalf("want unavailable; got %+v err=%v", st, err)
	}
}

func TestStatus_LegacyPresentStaysAvailableAfterImport(t *testing.T) {
	root := writeLegacyRoot(t)
	svc := New(Deps{Store: newFakeStore(), Root: root})
	st, err := svc.Status(context.Background())
	if err != nil || !st.Available || st.LegacyRoot != root {
		t.Fatalf("want available at %q; got %+v err=%v", root, st, err)
	}
	if _, err := svc.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	// Availability is physical (legacy data still on disk), so it stays true; the
	// app marker is what stops the prompt after a completed import.
	st, _ = svc.Status(context.Background())
	if !st.Available {
		t.Fatal("availability must remain true after import (marker governs prompting)")
	}
}

func TestRun_ImportsProjects(t *testing.T) {
	root := writeLegacyRoot(t)
	svc := New(Deps{Store: newFakeStore(), Root: root})
	rep, err := svc.Run(context.Background())
	if err != nil || rep.ProjectsImported != 1 {
		t.Fatalf("projectsImported=%d err=%v", rep.ProjectsImported, err)
	}
}

func TestNew_DefaultsRoot(t *testing.T) {
	if New(Deps{Store: newFakeStore()}).root == "" {
		t.Fatal("empty Root should fall back to the default legacy root")
	}
}
```

- [ ] **Step 3:** `cd backend && go test ./internal/service/importer/...` → expect PASS.
- [ ] **Step 4:** Commit: `feat(importer): availability probe + projects-only run`

### Task A6: Clear the resolved TODO in start.go

**Files:** Modify `backend/internal/cli/start.go`

- [ ] **Step 1:** Delete the now-resolved comment at `start.go:78` (`// TODO(spec §6.4): legacy first-boot import now belongs to the desktop app; …`). The behavior it describes is implemented by this feature.
- [ ] **Step 2:** `cd backend && go build ./...` → expect PASS.
- [ ] **Step 3:** Commit: `chore(cli): drop resolved §6.4 first-boot-import TODO`

---

# Part B: App-side marker + popup

### Task B1: Migration marker in `app-state.json` (schema v2)

**Files:** Modify `frontend/src/main/app-state.ts`, `frontend/src/main/app-state.test.ts`

**Interfaces:**

- Produces: `MigrationStatus`, `MigrationState`, `updateMigration({stateDir, migration, now})`, `readMigrationState(stateDir) => Promise<MigrationState>`. `AppStateMarker` gains `migration?: MigrationState`. `SCHEMA_VERSION === 2`. **B2/B3/B4 depend on these names.**

- [ ] **Step 1 (TDD): add tests to `app-state.test.ts`** (follows the file's existing temp-dir style):

```ts
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { APP_STATE_FILE_NAME, readMigrationState, updateMigration, writeAppStateMarker } from "./app-state";

const fixedNow = () => new Date("2026-06-26T10:00:00.000Z");
async function tmp() {
	return mkdtemp(path.join(os.tmpdir(), "ao-appstate-"));
}

describe("migration marker", () => {
	it("readMigrationState defaults to pending when the file is absent", async () => {
		expect(await readMigrationState(await tmp())).toEqual({ status: "pending" });
	});

	it("updateMigration persists status without an existing marker", async () => {
		const dir = await tmp();
		await updateMigration({ stateDir: dir, migration: { status: "declined" }, now: fixedNow });
		expect((await readMigrationState(dir)).status).toBe("declined");
	});

	it("a launch write preserves an existing migration block", async () => {
		const dir = await tmp();
		await updateMigration({ stateDir: dir, migration: { status: "completed" }, now: fixedNow });
		await writeAppStateMarker({ stateDir: dir, appPath: "/A.app", version: "1.2.3", now: fixedNow });
		const raw = JSON.parse(await readFile(path.join(dir, APP_STATE_FILE_NAME), "utf8"));
		expect(raw.schemaVersion).toBe(2);
		expect(raw.appPath).toBe("/A.app");
		expect(raw.migration.status).toBe("completed");
	});

	it("updateMigration does not clobber launch fields", async () => {
		const dir = await tmp();
		await writeAppStateMarker({ stateDir: dir, appPath: "/A.app", version: "1.2.3", now: fixedNow });
		await updateMigration({ stateDir: dir, migration: { status: "failed", error: "x" }, now: fixedNow });
		const raw = JSON.parse(await readFile(path.join(dir, APP_STATE_FILE_NAME), "utf8"));
		expect(raw.appPath).toBe("/A.app");
		expect(raw.migration).toEqual({ status: "failed", error: "x" });
	});
});
```

- [ ] **Step 2: Run → FAIL** (`updateMigration`/`readMigrationState` not exported): `npm --prefix frontend run test -- app-state`.
- [ ] **Step 3: Edit `app-state.ts`.** Set `const SCHEMA_VERSION = 2;`. Add types and the marker field:

```ts
export type MigrationStatus = "pending" | "completed" | "declined" | "failed";

export interface MigrationState {
	status: MigrationStatus;
	lastAttemptAt?: string;
	completedAt?: string;
	report?: { projectsImported: number; projectsSkipped: number };
	error?: string;
}
```

Add `migration?: MigrationState;` to `AppStateMarker`. Extract the existing temp+rename into a helper and reuse it:

```ts
async function atomicWriteMarker(stateDir: string, marker: AppStateMarker): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, APP_STATE_FILE_NAME);
	const data = `${JSON.stringify(marker, null, 2)}\n`;
	const tmp = path.join(stateDir, `.app-state-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, file);
}
```

In `writeAppStateMarker`, build the `marker` object as today but add `migration: existing?.migration` (preserve), and replace the inline temp+rename with `await atomicWriteMarker(opts.stateDir, marker);`. Then add:

```ts
export interface UpdateMigrationOptions {
	stateDir: string;
	migration: MigrationState;
	now: () => Date;
}

// updateMigration sets ONLY the migration block, preserving every launch-written
// field already on disk. Used by the app's IPC setter. Atomic like the launch write.
export async function updateMigration(opts: UpdateMigrationOptions): Promise<void> {
	const file = path.join(opts.stateDir, APP_STATE_FILE_NAME);
	const existing = await readExisting(file);
	const nowIso = opts.now().toISOString();
	const marker: AppStateMarker = existing
		? { ...existing, migration: opts.migration }
		: {
				schemaVersion: SCHEMA_VERSION,
				appPath: "",
				version: "",
				installedAt: nowIso,
				lastReconciledAt: nowIso,
				installSource: "unknown",
				migration: opts.migration,
			};
	await atomicWriteMarker(opts.stateDir, marker);
}

// readMigrationState returns the marker's migration block, defaulting to pending
// when the file is absent or unparseable (self-healing, like the rest of the reader).
export async function readMigrationState(stateDir: string): Promise<MigrationState> {
	const existing = await readExisting(path.join(stateDir, APP_STATE_FILE_NAME));
	return existing?.migration ?? { status: "pending" };
}
```

- [ ] **Step 4: Run → PASS**: `npm --prefix frontend run test -- app-state`.
- [ ] **Step 5:** Commit: `feat(app-state): migration marker (schema v2) + updateMigration`

### Task B2: IPC handlers + preload/bridge

**Files:** Modify `frontend/src/main.ts`, `frontend/src/preload.ts`, `frontend/src/renderer/lib/bridge.ts`

**Interfaces:** Produces `window.ao.appState.getMigration()` / `setMigration(m)` (typed via `AoBridge`). **B3/B4 consume these.**

- [ ] **Step 1: `main.ts`** — extend the marker import and add two handlers next to the other `ipcMain.handle` calls (`:773-796`):

```ts
import { readMigrationState, updateMigration, writeAppStateMarker, type MigrationState } from "./main/app-state";
```

```ts
ipcMain.handle("appState:getMigration", async (): Promise<MigrationState> => {
	const runFile = runFilePath();
	if (!runFile) return { status: "pending" };
	return readMigrationState(path.dirname(runFile));
});
ipcMain.handle("appState:setMigration", async (_event, migration: MigrationState) => {
	const runFile = runFilePath();
	if (!runFile) return;
	await updateMigration({ stateDir: path.dirname(runFile), migration, now: () => new Date() });
});
```

- [ ] **Step 2: `preload.ts`** — import the type and add to `api`:

```ts
import type { MigrationState } from "./main/app-state";
```

```ts
	appState: {
		getMigration: () => ipcRenderer.invoke("appState:getMigration") as Promise<MigrationState>,
		setMigration: (migration: MigrationState) =>
			ipcRenderer.invoke("appState:setMigration", migration) as Promise<void>,
	},
```

- [ ] **Step 3: `bridge.ts`** — add the preview fallback so `AoBridge` stays satisfied:

```ts
		appState: {
			getMigration: async () => ({ status: "pending" }),
			setMigration: async () => undefined,
		},
```

- [ ] **Step 4:** `npm --prefix frontend run typecheck` → expect PASS.
- [ ] **Step 5:** Commit: `feat(ipc): expose app-state migration getter/setter to the renderer`

### Task B3: `useMigrationOffer` gate hook

**Files:** Create `frontend/src/renderer/hooks/useMigrationOffer.ts`

**Interfaces:** Consumes `apiClient` (`renderer/lib/api-client`, needs the Part A `schema.ts` paths), `aoBridge` (`renderer/lib/bridge`), `MigrationState` (`main/app-state`). Produces `useMigrationOffer()`, `migrationOfferQueryKey`, `MigrationOffer`.

- [ ] **Step 1: Create the file:**

```ts
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import type { MigrationState } from "../../main/app-state";

export const migrationOfferQueryKey = ["migration-offer"] as const;
const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

export interface MigrationOffer {
	show: boolean;
	legacyRoot: string;
	migration: MigrationState;
}

// fetchMigrationOffer combines the app marker (decision) with the daemon's
// availability (is there legacy data). A terminal marker (completed/declined)
// short-circuits before any daemon call. A 501/unreachable daemon resolves to
// "no offer", never an error.
async function fetchMigrationOffer(): Promise<MigrationOffer> {
	const migration = await aoBridge.appState.getMigration();
	if (migration.status === "completed" || migration.status === "declined") {
		return { show: false, legacyRoot: "", migration };
	}
	const { data, error } = await apiClient.GET("/api/v1/import");
	const legacyRoot = data?.legacyRoot ?? "";
	if (error || !data?.available) return { show: false, legacyRoot, migration };
	return { show: true, legacyRoot, migration };
}

export function useMigrationOffer() {
	return useQuery({
		queryKey: migrationOfferQueryKey,
		queryFn: fetchMigrationOffer,
		enabled: !usePreviewData,
		retry: 1,
		throwOnError: false,
	});
}
```

- [ ] **Step 2:** `npm --prefix frontend run typecheck` → expect PASS.
- [ ] **Step 3:** Commit: `feat(renderer): useMigrationOffer gate (marker + availability)`

### Task B4: `MigrationPopup` component

**Files:** Create `frontend/src/renderer/components/MigrationPopup.tsx`, `…/MigrationPopup.test.tsx`

**Interfaces:** Consumes `useMigrationOffer`/`migrationOfferQueryKey`, `workspaceQueryKey`, `apiClient`/`apiErrorMessage`, `aoBridge`. Self-contained (no props).

- [ ] **Step 1 (TDD): Create `MigrationPopup.test.tsx`:**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MigrationPopup } from "./MigrationPopup";

const { getMock, postMock, getMigration, setMigration } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	getMigration: vi.fn(),
	setMigration: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (e: unknown, fb = "Request failed") =>
		e instanceof Error ? e.message : ((e as { message?: string })?.message ?? fb),
}));
vi.mock("../lib/bridge", () => ({ aoBridge: { appState: { getMigration, setMigration } } }));

function renderPopup() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MigrationPopup />
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	getMigration.mockReset();
	setMigration.mockReset();
	getMigration.mockResolvedValue({ status: "pending" });
	getMock.mockResolvedValue({ data: { available: true, legacyRoot: "/home/u/.agent-orchestrator" }, error: undefined });
	postMock.mockResolvedValue({ data: { report: { projectsImported: 2, projectsSkipped: 1 } }, error: undefined });
	setMigration.mockResolvedValue(undefined);
});

describe("MigrationPopup", () => {
	it("shows when a legacy install is available and the marker is pending", async () => {
		renderPopup();
		expect(await screen.findByText(/Import projects from your earlier AO/i)).toBeInTheDocument();
		expect(screen.getByText("/home/u/.agent-orchestrator")).toBeInTheDocument();
	});

	it("renders nothing when the marker is declined", async () => {
		getMigration.mockResolvedValue({ status: "declined" });
		renderPopup();
		await waitFor(() => expect(getMigration).toHaveBeenCalled());
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
		expect(getMock).not.toHaveBeenCalled();
	});

	it("Proceed imports, marks completed, and retires", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/import"));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
		await waitFor(() => expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument());
	});

	it("Don't Migrate records declined", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Don't Migrate" }));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "declined" }));
	});

	it("Skip dismisses without writing the marker", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Skip" }));
		expect(setMigration).not.toHaveBeenCalled();
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
	});

	it("a failed import shows the lossless reassurance and marks failed", async () => {
		postMock.mockResolvedValue({ data: undefined, error: { message: "disk full" } });
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		expect(await screen.findByText(/nothing is ever deleted/i)).toBeInTheDocument();
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "disk full" }));
	});
});
```

- [ ] **Step 2: Run → FAIL** (component missing): `npm --prefix frontend run test -- MigrationPopup`.
- [ ] **Step 3: Create `MigrationPopup.tsx`:**

```tsx
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/button";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { migrationOfferQueryKey, useMigrationOffer } from "../hooks/useMigrationOffer";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";

// MigrationPopup is the first-run legacy-AO import offer. It shows only when the
// app marker is non-terminal (pending/failed) AND the daemon reports legacy data
// available. Proceed runs the idempotent import through the daemon; Skip dismisses
// for this launch (re-prompts next launch); Don't Migrate declines permanently
// (re-runnable later once the Settings entry point lands, issue #2205).
export function MigrationPopup() {
	const offer = useMigrationOffer();
	const queryClient = useQueryClient();
	const [skipped, setSkipped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const open = (offer.data?.show ?? false) && !skipped;
	if (!open) return null;

	const legacyRoot = offer.data?.legacyRoot || "your earlier AO";
	const nowIso = () => new Date().toISOString();

	const proceed = async () => {
		setBusy(true);
		setError(undefined);
		const { data, error: apiErr } = await apiClient.POST("/api/v1/import");
		if (apiErr) {
			const msg = apiErrorMessage(apiErr);
			setError(msg);
			await aoBridge.appState.setMigration({ status: "failed", lastAttemptAt: nowIso(), error: msg });
			setBusy(false);
			return;
		}
		const report = data?.report;
		await aoBridge.appState.setMigration({
			status: "completed",
			lastAttemptAt: nowIso(),
			completedAt: nowIso(),
			report: report
				? { projectsImported: report.projectsImported, projectsSkipped: report.projectsSkipped }
				: undefined,
		});
		await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		await queryClient.invalidateQueries({ queryKey: migrationOfferQueryKey });
		setBusy(false);
	};

	const dontMigrate = async () => {
		await aoBridge.appState.setMigration({ status: "declined", lastAttemptAt: nowIso() });
		await queryClient.invalidateQueries({ queryKey: migrationOfferQueryKey });
	};

	return (
		<Dialog.Root
			open
			onOpenChange={(next) => {
				if (!next) setSkipped(true);
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">
						Import projects from your earlier AO?
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
						We found an existing install at <span className="font-mono text-[11px] text-foreground">{legacyRoot}</span>.
						Importing brings in your projects. Your old files are never modified, and you can do this later.
					</Dialog.Description>
					{error && (
						<div className="mt-3 text-[12px] text-destructive">
							Migration failed: {error}. Your legacy projects are untouched (nothing is ever deleted). You can retry.
						</div>
					)}
					<p className="mt-3 text-[11px] text-muted-foreground">You can run this again later.</p>
					<div className="mt-4 flex items-center justify-between gap-2">
						<Button variant="ghost" className="text-destructive" onClick={dontMigrate} disabled={busy} type="button">
							Don't Migrate
						</Button>
						<div className="flex gap-2">
							<Button variant="ghost" onClick={() => setSkipped(true)} disabled={busy} type="button">
								Skip
							</Button>
							<Button variant="primary" onClick={proceed} disabled={busy} type="button">
								{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
								{error ? "Retry" : "Proceed"}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
```

- [ ] **Step 4: Run → PASS**: `npm --prefix frontend run test -- MigrationPopup`.
- [ ] **Step 5:** Commit: `feat(renderer): MigrationPopup (Proceed / Skip / Don't Migrate)`

### Task B5: Mount on the dashboard

**Files:** Modify `frontend/src/renderer/routes/_shell.index.tsx`

- [ ] **Step 1:** Render the popup alongside the board:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { MigrationPopup } from "../components/MigrationPopup";
import { SessionsBoard } from "../components/SessionsBoard";

export const Route = createFileRoute("/_shell/")({
	component: () => (
		<>
			<MigrationPopup />
			<SessionsBoard />
		</>
	),
});
```

- [ ] **Step 2:** `npm --prefix frontend run typecheck && npm --prefix frontend run test -- MigrationPopup` → expect PASS.
- [ ] **Step 3:** Commit: `feat(renderer): surface MigrationPopup on the dashboard`

### Task B6: Full verification

- [ ] `cd backend && go build ./... && go test -race ./...` → green.
- [ ] `golangci-lint run` on touched packages → clean.
- [ ] `npm --prefix frontend run typecheck && npm --prefix frontend run test` → green.
- [ ] `git status` shows no uncommitted drift after `npm run api:spec && npm run api:ts`.
- [ ] **Full frontend production build** (rollup tree-shaking can hide missing emits).
- [ ] Manual: seed `~/.agent-orchestrator` with a legacy `config.yaml`, empty rewrite DB, launch the app → popup appears. Proceed → projects appear, `~/.ao/app-state.json` shows `migration.status: "completed"`, relaunch → no popup. Separately test Skip (re-prompts next launch) and Don't Migrate (`declined`, no re-prompt).

---

## Self-Review

**Spec coverage:** ✅ import daemon API projects-only (Part A); availability-only Status per design §5.2 (A2); marker schema v2 + preserve + updateMigration (B1); IPC getter/setter + bridge (B2); gate combining marker + availability (B3); popup with Proceed/Skip/Don't Migrate + lossless failure copy (B4); mount on board (B5); resolved-TODO cleanup (A6). Settings redo path correctly **excluded** (deferred to #2205); v1 copy avoids any Settings promise.

**Placeholder scan:** none — every new file has complete source; Part A references a committed, complete plan for its unchanged tasks and gives full code for the one changed task.

**Type consistency:** `MigrationState`/`MigrationStatus` defined in B1 are imported unchanged by B2 (preload/main/bridge), B3 (hook), B4 (popup). `updateMigration({stateDir, migration, now})` signature matches its B2 call. `migrationOfferQueryKey`/`workspaceQueryKey` consistent B3↔B4. `Status{Available, LegacyRoot}` (A2) ↔ `ImportStatusResponse` (Part A Task 3) ↔ `schema.ts` GET shape used in B3. `report.{projectsImported,projectsSkipped}` (engine, Part A Task 1) ↔ B4 usage.

**Cross-task coupling:** B3 needs Part A's regenerated `schema.ts` (Task 4) for `apiClient.GET/POST("/api/v1/import")` to typecheck, so **Part A precedes Part B**. B2's bridge fallback must be added or B3/B4 typecheck fails under `AoBridge`.
