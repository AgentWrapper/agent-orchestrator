# Project-Based Dashboard Architecture

**Status:** Draft  
**Author:** Agent Orchestrator  
**Date:** 2026-03-09  
**Target Merge:** `opencode-lifyecycle`

---

## Overview

This spec defines the architecture changes required to scope the Agent Orchestrator dashboard by project. Currently, the dashboard displays all sessions across all configured projects, which creates cognitive overhead for multi-project setups. The target architecture adds project filtering at every layer (API, SSE events, frontend state) while maintaining full backward compatibility for single-project deployments.

**Key Change:** Add optional `project` query parameter to session list/event endpoints, filtering all responses to a single project scope. Frontend will read `projectName` from config and pass it as the filter.

---

## Current State

### Data Flow

```
page.tsx (SSR)
    ↓
getServices() → sessionManager.list()  // NO project filter
    ↓
enrichSessionsMetadata()
    ↓
Dashboard.tsx
    ↓ (initial render)
useSessionEvents() ← EventSource("/api/events")  // NO project filter
    ↓
Real-time updates
```

### Key Files

| File                                         | Role                                      | Project Awareness                         |
| -------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `packages/web/src/app/page.tsx`              | SSR entry point, fetches initial sessions | Reads `projectName` for display only      |
| `packages/web/src/app/api/sessions/route.ts` | GET `/api/sessions` — lists all sessions  | **No filtering**                          |
| `packages/web/src/app/api/events/route.ts`   | GET `/api/events` — SSE stream            | **No filtering**                          |
| `packages/web/src/lib/services.ts`           | Core services singleton                   | N/A                                       |
| `packages/web/src/lib/serialize.ts`          | Session → DashboardSession mapping        | `resolveProject()` maps session → project |
| `packages/web/src/lib/types.ts`              | Dashboard types                           | `DashboardSession.projectId` exists       |
| `packages/web/src/components/Dashboard.tsx`  | Main dashboard component                  | Displays all sessions                     |
| `packages/web/src/hooks/useSessionEvents.ts` | SSE event handler                         | Receives all sessions                     |

### Current API Response Shape

**GET /api/sessions**

```typescript
{
  sessions: DashboardSession[];  // ALL sessions, unfiltered
  stats: DashboardStats;
  orchestratorId: string | null;
}
```

**GET /api/events (SSE)**

```typescript
{
  type: "snapshot";
  sessions: Array<{
    id: string;
    status: SessionStatus;
    activity: ActivityState | null;
    attentionLevel: AttentionLevel;
    lastActivityAt: string;
  }>; // ALL sessions, unfiltered
}
```

---

## Problems with Current Non-Project-Scoped Behavior

1. **Cognitive Overload** — Multi-project users see sessions from unrelated projects mixed together, making it hard to focus on one project's work.

2. **Stats Misleading** — `DashboardStats` aggregates across all projects. "3 needs review" might be spread across 3 different projects, not actionable.

3. **Orchestrator Ambiguity** — Orchestrator session is found by suffix (`-orchestrator`). With multiple projects, multiple orchestrators may exist but only one is surfaced.

4. **SSE Inefficiency** — Client receives updates for ALL sessions, including irrelevant projects, wasting bandwidth and causing unnecessary re-renders.

5. **URL Non-Shareability** — Cannot share a dashboard URL scoped to a specific project. `http://localhost:3000/` shows everything.

6. **Future Multi-Tenant Blocker** — If AO ever supports multi-tenant hosting, unscoped APIs would leak data between tenants.

---

## Target Project-Based Architecture

### Design Principles

1. **Opt-in** — No `project` param = all sessions (backward compatible)
2. **Single Source of Truth** — `projectName` comes from config, not URL state
3. **Filter at Source** — API and SSE filter before returning data, not client-side
4. **Zero Config for Single-Project** — Existing users see no change
5. **Type-Safe** — Project param typed in API contracts

### Target Data Flow

```
page.tsx (SSR)
    ↓ projectName from getProjectName()
    ↓
GET /api/sessions?project=<name>  // ← NEW: project filter
    ↓
sessionManager.list().filter(s => s.projectId === project || matchesPrefix)
    ↓
Dashboard.tsx (receives only project sessions)
    ↓
useSessionEvents(projectName) ← EventSource("/api/events?project=<name>")  // ← NEW
    ↓
Real-time updates (project-scoped)
```

### URL Scheme

| URL                | Behavior                                        |
| ------------------ | ----------------------------------------------- |
| `/`                | Scoped to first/primary project (from config)   |
| `/?project=all`    | Show all sessions (explicit multi-project view) |
| `/?project=my-app` | Scoped to `my-app` project                      |

**Default behavior:** When no `project` query param, use `projectName` from config (first project's name or `ao` fallback). This ensures single-project users see their project automatically.

---

## API Contract Changes

### 1. GET /api/sessions

**Query Parameters (NEW)**

```typescript
interface SessionsQueryParams {
  /** Optional project filter. If omitted, returns all sessions. */
  project?: string;
  /** Existing: filter to non-exited sessions only */
  active?: "true" | "false";
}
```

**Response Shape (UNCHANGED)**

```typescript
interface SessionsResponse {
  sessions: DashboardSession[]; // Filtered by project if param provided
  stats: DashboardStats; // Stats reflect filtered sessions only
  orchestratorId: string | null; // Orchestrator for the project (if scoped)
}
```

**Behavior**

| Query                         | Result                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| No params                     | All sessions (backward compatible)                                                                       |
| `?project=my-app`             | Only sessions where `session.projectId === "my-app"` OR session ID starts with project's `sessionPrefix` |
| `?project=all`                | All sessions (explicit unscoped)                                                                         |
| `?project=nonexistent`        | Empty sessions array, stats all zeros, `orchestratorId: null`                                            |
| `?active=true&project=my-app` | Active sessions for project only                                                                         |

**Project Resolution Logic** (reuse existing `resolveProject`)

```typescript
function matchesProject(session: Session, projectId: string, config: OrchestratorConfig): boolean {
  // Direct match
  if (session.projectId === projectId) return true;

  // Prefix match (existing behavior in resolveProject)
  const project = config.projects[projectId];
  if (project?.sessionPrefix && session.id.startsWith(project.sessionPrefix)) return true;

  return false;
}
```

### 2. GET /api/events (SSE)

**Query Parameters (NEW)**

```typescript
interface EventsQueryParams {
  /** Optional project filter. If omitted, streams all sessions. */
  project?: string;
}
```

**SSE Event Shape (UNCHANGED)**

```typescript
interface SSESnapshotEvent {
  type: "snapshot";
  sessions: Array<{
    id: string;
    status: SessionStatus;
    activity: ActivityState | null;
    attentionLevel: AttentionLevel;
    lastActivityAt: string;
  }>; // Filtered by project if param provided
}
```

**Behavior**

| Query             | Result                                |
| ----------------- | ------------------------------------- |
| No params         | Stream all sessions                   |
| `?project=my-app` | Stream only sessions matching project |
| `?project=all`    | Stream all sessions                   |

---

## Frontend State Model Changes

### 1. page.tsx (SSR Entry)

**Current:**

```typescript
export default async function Home() {
  const { sessionManager } = await getServices();
  const allSessions = await sessionManager.list();
  // ...
}
```

**Target:**

```typescript
export default async function Home({ searchParams }: { searchParams: { project?: string } }) {
  const projectName = getProjectName();
  const projectFilter = searchParams.project ?? projectName;  // Default to config project

  const res = await fetch(`${baseUrl}/api/sessions?project=${encodeURIComponent(projectFilter)}`);
  const { sessions, stats, orchestratorId } = await res.json();

  return (
    <Dashboard
      initialSessions={sessions}
      stats={stats}
      orchestratorId={orchestratorId}
      projectName={projectFilter}
    />
  );
}
```

### 2. useSessionEvents Hook

**Current:**

```typescript
export function useSessionEvents(initialSessions: DashboardSession[]): DashboardSession[] {
  useEffect(() => {
    const es = new EventSource("/api/events");
    // ...
  }, []);
}
```

**Target:**

```typescript
export function useSessionEvents(
  initialSessions: DashboardSession[],
  project?: string,
): DashboardSession[] {
  useEffect(() => {
    const url = project ? `/api/events?project=${encodeURIComponent(project)}` : "/api/events";
    const es = new EventSource(url);
    // ...
  }, [project]);
}
```

### 3. Dashboard.tsx

**Current:**

```typescript
export function Dashboard({ initialSessions, stats, orchestratorId, projectName }: DashboardProps) {
  const sessions = useSessionEvents(initialSessions);
  // ...
}
```

**Target:**

```typescript
export function Dashboard({ initialSessions, stats, orchestratorId, projectName }: DashboardProps) {
  const sessions = useSessionEvents(initialSessions, projectName);
  // ...
}
```

**Note:** `projectName` already exists as a prop. We repurpose it to also serve as the SSE filter key.

---

## Migration / Backward Compatibility

### Backward Compatibility Guarantees

| Scenario                           | Before                                        | After                           | Compatible?    |
| ---------------------------------- | --------------------------------------------- | ------------------------------- | -------------- |
| Single project, no URL params      | Shows all sessions (which is the one project) | Shows project-scoped sessions   | ✅ Same result |
| Multi-project, `GET /api/sessions` | Returns all sessions                          | Returns all sessions (no param) | ✅ Same result |
| Multi-project, `GET /api/events`   | Streams all sessions                          | Streams all sessions (no param) | ✅ Same result |
| Existing client using old API      | Works                                         | Works (params optional)         | ✅ Same result |

### Migration Steps (Zero Downtime)

1. **Phase 1: API Support** — Add `project` query param support to both endpoints (optional param, defaults to all)
2. **Phase 2: Frontend Adoption** — Update `page.tsx` and `useSessionEvents` to pass project filter
3. **Phase 3: Documentation** — Update README and examples to document multi-project URL scheme

**No database migration required** — `Session.projectId` already exists.

### Breaking Changes

**None.** All changes are additive. Existing deployments continue to work without modification.

---

## Acceptance Criteria

### Must Have

- [ ] `GET /api/sessions?project=X` returns only sessions for project X
- [ ] `GET /api/events?project=X` streams only sessions for project X
- [ ] `DashboardStats` reflects only filtered sessions when project param present
- [ ] `orchestratorId` returns the orchestrator for the scoped project (not any orchestrator)
- [ ] `page.tsx` passes `projectName` as filter to both SSR fetch and SSE
- [ ] `useSessionEvents` accepts optional `project` param and constructs URL accordingly
- [ ] No project param = all sessions (backward compatible)
- [ ] Non-existent project = empty sessions, zero stats, null orchestrator
- [ ] Type safety: query params typed in route handlers

### Should Have

- [ ] URL `/?project=all` explicitly shows all sessions (for multi-project users who want overview)
- [ ] Project filter logged in API request for debugging

### Nice to Have

- [ ] Dashboard shows project name prominently when scoped
- [ ] Project switcher UI (future work, not in scope)

---

## Test Matrix

### Unit Tests

| Test Case                                    | File                             | Description                                                                      |
| -------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Project filter matches by projectId          | `api/sessions/route.test.ts`     | Session with `projectId: "my-app"` appears when `?project=my-app`                |
| Project filter matches by sessionPrefix      | `api/sessions/route.test.ts`     | Session ID `app-123` appears when `?project=my-app` where `sessionPrefix: "app"` |
| No filter returns all                        | `api/sessions/route.test.ts`     | All sessions returned when no query param                                        |
| Non-existent project returns empty           | `api/sessions/route.test.ts`     | Empty array + zero stats when `?project=nonexistent`                             |
| Stats reflect filtered sessions              | `api/sessions/route.test.ts`     | `needsReview` = 1 when filtered set has 1 review-pending PR                      |
| Orchestrator scoped to project               | `api/sessions/route.test.ts`     | Returns `my-app-orchestrator` not `other-orchestrator` when `?project=my-app`    |
| SSE filters by project                       | `api/events/route.test.ts`       | Snapshot event only includes sessions matching project                           |
| useSessionEvents constructs URL with project | `hooks/useSessionEvents.test.ts` | Hook creates EventSource with `?project=X` param                                 |

### Integration Tests

| Test Case                         | File                              | Description                                             |
| --------------------------------- | --------------------------------- | ------------------------------------------------------- |
| Full SSR flow with project filter | `app/page.test.tsx`               | Page renders with filtered sessions from SSR            |
| Client-SSE sync                   | `__tests__/api-routes.test.ts`    | SSE snapshot matches SSR initial state for same project |
| Multi-project isolation           | `__tests__/multi-project.test.ts` | Switching projects via URL changes session set          |

### E2E Tests (Playwright)

| Test Case           | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| Single project view | Load dashboard, verify sessions belong to configured project                      |
| URL project param   | Navigate to `/?project=my-app`, verify only that project's sessions               |
| All projects view   | Navigate to `/?project=all`, verify all sessions shown                            |
| Real-time filter    | Spawn session in project A, verify project B dashboard doesn't receive SSE update |

---

## Self-Audit

### Risks

| Risk                                          | Likelihood | Impact                         | Mitigation                                                              |
| --------------------------------------------- | ---------- | ------------------------------ | ----------------------------------------------------------------------- |
| Project name mismatch (config vs URL)         | Medium     | Confusion                      | Log warning when URL param doesn't match any configured project         |
| Session missing projectId                     | Low        | Incorrect filtering            | Fallback to sessionPrefix matching (existing `resolveProject` behavior) |
| SSE client doesn't reconnect with new project | Low        | Stale data                     | `useSessionEvents` recreates EventSource when `project` prop changes    |
| Performance regression (filter overhead)      | Very Low   | Slower API                     | Filter is O(n) in-memory; negligible for typical session counts (<100)  |
| Orchestrator not found for project            | Medium     | UI missing orchestrator button | Return `null`, gracefully hide orchestrator link                        |

### Edge Cases

1. **Session with `projectId` that doesn't match any config project**
   - Current: Fallback to sessionPrefix or first project
   - Target: Same fallback behavior; won't appear in project-scoped view unless matches prefix

2. **Multiple orchestrators (one per project)**
   - Current: Only one surfaced (first found)
   - Target: Orchestrator for scoped project surfaced

3. **Project renamed in config**
   - Sessions with old `projectId` won't match new name
   - Mitigation: sessionPrefix matching still works; user can use `?project=all` to find orphaned sessions

4. **Empty project (no sessions)**
   - Returns empty sessions, zero stats
   - Dashboard shows "no sessions" message (existing behavior)

5. **Special project name "all"**
   - Reserved for showing all sessions
   - If user has a project named "all", they must use exact match or rename project

### Rollback Plan

If issues arise post-deployment:

1. **Immediate** — Remove `project` param from frontend, revert to unfiltered behavior
2. **API** — Leave backend filter in place (backward compatible), frontend just stops using it
3. **Full Rollback** — Revert commit, redeploy. No data migration needed.

### Monitoring & Observability

- Log API requests with `project` param (debug level)
- Track SSE connections per project (metric)
- Alert on empty project results for configured projects (might indicate config drift)

---

## Out of Scope

The following are explicitly **NOT** part of this change:

- Project switcher UI component
- Per-project dashboard themes/branding
- Database schema changes
- Multi-tenant authentication/authorization
- Session migration between projects
- Project-level access control

---

## References

- `packages/web/src/lib/serialize.ts` — `resolveProject()` function (existing)
- `packages/core/src/types.ts` — `Session.projectId` field (existing)
- `agent-orchestrator.yaml.example` — Project configuration schema
