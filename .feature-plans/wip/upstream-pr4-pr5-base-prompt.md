# Feature Plan: PR4 + PR5 — Base Prompt Selector in New Session Dialog

**Branch:** `feat/upstream-main-pr4-pr5`
**Base:** `feat/upstream-pr2-pr3` (confirmed — reset to commit `c50a266d`)
**Issue:** upstream-main-pr4-pr5
**Status:** WIP

---

## Problem Summary

- No way to configure agent behavior at spawn time (plan-first vs execute-immediately)
- `SpawnSessionModal` and `/api/agents` do not exist on this branch yet
- Base prompt is hardcoded in `packages/core/src/prompt-builder.ts:22` — not selectable per session
- Goal: 3-option dropdown in the new session dialog:
  1. **Default** — `BASE_AGENT_PROMPT` unchanged
  2. **Planning** — `BASE_AGENT_PROMPT` + appended plan-first block
  3. **Custom** — user-editable textarea replacing `BASE_AGENT_PROMPT`, pre-filled with its text

---

## Research Findings

### Core
- `packages/core/src/prompt-builder.ts` — `BASE_AGENT_PROMPT` is a module-level `const` string (lines 22–42). Already imported in the file from nothing (it's defined here). File imports `ProjectConfig` from `./types.js` — so `types.ts` must NOT import from `prompt-builder.ts` (circular dep). Solution: define `BasePromptMode` in `types.ts`, import it into `prompt-builder.ts`.
- `packages/core/src/types.ts:226` — `SessionSpawnConfig` is a TypeScript interface only (no Zod). Safe to add fields.
- `packages/core/src/session-manager.ts:1068` — `buildPrompt()` call site. New fields must be threaded from `spawnConfig` here.
- `packages/core/src/index.ts:61-62` — current exports:
  ```ts
  export { buildPrompt, BASE_AGENT_PROMPT } from "./prompt-builder.js";
  export type { PromptBuildConfig } from "./prompt-builder.js";
  ```
  These two lines must be edited (not appended) to add new exports.

### Web API
- `packages/web/src/lib/services.ts:57` — `getServices(): Promise<Services>` — it is async, use `await`.
- `Services` has `{ config, registry, sessionManager, lifecycleManager }`. Use `registry`.
- `PluginRegistry.list(slot: PluginSlot): PluginManifest[]` — method confirmed at `types.ts:1474`. Call as `registry.list("agent")`.
- `PluginManifest` — fields: `name`, `slot`, `description`, `version`, `displayName?`.
- `packages/web/src/app/api/spawn/route.ts` — already imports and uses `jsonWithCorrelation`, `validateString`, `getServices`. Add new field validation following existing pattern.
- Import style on this branch: `@aoagents/ao-core` and `@aoagents/ao-plugin-*`.

### Web Frontend
- `packages/web/src/components/Dashboard.tsx:138` — sessions come from `useSessionEvents(initialSessions, ...)` which returns `{ sessions, connectionStatus, sseAttentionLevels }`. The hook uses an internal reducer — no external `setSessions`. To add optimistic stubs, maintain a separate `useState<DashboardSession[]>` for pending stubs and merge at render time.
- Exact insertion point for "New Session" button: inside `<div className="dashboard-app-header__actions">` at line 460, before the existing orchestrator link.
- `SpawnSessionModal.tsx` does not exist on this branch — port from `git show feat/upstream-correctly-to-main:packages/web/src/components/SpawnSessionModal.tsx`.
- Styling: CSS custom props — `var(--color-surface)`, `var(--color-border)`, `var(--color-text-muted)`, `var(--color-accent)`. Use as `bg-[var(--color-surface)]` in Tailwind.

---

## Files to Modify / Create

### PR4 — Core + API (2 commits)

| File | Action |
|------|--------|
| `packages/core/src/types.ts` | Add `BasePromptMode` type + 2 fields to `SessionSpawnConfig` |
| `packages/core/src/prompt-builder.ts` | Import `BasePromptMode` from types; add `PLANNING_ADDITION`; extend `PromptBuildConfig`; update `buildPrompt()` |
| `packages/core/src/index.ts` | Edit existing export lines to add `PLANNING_ADDITION`, `BasePromptMode` |
| `packages/core/src/session-manager.ts` | Thread new fields into `buildPrompt()` at line 1068 |
| `packages/core/src/__tests__/prompt-builder.test.ts` | Add new `describe("basePromptMode")` block |
| `packages/web/src/app/api/spawn/route.ts` | Add `agent`, `basePromptMode`, `basePromptCustom` validation + forwarding |
| `packages/web/src/app/api/base-prompt/route.ts` | New file — GET returns prompt text |
| `packages/web/src/app/api/agents/route.ts` | New file — GET lists agent plugins |

### PR5 — Frontend (2 commits)

| File | Action |
|------|--------|
| `packages/web/src/components/SpawnSessionModal.tsx` | New file — port + add base prompt dropdown |
| `packages/web/src/components/__tests__/SpawnSessionModal.test.tsx` | New file — tests |
| `packages/web/src/components/Dashboard.tsx` | Add New Session button + modal + optimistic stubs |

---

## Detailed Implementation

### Step 1 — `packages/core/src/types.ts`

Find `SessionSpawnConfig` (at line 226). Add `BasePromptMode` **above** the interface, and two new optional fields inside it:

```typescript
// Add this before SessionSpawnConfig:
export type BasePromptMode = "default" | "planning" | "custom";

// Extend the existing SessionSpawnConfig interface with:
  /** Which base prompt variant to use. Defaults to "default" (unchanged BASE_AGENT_PROMPT). */
  basePromptMode?: BasePromptMode;
  /** Custom base prompt text. Required when basePromptMode === "custom". */
  basePromptCustom?: string;
```

---

### Step 2 — `packages/core/src/prompt-builder.ts`

**2a. Add import** at the top (after existing imports):
```typescript
import type { BasePromptMode, ProjectConfig } from "./types.js";
```
(Replace the existing `import type { ProjectConfig } from "./types.js";` line.)

**2b. Add `PLANNING_ADDITION` constant** immediately after `BASE_AGENT_PROMPT` (around line 43):
```typescript
export const PLANNING_ADDITION = `## Planning Mode
- Your default mode is PLANNING, not coding. Analyze the problem, research the codebase, and produce a written plan before making any code changes.
- Store the plan under \`.feature-plans/wip/{slug}.md\` using the template in \`.feature-plans/_plan_sample_format.md\`.
- Only implement code when the user explicitly requests it (e.g., "implement this", "start coding", "execute the plan").`;
```

**2c. Extend `PromptBuildConfig` interface** — add two optional fields after `userPrompt?`:
```typescript
  /** Which base prompt variant to use. Defaults to "default". */
  basePromptMode?: BasePromptMode;
  /** Custom base prompt text. Only used when basePromptMode === "custom". */
  basePromptCustom?: string;
```

**2d. Update `buildPrompt()`** — replace the existing Layer 1 comment + `sections.push(BASE_AGENT_PROMPT)` line with:
```typescript
  // Layer 1: Base prompt (mode-controlled)
  const mode = config.basePromptMode ?? "default";
  if (mode === "custom" && config.basePromptCustom) {
    sections.push(config.basePromptCustom);
  } else if (mode === "planning") {
    sections.push(BASE_AGENT_PROMPT);
    sections.push(PLANNING_ADDITION);
  } else {
    sections.push(BASE_AGENT_PROMPT);
  }
```
The rest of the function (Layers 2–4) is unchanged.

---

### Step 3 — `packages/core/src/index.ts`

`BasePromptMode` is defined in `types.ts`. `PLANNING_ADDITION` is defined in `prompt-builder.ts`.

Make two targeted edits:

**Edit A** — change the existing line 61 (prompt-builder exports) to add `PLANNING_ADDITION`:
```typescript
// OLD (line 61):
export { buildPrompt, BASE_AGENT_PROMPT } from "./prompt-builder.js";
// NEW:
export { buildPrompt, BASE_AGENT_PROMPT, PLANNING_ADDITION } from "./prompt-builder.js";
```

**Edit B** — `BasePromptMode` is a type defined in `types.ts`. Check line 62 (the `export type { PromptBuildConfig }` line). Leave it as-is. Then grep for whether `BasePromptMode` is already exported from `index.ts` via `types.ts`. If not found, add after line 62:
```typescript
export type { BasePromptMode } from "./types.js";
```

---

### Step 4 — `packages/core/src/session-manager.ts` (line 1068)

Find the `buildPrompt({` call. Change it to:
```typescript
    const composedPrompt = buildPrompt({
      project,
      projectId: spawnConfig.projectId,
      issueId: spawnConfig.issueId,
      issueContext,
      userPrompt: spawnConfig.prompt,
      basePromptMode: spawnConfig.basePromptMode,
      basePromptCustom: spawnConfig.basePromptCustom,
    });
```

---

### Step 5 — `packages/core/src/__tests__/prompt-builder.test.ts`

Add `PLANNING_ADDITION` to the existing import at the top:
```typescript
import { buildPrompt, BASE_AGENT_PROMPT, PLANNING_ADDITION } from "../prompt-builder.js";
```

Append a new `describe` block at the end of the file:
```typescript
describe("basePromptMode", () => {
  it("omitting basePromptMode produces same output as 'default' (regression)", () => {
    const withDefault = buildPrompt({ project, projectId: "test-app", basePromptMode: "default" });
    const withOmitted = buildPrompt({ project, projectId: "test-app" });
    expect(withDefault).toBe(withOmitted);
  });

  it("'planning' mode: output contains BASE_AGENT_PROMPT followed by PLANNING_ADDITION", () => {
    const result = buildPrompt({ project, projectId: "test-app", basePromptMode: "planning" });
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain(PLANNING_ADDITION);
    expect(result.indexOf(BASE_AGENT_PROMPT)).toBeLessThan(result.indexOf(PLANNING_ADDITION));
  });

  it("'custom' mode: replaces BASE_AGENT_PROMPT with custom text", () => {
    const custom = "You are a specialized agent. Always ask before running commands.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      basePromptMode: "custom",
      basePromptCustom: custom,
    });
    expect(result).toContain(custom);
    expect(result).not.toContain(BASE_AGENT_PROMPT);
  });

  it("'custom' mode still includes project context layers", () => {
    const custom = "Custom base.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      basePromptMode: "custom",
      basePromptCustom: custom,
    });
    expect(result).toContain("## Project Context");
    expect(result).toContain("Test App");
  });
});
```

---

### Step 6 — `packages/web/src/app/api/spawn/route.ts`

Add validation after the existing `body.prompt` validation block (before the `try` block):

```typescript
  // Validate agent
  if (body.agent !== undefined && body.agent !== null) {
    if (typeof body.agent !== "string" || body.agent.trim().length === 0) {
      return jsonWithCorrelation(
        { error: "agent must be a non-empty string" },
        { status: 400 },
        correlationId,
      );
    }
  }

  // Validate basePromptMode
  const VALID_MODES = ["default", "planning", "custom"] as const;
  type ValidMode = (typeof VALID_MODES)[number];
  if (body.basePromptMode !== undefined && body.basePromptMode !== null) {
    if (!VALID_MODES.includes(body.basePromptMode as ValidMode)) {
      return jsonWithCorrelation(
        { error: "basePromptMode must be one of: default, planning, custom" },
        { status: 400 },
        correlationId,
      );
    }
  }

  // Validate basePromptCustom (required when mode is "custom")
  const basePromptMode = (body.basePromptMode as ValidMode) ?? undefined;
  if (basePromptMode === "custom") {
    if (
      !body.basePromptCustom ||
      typeof body.basePromptCustom !== "string" ||
      body.basePromptCustom.trim().length === 0
    ) {
      return jsonWithCorrelation(
        { error: "basePromptCustom is required when basePromptMode is custom" },
        { status: 400 },
        correlationId,
      );
    }
    if (body.basePromptCustom.length > 8192) {
      return jsonWithCorrelation(
        { error: "basePromptCustom must be at most 8192 characters" },
        { status: 400 },
        correlationId,
      );
    }
  }
```

Inside the `try` block, after the existing `rawPrompt`/`prompt` lines, add:
```typescript
    // Sanitize basePromptCustom: preserve \n \r \t, strip other C0 control chars
    const rawCustom =
      typeof body.basePromptCustom === "string" ? body.basePromptCustom : undefined;
    const basePromptCustom = rawCustom
      ? rawCustom.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim()
      : undefined;

    const agent = typeof body.agent === "string" ? body.agent.trim() || undefined : undefined;
```

Update the `sessionManager.spawn()` call:
```typescript
    const session = await sessionManager.spawn({
      projectId,
      issueId: (body.issueId as string) ?? undefined,
      prompt: prompt || undefined,
      agent: agent,
      basePromptMode: basePromptMode,
      basePromptCustom: basePromptCustom || undefined,
    });
```

---

### Step 7 — `packages/web/src/app/api/base-prompt/route.ts` (new file)

```typescript
import { BASE_AGENT_PROMPT, PLANNING_ADDITION } from "@aoagents/ao-core";

/** GET /api/base-prompt — Return the default and planning base prompt text for the UI */
export async function GET() {
  return Response.json({
    text: BASE_AGENT_PROMPT,
    planningAddition: PLANNING_ADDITION,
  });
}
```

---

### Step 8 — `packages/web/src/app/api/agents/route.ts` (new file)

```typescript
import { getServices } from "@/lib/services";

/** GET /api/agents — List registered agent plugins */
export async function GET() {
  const { registry } = await getServices();
  const manifests = registry.list("agent");
  const agents = manifests.map(({ name, displayName, description }) => ({
    name,
    displayName,
    description,
  }));
  return Response.json({ agents });
}
```

---

### Step 9 — `packages/web/src/components/SpawnSessionModal.tsx` (new file)

**Source:** Run `git show feat/upstream-correctly-to-main:packages/web/src/components/SpawnSessionModal.tsx` and copy the output as the starting point.

**Modifications to apply to the ported file:**

**A. Add state variables** (after the existing `const [introPrompt, setIntroPrompt] = useState("")` line):
```typescript
  const [basePromptMode, setBasePromptMode] = useState<"default" | "planning" | "custom">("default");
  const [customBasePrompt, setCustomBasePrompt] = useState("");
```

**B. Extend the POST body type** in `handleSubmit` — find the `body:` object declaration and change its type annotation to include:
```typescript
  const body: {
    projectId: string;
    issueId?: string;
    agent?: string;
    prompt?: string;
    basePromptMode?: "planning" | "custom";
    basePromptCustom?: string;
  } = { projectId };
```

**C. Add body fields in `handleSubmit`** — after `if (trimmedPrompt) body.prompt = trimmedPrompt;`:
```typescript
      if (basePromptMode !== "default") {
        body.basePromptMode = basePromptMode;
      }
      if (basePromptMode === "custom" && customBasePrompt.trim()) {
        body.basePromptCustom = customBasePrompt.trim();
      }
```

**D. Fetch base prompt on open** — in the `useEffect` that fetches agents (the one with `if (!open) return;`), add a second async IIFE after the agents fetch:
```typescript
    void (async () => {
      try {
        const res = await fetch("/api/base-prompt");
        const data = (await res.json().catch(() => null)) as { text?: string } | null;
        const text = data?.text ?? "";
        // Pre-fill custom textarea only if user hasn't typed anything yet
        setCustomBasePrompt((prev) => (prev ? prev : text));
      } catch {
        // non-fatal — custom textarea stays empty
      }
    })();
```

**E. Reset on close/submit** — where `setIssueId("")` and `setIntroPrompt("")` are called (in the onClose flow inside handleSubmit), also add:
```typescript
      setBasePromptMode("default");
      // Note: do NOT reset customBasePrompt — preserve the user's text across opens
```

**F. Add the dropdown UI** — in the JSX form, after the agent `<select>` block, before the submit `<button>`, insert:

```tsx
          {/* Base Prompt Mode */}
          <div>
            <label
              htmlFor="basePromptMode"
              className="block text-xs font-medium mb-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              Base Prompt
            </label>
            <select
              id="basePromptMode"
              value={basePromptMode}
              onChange={(e) =>
                setBasePromptMode(e.target.value as "default" | "planning" | "custom")
              }
              className="w-full rounded border px-3 py-2 text-sm focus:outline-none focus:ring-1"
              style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-surface)",
                color: "var(--color-text)",
              }}
            >
              <option value="default">Default (standard agent behavior)</option>
              <option value="planning">Planning (write plan, wait for approval)</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {basePromptMode === "custom" && (
            <div>
              <label
                htmlFor="customBasePrompt"
                className="block text-xs font-medium mb-1"
                style={{ color: "var(--color-text-muted)" }}
              >
                Custom Base Prompt
              </label>
              <textarea
                id="customBasePrompt"
                value={customBasePrompt}
                onChange={(e) => setCustomBasePrompt(e.target.value)}
                rows={8}
                className="w-full rounded border px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-1"
                style={{
                  borderColor: "var(--color-border)",
                  backgroundColor: "var(--color-surface)",
                  color: "var(--color-text)",
                  maxHeight: "16rem",
                  overflowY: "auto",
                }}
                placeholder="Enter a custom base prompt (replaces the default AO system instructions)..."
              />
              <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                Replaces the default AO system instructions. Pre-filled with the default text.
              </p>
            </div>
          )}
```

> Styling rule for the new elements: use inline `style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}` for the select and textarea. Use `style={{ color: "var(--color-text-muted)" }}` for labels and helper text. This matches the pattern shown in the sample code above — do not use Tailwind `bg-[var(...)]` arbitrary values for these elements.

---

### Step 10 — `packages/web/src/components/__tests__/SpawnSessionModal.test.tsx` (new file)

Look at an existing test file (e.g. `packages/web/src/components/__tests__/SessionCard.test.tsx` or similar) for the vitest + testing-library import pattern. Then write:

```typescript
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpawnSessionModal } from "../SpawnSessionModal";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const defaultAgentsResponse = { agents: [{ name: "claude-code", displayName: "Claude Code" }] };
const defaultBasePromptResponse = { text: "You are an AI agent...", planningAddition: "## Planning Mode..." };

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/agents") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultAgentsResponse) });
    }
    if (url === "/api/base-prompt") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultBasePromptResponse) });
    }
    return Promise.resolve({ ok: false });
  });
});

const baseProps = {
  projectId: "my-project",
  open: true,
  onClose: vi.fn(),
  onSessionCreated: vi.fn(),
};

describe("SpawnSessionModal", () => {
  it("renders agent dropdown with options from /api/agents", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("option", { name: /Claude Code/i }));
  });

  it("renders base prompt dropdown with 3 options", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("option", { name: /Default/i }));
    expect(screen.getByRole("option", { name: /Planning/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /Custom/i })).toBeDefined();
  });

  it("custom option reveals textarea pre-filled with default text", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("option", { name: /Custom/i }));
    const select = screen.getByLabelText(/Base Prompt/i);
    fireEvent.change(select, { target: { value: "custom" } });
    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/custom base prompt/i);
      expect(textarea).toBeDefined();
      // Pre-filled with default text from /api/base-prompt
      expect((textarea as HTMLTextAreaElement).value).toContain("You are an AI agent");
    });
  });

  it("POST body has no basePromptMode when Default is selected", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("button", { name: /spawn/i }));
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ session: { id: "s1", projectId: "my-project", status: "working" } }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn/i }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/spawn", expect.objectContaining({ method: "POST" })));
    const call = mockFetch.mock.calls.find((c: string[]) => c[0] === "/api/spawn");
    const body = JSON.parse(call[1].body as string);
    expect(body.basePromptMode).toBeUndefined();
  });

  it("POST body has basePromptMode: planning when Planning is selected", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("option", { name: /Planning/i }));
    fireEvent.change(screen.getByLabelText(/Base Prompt/i), { target: { value: "planning" } });
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ session: { id: "s1", projectId: "my-project", status: "working" } }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn/i }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/spawn", expect.anything()));
    const call = mockFetch.mock.calls.find((c: string[]) => c[0] === "/api/spawn");
    const body = JSON.parse(call[1].body as string);
    expect(body.basePromptMode).toBe("planning");
  });

  it("Escape key calls onClose", () => {
    render(<SpawnSessionModal {...baseProps} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it("modal is portaled to document.body", () => {
    const { baseElement } = render(<SpawnSessionModal {...baseProps} />);
    expect(baseElement.querySelector('[role="dialog"]')).toBeDefined();
  });
});
```

---

### Step 11 — `packages/web/src/components/Dashboard.tsx`

**A. Add import** at the top with the other component imports:
```typescript
import { SpawnSessionModal } from "./SpawnSessionModal";
```

**B. Add state** inside the main `Dashboard` function component (the inner one that receives `DashboardProps`), after the existing `useState` declarations:
```typescript
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [optimisticSessions, setOptimisticSessions] = useState<DashboardSession[]>([]);
```

**C. Add `handleSessionCreated` callback** — after the existing `useCallback` definitions:
```typescript
  const handleSessionCreated = useCallback((session: DashboardSession) => {
    if (session.id.startsWith("spawning-")) {
      // Optimistic stub — prepend; dedup by id
      setOptimisticSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
    } else {
      // Real session from server arrived — clear all stubs; SSE will add the real session
      setOptimisticSessions([]);
    }
  }, []);
```

**D. Modify the existing `displaySessions` memo** — Dashboard.tsx already has a `const displaySessions = useMemo(...)` at line 173. Modify it to merge optimistic stubs before filtering:
```typescript
  // EXISTING code (lines 173-176) — REPLACE with:
  const displaySessions = useMemo(() => {
    const sseIds = new Set(sessions.map((s) => s.id));
    const validStubs = optimisticSessions.filter((s) => !sseIds.has(s.id));
    const merged = [...validStubs, ...sessions];
    if (allProjectsView || !activeSessionId) return merged;
    return merged.filter((s) => s.id === activeSessionId);
  }, [sessions, optimisticSessions, allProjectsView, activeSessionId]);
```
No other `sessions` references need to change. The `grouped` memo (line ~204) already uses `displaySessions` and will automatically include stubs. The `sessionsByProject` memo (line ~211) uses `sessions` directly — keep it as-is (sidebar project counts should not count stubs). `sessionsRef` at line 160 uses `sessions` — keep as-is.

**E. Add "New Session" button** — inside `<div className="dashboard-app-header__actions">` at line 460, before the existing `{!allProjectsView && orchestratorHref ? ...}` block. The CSS class `dashboard-app-btn--primary` does NOT exist — use just `dashboard-app-btn` (the base class already has hover styles):
```tsx
            {!allProjectsView && projectId ? (
              <button
                type="button"
                onClick={() => setSpawnOpen(true)}
                className="dashboard-app-btn"
              >
                New Session
              </button>
            ) : null}
```

**F. Add the modal** — just before the closing `</ToastProvider>` tag at the very end of the return JSX:
```tsx
          {projectId ? (
            <SpawnSessionModal
              projectId={projectId}
              projectName={projectName}
              open={spawnOpen}
              onClose={() => setSpawnOpen(false)}
              onSessionCreated={handleSessionCreated}
            />
          ) : null}
```

---

## Commit Plan

### PR4 — Two commits
```
feat(core): add BasePromptMode to types and PLANNING_ADDITION to prompt-builder
feat(web): add /api/base-prompt, /api/agents, extend spawn route with agent and basePromptMode
```

### PR5 — Two commits
```
feat(web): add SpawnSessionModal with agent selector and base prompt dropdown
feat(web): wire SpawnSessionModal into Dashboard with optimistic session stubs
```

---

## Pre-push Checklist (run before each commit)

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

If typecheck fails: check import paths use `.js` extensions. If lint fails: run `pnpm lint:fix`. All existing tests must remain green.

---

## Risks (resolved)

- **Circular import** — RESOLVED: `BasePromptMode` defined in `types.ts`, imported by `prompt-builder.ts`. No cycle.
- **`getServices()` is async** — RESOLVED: always `await getServices()` in API routes.
- **`sessions` is not a `useState`** — RESOLVED: use separate `optimisticSessions` state + `displaySessions` memo.
- **`BASE_AGENT_PROMPT` already exported** — RESOLVED: edit existing line 61, don't append.
- **`basePromptCustom` newline stripping** — RESOLVED: custom sanitization strips C0 control chars except `\n\r\t`.
