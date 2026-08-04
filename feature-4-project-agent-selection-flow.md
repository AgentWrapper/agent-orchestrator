# Feature 4 — Project-Level Agent Selection

Design and interaction-flow specification for the landing-page showcase of the Electron app's **Project Settings → Agents** flow: changing the worker and orchestrator agents of an **existing** project. This document is implementation-ready but contains no implementation. All facts below were verified against the repository, not inferred from screenshots.

**Flow decision (Option B):** this spec covers the *existing-project settings* journey — project → Project Settings → Agents section → "Default worker agent" / "Default orchestrator agent" → Save changes. The create-time "Project agents" modal (`CreateProjectAgentSheet`, sidebar "+" → folder picker → "Create and start") was considered (Option A) and rejected: Feature 4's message is per-project agent choice for a project you already run, and the settings surface is where that choice lives day-to-day. Option A remnants (folder picker, "Create and start", project-creation success) are intentionally excluded.

Sources inspected:

- Electron flow: `frontend/src/renderer/components/ProjectSettingsForm.tsx`, `CreateProjectAgentSheet.tsx` (exports `RequiredAgentField`), `components/settings/{SettingsOptionMenu,SettingsPanel,SettingsPageShell,SettingsRow,SettingsSection,AgentSelectMenuItem}.tsx`, `Sidebar.tsx`, `hooks/useAgentsQuery.ts`, `lib/agent-options.ts`, `lib/agent-select-options.ts`, `lib/spawn-orchestrator.ts`, `components/AgentAvatar.tsx`, `routes/_shell.tsx`
- Labels: `frontend/src/renderer/i18n/en.json` (`settings.project.*`, `shell.*`)
- Design system: `frontend/src/styles/tokens.css`, `frontend/src/renderer/styles.css`, `frontend/src/renderer/components/ui/{dropdown-menu,select,button,input}.tsx`
- Landing page: `frontend/src/landing/src/app/page.tsx`, `components/FeaturesSection/{FeaturesSection.tsx,constants.ts,components/*}`

---

## 1. Feature purpose

Feature 4 on the landing page is the **"Coverage"** feature (`frontend/src/landing/src/app/components/FeaturesSection/constants.ts`, 4th entry in `FEATURES`):

- Tag: **Coverage**
- Title: **"Use the agent you already trust"**
- Description mentions 23 supported harnesses with **per-project agent choice**.

The section must communicate one concrete product truth: **for each individual project, the user picks a separate default worker agent and a separate default orchestrator agent** — from a catalog of real, availability-checked agents — and that choice is a normal, changeable project setting. The current demo (`HarnessCoverageDemo`) already gestures at this with two cycling dropdowns, but it is an invented settings mock: wrong menu anatomy, invented "Save changes" placement, no project context, no real settings page. The redesign shows the **actual Project Settings → Agents flow** end to end: open an existing project's settings, change both agents through the real dropdown experience (icons, ranking, auth statuses), save, and see the updated values stick.

## 2. Actual Electron flow

Verified flow in the Electron renderer for an **existing** project:

1. **Project open.** The user is in the desktop app with a project selected (`frontend/src/renderer/routes/_shell.tsx`); the sidebar lists the project with its sessions (`frontend/src/renderer/components/Sidebar.tsx`).
2. **Open Project Settings.** Hovering the project row reveals a **⋮ (MoreVertical) "Project actions"** menu; its **"Project settings"** item (Settings icon) calls `selection.goSettings(workspace.id)` → navigate to `/projects/$projectId/settings` (`Sidebar.tsx:628-644`; the navigation helper is defined at `Sidebar.tsx:124`). A secondary path: if a project has no configured orchestrator agent, the hover **Orchestrator** button routes to settings instead of spawning (`Sidebar.tsx:487-490`). The global gear in the sidebar footer opens *global* settings (`/settings`) — **not** this flow.
3. **Settings page renders.** Not a modal: `SettingsPageShell` → `SettingsPanel` (`components/settings/SettingsPanel.tsx`) is a full-page centered column, max-width 768px, padding 64px 32px 80px, header "Settings" + the project path as a mono subtitle, close **X** top-right (Esc also closes, returning to `/projects/$projectId`). The project loads via `GET /api/v1/projects/{id}`; loading shows a muted loading line, failure shows an error line.
4. **Agents section.** A `SettingsSection` titled **"Agents"** contains, in order (`ProjectSettingsForm.tsx:279-353`):
   - **"Default worker agent"** row — `Bot` icon, `RequiredAgentField variant="settings-row"` (imported from `CreateProjectAgentSheet.tsx`), current value shown in the trigger with the agent's icon.
   - **"Default orchestrator agent"** row — `Network` icon, same field component.
   - **"Refresh agents"** row — `RefreshCw` icon, button "Refresh" / "Refreshing…" (icon spins while pending), error text below on failure.
   - "Model override" input and "Permission mode" select (present in the real section; not part of the demo narrative).
5. **Change an agent.** Clicking a row's trigger opens a `SettingsOptionMenu` (Radix `DropdownMenu`, `align="end"`) listing the ranked agent catalog; each row shows the agent icon, label, optional status text, and a selected-row highlight. Unauthorized/unknown entries are disabled at `opacity-45`. Selecting an option updates local form state only — **nothing is persisted yet**.
6. **Save.** The **"Save changes"** submit button lives in the form's sticky footer area (for non-scratch projects it renders at the end of the form, after the Issue intake section — `ProjectSettingsForm.tsx:370-386`). On submit: validation (worker + orchestrator required; name required; intake assignee required when intake enabled) → `PUT /api/v1/projects/{id}` with the full config (`worker.agent`, `orchestratorAgent`, etc.). Button label switches to **"Saving…"** while pending.
7. **Orchestrator replacement.** If the orchestrator agent changed — or the live orchestrator runs a different provider — the app respawns it via `spawnOrchestrator(projectId, "settings", true)` (`ProjectSettingsForm.tsx:176-188`). Failure here is non-fatal: a warning line "…restart failed" appears under the button.
8. **Success.** On success: **"Saved."** in success color under the button (`text-success`, line 425-427), project + workspace queries invalidated; the settings page stays open with the new values visible in both rows.
9. **Close.** X / Esc navigates back to the project board.

## 3. Existing component map

| UI element | Component | File path | Important props | State / data dependency | Direct reuse? | Landing adapter? |
|---|---|---|---|---|---|---|
| Project row (sidebar) | workspace row + hover actions | `frontend/src/renderer/components/Sidebar.tsx` (~470-650) | `workspace` | `useWorkspaceQuery` | No | Yes (visual only) |
| Settings trigger | ⋮ menu → "Project settings" `DropdownMenuItem` | `Sidebar.tsx:628-644` | — | `selection.goSettings` → router | No | Yes (visual only) |
| Settings page shell | `SettingsPageShell` / `SettingsPanel` | `components/settings/SettingsPageShell.tsx`, `SettingsPanel.tsx` | `onClose`, `subtitle` (project path) | router, project query | Yes (layout) | Yes |
| Agents section | `SettingsSection` + `SettingsRow` | `components/settings/SettingsSection.tsx`, `SettingsRow.tsx` | `title="Agents"`, `icon` | — | Yes | Minor |
| Worker agent row | `RequiredAgentField` `variant="settings-row"` (icon `Bot`) | `CreateProjectAgentSheet.tsx:337-466`, used at `ProjectSettingsForm.tsx:280-293` | `value`, `options`, `onChange`, `disabled`, `invalid` | local form state + agents query | Yes (visual) | Yes (static options) |
| Orchestrator agent row | `RequiredAgentField` `variant="settings-row"` (icon `Network`) | same, `ProjectSettingsForm.tsx:294-307` | same | same | Yes (visual) | Yes |
| Agent dropdown | `SettingsOptionMenu` (Radix `DropdownMenu`) | `components/settings/SettingsOptionMenu.tsx` | `value`, `options`, `renderTrigger`, `renderMenuItem` | Radix DropdownMenu, portal | Yes | Yes |
| Dropdown row | `AgentSelectMenuItem` | `components/settings/AgentSelectMenuItem.tsx` | `agentId`, `label`, `selected`, `status`, `statusTone`, `disabled` | — | Yes | Minor |
| Agent icon | `AgentAvatar` (`LOGOS` record) | `components/AgentAvatar.tsx` | `provider`, `className` (rows use `size-icon-lg`) | assets in `frontend/src/renderer/assets/agents/` | Yes (with assets) | Asset copy only |
| Agent list source | `agentsQueryOptions`, `refreshAgents` | `hooks/useAgentsQuery.ts` | — | daemon `GET/POST /api/v1/agents(/refresh)` | **No — daemon-only** | Static fixture from `lib/agent-options.ts` |
| Availability ranking | `buildRankedAgentOptions`, `agentStatus` | `lib/agent-select-options.ts` | — | authorized/installed sets | Yes (pure function) | Yes (feed fixture) |
| Refresh row | `SettingsRow` + button | `ProjectSettingsForm.tsx:308-319` | `isPending` | `POST /api/v1/agents/refresh` mutation | No | Yes (fake timer) |
| Save button + states | `SaveChangesFooter` | `ProjectSettingsForm.tsx:391-433` | `isPending`, `savedAt`, `validationError`, `replacementError` | `PUT /api/v1/projects/{id}` mutation | Yes (visual) | Yes (scripted) |
| Orchestrator respawn | `spawnOrchestrator` | `lib/spawn-orchestrator.ts` | `projectId`, source, replace | daemon `POST /api/v1/sessions` | **No — daemon-only** | Simulated ("Saved." suffices) |
| Issue intake (context) | `IntakeFields` `variant="settings"` | `components/IntakeFields.tsx` | `form`, `onChange`, `repoPreview` | local form state | Optional | Optional (may be cropped) |
| Close (X / Esc) | `SettingsPanel` header button | `SettingsPanel.tsx:45-48` | `onClose` | router | Yes (visual) | Minor |

## 4. Static landing-page state

What is visible **before** the animation starts (and what the loop returns to):

- **App shell:** the existing `FeaturePreviewShell` (`FeaturePreviewShell.tsx`) — mac-chrome title bar (traffic lights, AO logo, "Agent Orchestrator") — the established frame for all five feature demos.
- **Visible app region:** a compact two-pane composition — a slim **sidebar** (project list with 1-2 projects; the demo project row shows its sessions and, on cursor approach, the ⋮ hover action) beside a dimmed **project board** (a few session cards, non-interactive). This matches the real starting point: project open, board visible.
- **Project state:** the demo project (e.g. "agent-orchestrator") is the selected/active row. Its current agents are not yet visible — they live behind settings, which is the point of the journey.
- **Settings state:** **closed**. No panel, no dropdowns.
- **Readable at small size:** project name in the sidebar, the ⋮ affordance (on hover), then later: "Settings" title, "Agents" section heading, both row labels, agent names + icons, "Save changes". These must survive scaling to the ~570px preview width.
- **Safe to crop:** titlebar nav, inspector rail, terminal pane, topbar, command palette, most of the board, and (inside settings) the Identity/Worktrees/Reviewers sections — the scroll can land directly on Agents.
- **Must not be removed:** the ⋮ → "Project settings" trigger (this is how the product actually opens it), the settings header with the project path subtitle, the "Agents" section heading, both agent rows with real icons, the "Refresh agents" row, and the real "Save changes" button with its "Saving…"/"Saved." states. The save button's real position (bottom of the settings form) may be pulled into view by cropping intermediate sections — its appearance and copy must not change.

## 5. Animated showcase flow

Total loop ≈ **16-18 s**, hold, reset, repeat. Timing follows the established demo pattern (`setTimeout` sequences as in `HarnessCoverageDemo` / `DelegationDemo`, paused when out of view or on hover). A simulated cursor (`DemoCursor`) performs all actions. Demo data: worker changes **Codex → Cursor**, orchestrator changes **Codex → Claude Code** (different roles, different agents — the feature's whole point).

| # | Duration | Visible UI state | Cursor / user action | Component state change | Highlighted text | Transition |
|---|---|---|---|---|---|---|
| 1 | 1.5 s | Compact shell: sidebar + board, demo project selected | Cursor rests, glides onto the project row | Row hover state; hover actions (incl. ⋮) fade in | Project name | hover reveal |
| 2 | 1.0 s | Same | Cursor clicks **⋮** | "Project actions" menu opens (New session / **Project settings** / Remove) | "Project settings" item | menu appears (instant in real app; ≤120 ms fade acceptable) |
| 3 | 1.4 s | Menu open | Cursor clicks **"Project settings"** | View cross-fades to the Settings page: header "Settings" + project path subtitle, X close button; content scrolled to the **Agents** section | "Settings" + path | page transition (router push in real app) |
| 4 | 1.2 s | Settings → Agents visible: worker row (Codex), orchestrator row (Codex), refresh row | Cursor idles briefly on the section | none | "Agents" heading, both row labels | settle |
| 5 | 1.6 s | Same | Cursor clicks the **Default worker agent** trigger | `SettingsOptionMenu` opens (end-aligned) with the ranked agent list: icons, labels, statuses ("Needs auth" warning on one row), Codex highlighted as current | "Default worker agent" | menu open |
| 6 | 1.4 s | Menu open; rows highlight as cursor passes | Cursor hovers, clicks **Cursor** | Menu closes; worker trigger now shows Cursor icon + label (local state only — not saved yet) | "Cursor" | trigger update |
| 7 | 1.6 s | Settings page | Cursor clicks the **Default orchestrator agent** trigger | Menu opens for the orchestrator row, same list | "Default orchestrator agent" | menu open |
| 8 | 1.4 s | Menu open | Cursor clicks **Claude Code** | Menu closes; orchestrator trigger shows Claude Code | "Claude Code" | trigger update |
| 9 | 1.2 s | Settings page, both rows updated, unsaved | Cursor moves to **"Save changes"** | Button hover | "Save changes" | hover |
| 10 | 1.2 s | Same | Cursor clicks | Button label → **"Saving…"**, disabled (real `isPending`) | "Saving…" | label swap |
| 11 | 1.6 s | Same | Cursor idle | Label back to "Save changes" + **"Saved."** appears beneath in success color (real `SaveChangesFooter` success state); both rows keep the new values | "Saved." | success text fades in |
| 12 | 2.0 s | **Hold** on the saved state — worker: Cursor, orchestrator: Claude Code, "Saved." visible | none | none | — | hold |
| 13 | 0.6 s | Reset: fade back to scene 1 (board view, agents back to Codex/Codex) | none | all showcase state reset | — | cross-fade; loop |

Deliberate compressions vs. the real app: the settings page open is a cross-fade instead of a full route transition; intermediate settings sections (Identity, Worktrees, Model override, Permission mode, Reviewers, Issue intake) are cropped so Agents and the save button share one frame; the background orchestrator respawn (`spawnOrchestrator`) is not visualized — the real UI only surfaces it via "Saved." (or a warning on failure), so the replica showing "Saved." is exactly faithful.

## 6. Dropdown flow

Real implementation: `SettingsOptionMenu` (`components/settings/SettingsOptionMenu.tsx`) over Radix `DropdownMenu` (`ui/dropdown-menu.tsx`), driven by `RequiredAgentField` in `settings-row` variant.

- **Trigger:** a bare button (`settings-option-trigger`) inside the settings row: agent icon (`AgentAvatar`, `size-icon-lg` = 15px) + current label + `ChevronDown` (13px, opacity-70). Hover: text brightens to `text-settings-label`. Disabled while the agent catalog is loading (`agentsQuery.isFetching && agentCatalog === undefined`).
- **Opening:** click; Radix `DropdownMenuContent` renders in a **portal** at `z-overlay` (50), `align="end"`, `sideOffset=6`. Real open/close animation: **instant** — the `animate-popover-in/out` classes resolve to no keyframes in the built bundle (verified against `frontend/dist/assets/index-*.css`); only `overlay-in`/`modal-in` emit CSS. A ≤120 ms fade in the replica is an acceptable legibility aid, not a redesign.
- **Surface:** `settings-menu-surface` — `rounded-(--radius-settings-panel)`, `border-settings-menu`, `bg-settings-menu`, shadow `--shadow-popover` (= `--elevation-xl`), `max-h` capped at `--size-select-menu-max` (320px) with vertical scroll.
- **Options:** ranked list from `buildRankedAgentOptions()` — authorized first, then auth-unknown, then installed-unauthorized, then not-installed; ties broken by priority rank (`claude-code, codex, cursor, opencode, aider`) then label. Real catalog: 23 ids (`lib/agent-options.ts`). The compact replica shows **5-6 rows**: Claude Code, Codex, Cursor, OpenCode, Aider + one disabled "Needs auth" row (e.g. Gemini CLI is **not** in the real 23-id catalog — pick a real id such as `goose` for the unauthorized row).
- **Row anatomy** (`AgentSelectMenuItem`): 15px agent icon, label, right-aligned status text, selected row highlighted with `bg-settings-menu-selected` (the settings menu uses a background highlight, not the create-sheet's `Check` mark — keep this distinction). Disabled rows `opacity-45`, not selectable.
- **Status labels:** `""` (authorized), **"Auth unknown"**, **"Needs auth"** (warning tone), **"Needs install"** (muted).
- **Hover/highlight:** `data-highlighted:bg-settings-menu-selected data-highlighted:text-settings-label`.
- **Closing:** on select, `Esc`, or outside pointer-down (Radix defaults). Selection updates local form state only — persistence happens at "Save changes".
- **Keyboard:** Radix DropdownMenu semantics — arrows, type-ahead, Enter, Esc. Reused for free if the replica keeps Radix; the scripted cursor does not demo it.
- **Compact landing version:** same anatomy at preview scale; menu rendered **inline inside the preview card** (custom portal container) instead of `document.body`, so scaling and `overflow-hidden` cropping can't detach or clip it.

## 7. Interaction states

| Showcase state | Real app counterpart |
|---|---|
| Initial (board + sidebar) | Project open on `/projects/$projectId` |
| Project row hover | Sidebar hover actions revealed (real hover CSS) |
| Actions menu open | ⋮ `DropdownMenu` with "Project settings" (`Sidebar.tsx:628-644`) |
| Settings open (Agents) | Route `/projects/$projectId/settings`, `SettingsPanel` + Agents `SettingsSection` |
| Agents loading *(optional)* | `agentsQuery.isFetching && catalog undefined` → both rows disabled |
| Worker menu open | `SettingsOptionMenu` open on "Default worker agent" |
| Worker changed (unsaved) | `form.workerAgent` local state (`ProjectSettingsForm.tsx:106`) |
| Orchestrator menu open | Menu on "Default orchestrator agent" |
| Orchestrator changed (unsaved) | `form.orchestratorAgent` local state |
| Refreshing *(optional)* | `refreshAgentsMutation.isPending` → "Refreshing…" + spinning icon |
| Refresh error *(optional)* | error text under the refresh row (`ProjectSettingsForm.tsx:320-326`) |
| Saving | mutation pending → "Saving…", button disabled |
| Saved | `savedAt` set → "Saved." (`text-success`); values persist in rows |
| Replacement warning *(optional)* | orchestrator respawn failed → warning line (`:428-430`) |
| Validation error *(not shown)* | "Worker and orchestrator agents are required." etc. (`:211-222`) |
| Resetting | replica controller resets to initial (real app has no equivalent) |

Default loop: Initial → Row hover → Menu open → Settings open → Worker menu → Worker changed → Orchestrator menu → Orchestrator changed → Saving → Saved → Resetting. Loading/refresh/error/warning states are optional variant scenes, not part of the loop.

## 8. Visual fidelity rules

All values from `frontend/src/styles/tokens.css` and `frontend/src/renderer/styles.css` (dark theme, the app default). Settings surfaces use the dedicated `settings-*` token family (`@theme`/`@utility` blocks in `styles.css`); where a setting token aliases a core token, the core value is given.

- **Typography:** Geist Variable (`@fontsource-variable/geist`; landing already loads `GeistSans` via the `geist` package — same family). Settings title `text-settings-heading` bold; section headings small/muted; row labels 13px (`text-control`); menu items `text-control`; helper text 12px. Weights: medium 500, semibold 600, bold for the page title.
- **Colors (dark, oklch):** `--background: oklch(0.185 0.006 285.885)`, `--card: oklch(0.24 0.008 285.885)`, `--foreground: oklch(0.985 0 0)`, `--muted-foreground: oklch(0.705 0.015 286.067)`, `--primary: oklch(0.92 0.004 286.32)` on `--primary-foreground: oklch(0.21 0.006 285.885)`, `--border: oklch(1 0 0 / 7%)`, `--input: oklch(1 0 0 / 4%)`, `--ring: oklch(0.552 0.016 285.938)`, `--destructive: oklch(0.704 0.191 22.216)`. Settings-specific: `bg-settings-menu`, `border-settings-menu`, `bg-settings-menu-selected`, `text-settings-label`, `text-settings-muted`, `text-settings-title` (use the real token values from `styles.css`, not approximations). Status tones: warning token for "Needs auth"/"Auth unknown", muted for "Needs install", `text-success` for "Saved.".
- **Radii:** base `--radius: 0.625rem` (10px); settings menu `rounded-(--radius-settings-panel)`; rows/controls `rounded-md`/`rounded-lg` per the settings recipes.
- **Borders:** 1px `--border` family; settings menu `border-settings-menu`; triggers borderless until hover/focus.
- **Shadows:** menus `--shadow-popover` = `--elevation-xl` (`0 20px 50px color-mix(...)` + 1px top highlight). The settings page itself is a flat full-page surface — no modal shadow, no scrim (it is **not** an overlay).
- **Spacing:** settings column max-width 768px (`--size-settings-content-width`), page padding 64px top / 32px x / 80px bottom, section gap `--size-settings-section-gap`; row height ~42px; menu max-height 320px (`--size-select-menu-max`).
- **Icons:** lucide-react; size tokens `--size-icon-sm: 13px`, `lg: 15px`, `base: 16px`. This flow uses: `Settings` (menu item), `Bot` (worker row), `Network` (orchestrator row), `RefreshCw` 16px (refresh row, spins while pending), `ChevronDown` 13px/70% (triggers), `X` 20px (`size-5`, strokeWidth 2.25 — settings close), `TriangleAlert` 12px (errors).
- **Trigger style:** `settings-option-trigger` — bare text-button (icon + label + chevron), no boxed select chrome; hover brightens to `text-settings-label`. Do **not** render it as the create-sheet's boxed `SelectTrigger` — that is the other variant.
- **Menu item style:** `settings-menu-item` — selected and highlighted states via `bg-settings-menu-selected`; no check icon in this variant.
- **Button style (save):** `settings-footer-button settings-footer-button-primary` — the settings footer primary recipe (not the generic `Button` component); disabled state while "Saving…".
- **Animations:** the settings page has no enter animation in the real app (route swap); menus appear instantly (dead popover animation CSS — see §6). The replica's cross-fades and cursor motion are showcase choreography, allowed because they don't alter the product's static look.
- **Hover/focus/selected:** settings-row hover states; trigger hover brighten; menu `data-highlighted` background; selected item persistent `bg-settings-menu-selected`; disabled `opacity-45`/`opacity-50`.

The landing replica must use these real values — the current `featurePreviewTokens` palette (`FeaturePreviewShell.tsx`) is close but not identical; extend the preview theme with the app's actual tokens for this feature.

## 9. Landing-page adaptation rules

**Allowed (identity preserved):**

- Proportional scaling of the whole composition to fit the ~570px preview card (`FeatureDemo` container, `lg:aspect-4/3`).
- Cropping non-participating chrome (titlebar nav, inspector, terminals, most of the board) and non-narrative settings sections (Identity, Worktrees, Model override, Permission mode, Reviewers, Issue intake).
- Mock local data: a static fixture derived from `lib/agent-options.ts` + a fake `{supported, installed, authorized}` inventory instead of `GET /api/v1/agents`.
- A lightweight wrapper driving real visual markup with showcase props (`openMenu`, `worker`, `orchestrator`, `saveState`) instead of live stores/queries.
- Controlled animation state (scripted cursor, timed scenes) instead of live routing/mutations.
- Rendering dropdown content inline within the scaled container (custom portal container) instead of `document.body`.
- Replacing `react-i18next` `t()` calls with the English literals from `en.json` (quoted in this document).
- Cross-fades between board → settings and a ≤120 ms menu fade as choreography (the real app is instant/uncanimated here; this adds no new visual language).

**Not allowed:**

- Redesigning the settings page, rows, or menus; inventing section content.
- Replacing the `SettingsOptionMenu` dropdown with a native `<select>` or the create-sheet's boxed Select variant.
- Inventing agent names, icons, or statuses beyond the real 23-id catalog and the four real status labels.
- Changing the app's visual language (colors, radii, fonts, shadows).
- Displaying controls that don't exist in the product (e.g. auto-save toggles, a "Create and start" button — that belongs to the rejected create flow).
- Porting daemon/Electron business logic (agents probing, `PUT /projects`, `spawnOrchestrator`, router) — simulate them.
- Implementing any of this during the current task (this document only).

## 10. Reuse strategy for later implementation

**A. Safe to reuse as-is**
- `buildRankedAgentOptions` / `agentStatus` (`lib/agent-select-options.ts`) — pure functions; feed them the static fixture.
- Agent logo assets (`frontend/src/renderer/assets/agents/*.{svg,png}`) — copy or reference; several already mirrored under `frontend/src/landing/public/app-icons/`.
- Lucide icons and class recipes (copy class strings, not imports).
- English labels — quoted verbatim from `frontend/src/renderer/i18n/en.json` in this document.

**B. Reusable after extracting visual dependencies**
- `AgentAvatar` — portable once asset imports resolve on the landing side (map id → `/app-icons/*.svg`).
- `AgentSelectMenuItem` — presentational; needs `AgentAvatar` and status-tone classes only.
- `SettingsRow` / `SettingsSection` — layout primitives, trivially portable.

**C. Requires a landing-page adapter**
- `RequiredAgentField` (`settings-row` variant) — keep the trigger/row markup, inject static options and a controlled open-state.
- `SettingsOptionMenu` — keep markup/behavior via Radix DropdownMenu, but portal into the preview card and drive `open` from the scene controller.
- `SettingsPanel` — keep the header/column layout; replace router close with a no-op.
- `SaveChangesFooter` — keep markup; drive `isPending`/`savedAt` from the controller instead of a mutation.
- Token plumbing — landing has its own Tailwind v4 theme; adapter = extend it with the app's `settings-*`/core tokens (§8).

**D. Recreate only as a presentation-state wrapper**
- Sidebar project row + ⋮ "Project settings" menu — visual only; no router.
- Refresh-agents row — fake 900 ms `isPending` timer (pattern already in `HarnessCoverageDemo.refresh()`).
- Save — scripted "Save changes" → "Saving…" → "Saved."; no PUT, no respawn.

**E. Must remain Electron-only**
- `agentsQueryOptions` / `refreshAgents` against the loopback daemon; `api-client.ts`.
- `PUT /api/v1/projects/{id}` mutation and `spawnOrchestrator` (`lib/spawn-orchestrator.ts`).
- Router navigation (`selection.goSettings`), workspace/project queries.
- `aoBridge` IPC (not directly in this flow, but the surrounding shell uses it).

## 11. Suggested future component hierarchy

Names aligned to the actual repo (landing conventions from `FeaturesSection/components/*`):

```
FeaturesSection                        (existing; FEATURES[3] = Coverage)
└── FeatureDemo                        (existing wrapper: background image + overlay)
    └── ProjectAgentsDemo              (replaces HarnessCoverageDemo at DEMO_COMPONENTS[3])
        ├── FeaturePreviewShell        (existing mac-chrome frame)
        ├── CompactAppShell            (sidebar strip + dim board; visual only)
        │   └── ProjectRow             (hover actions incl. ⋮ → "Project settings" menu)
        ├── ProjectSettingsView        (adapter over SettingsPanel markup)
        │   ├── SettingsHeader         ("Settings" + project path + X)
        │   ├── AgentsSection          (SettingsSection "Agents")
        │   │   ├── AgentSettingsRow   (×2: Bot "Default worker agent" / Network "Default orchestrator agent")
        │   │   │   └── AgentOptionMenu (SettingsOptionMenu adapter, inline-portal)
        │   │   │       └── AgentMenuItem (AgentAvatar + label + status; selected highlight)
        │   │   └── RefreshAgentsRow   ("Refresh agents" + Refresh/Refreshing…)
        │   └── SaveChangesFooter      ("Save changes" / "Saving…" / "Saved.")
        ├── DemoCursor                 (simulated cursor; new but generic)
        └── ShowcaseSequenceController (scene state machine + timers + visibility/interaction pause)
```

## 12. Suggested animation architecture

Recommendation: **hybrid — a scene state machine driving motion/react transitions**, matching patterns already in the landing codebase.

- **Pure timeline** (one async script of sleeps): simple but brittle — pause-on-hover, out-of-view gating, and user resync need manual bookkeeping (see `HarnessCoverageDemo`'s `tick()` with `interactingRef`/`inViewRef`). A 13-scene flow would make this worse.
- **Pure state machine** (scene union + `useReducer`): robust pause/resume (freeze the clock, keep the state) and testable, but timing choreography lives awkwardly in reducers.
- **Hybrid (recommended):** `ShowcaseSequenceController` holds the current scene in a reducer (`SCENES: { id, durationMs }[]`), advances via a single timeout, exposes `{ scene, cursorTarget }`. Within/between scenes use **motion/react** (`AnimatePresence` for menu enter-exit — already used in `HarnessCoverageDemo`; spring cursor glide). Pause = stop advancing the reducer (hover/focus via pointer/focus capture; out-of-view via IntersectionObserver — all three patterns exist in `DelegationDemo`/`HarnessCoverageDemo`). Libraries already present: `motion` 12.42 / `framer-motion` 12.38 — nothing new to install. Reduced motion: render scene 11 (the saved state) statically — the approach `DelegationDemo` uses when `prefers-reduced-motion` matches.

## 13. Responsive behaviour

- **Desktop (≥1280px):** full two-column feature row (existing `xl:grid-cols-2`; index 3 is reversed — demo left, text right). Preview card max 570px; full composition (sidebar + board → settings page) visible.
- **Tablet (640-1279px):** single column, text above demo; preview card full width up to 570px; sidebar strip may narrow, but the project row and ⋮ trigger stay visible.
- **Mobile (<640px):** the **settings page becomes the main visual** — open scenes may crop to just the Agents column (drop the sidebar/board preamble or show it heavily scaled), keeping: "Agents" heading, both rows, the open menu, and "Save changes". Follows existing `FeatureDemo` mobile behavior (`min-h-[300px]`, background image + `bg-background/35` overlay).
- **Minimum readable sizes:** row labels ≥ 11px effective, menu rows ≥ 32px tall, trigger touch-equivalent ≥ 36px even though the demo is scripted.
- **Dropdown positioning:** end-aligned under the trigger as in the real `align="end"`; on mobile keep it inside the card (inline portal), flipping above the trigger only if it would clip the card's bottom edge (Radix collision handling gives this for free).
- Hide non-essential chrome below 420px per the existing `hidden min-[420px]:block` pattern (`FeaturePreviewShell.tsx:55`).

## 14. Accessibility and reduced motion

- **Autoplay pauses on interaction:** yes — hover/focus within the demo pauses the sequence (`onPointerEnter`/`onFocusCapture` from `HarnessCoverageDemo`); out-of-view pauses via IntersectionObserver (both existing patterns).
- **Reduced motion:** with `prefers-reduced-motion: reduce`, skip the loop and render the static **saved state** (scene 11: settings open, worker = Cursor, orchestrator = Claude Code, "Saved." visible). Precedent: `DelegationDemo.tsx:652`, `RoadmapSlideshow.tsx` (`useReducedMotion`).
- **Keyboard:** the demo is presentational; interactive controls inside it must either be fully operable (reused Radix primitives keep `aria-expanded`, menu semantics, arrows/type-ahead) or the whole demo region is `aria-hidden` with a descriptive label (`role="img"`, `aria-label="Demo: changing a project's worker and orchestrator agents in settings"`). Never ship focusable-but-scripted controls that fight the user's keyboard.
- **Focus handling:** scripted focus/hover must not steal real DOM focus; visual highlights are simulated.
- **Contrast:** keep the real token pairs (§8); warning status text keeps the warning token; "Saved." keeps `text-success`; don't dim rows below the real `opacity-45` disabled treatment.

## 15. Risks and unknowns

- **Daemon APIs unavailable on the web:** agent inventory, save mutation, orchestrator respawn — all simulated; risk of drift if the real settings form gains fields.
- **Portal-based dropdown positioning:** Radix portals to `document.body`; inside a scaled, `overflow-hidden` preview card this detaches/clips. Must portal into the card (Radix supports custom containers); scaled-container collision behavior needs verification.
- **Component forking:** extracting "visual only" versions of `RequiredAgentField`/`SettingsOptionMenu`/`SaveChangesFooter` forks markup that can drift from the real components. Mitigation: copy once, comment the source path, accept manual sync.
- **Agent availability requires runtime probing:** statuses come from the daemon (`POST /agents/refresh`); the fixture freezes one plausible inventory (4-5 authorized, 1 needs-auth). If the priority list or catalog changes, the fixture ages.
- **Two dropdown variants exist** (settings-row `SettingsOptionMenu` vs create-sheet boxed `Select`); using the wrong one is an easy mistake — this spec pins the settings-row variant.
- **Asset duplication:** agent logos would live in both `frontend/src/renderer/assets/agents/` and `frontend/src/landing/public/app-icons/` (partially true already). First-party assets, no licensing concern; a sync script may be wanted later.
- **Responsive readability:** the settings column is 768px with 12-13px text; scaled into a 570px card at mobile, text can dip low — enforce §13 minimums even if the frame slightly overflows "true" scale.
- **Token mismatch:** the landing preview palette differs from the app's oklch tokens; using it for the settings surfaces would subtly change the product's look — use the real values (§8).
- **"Saved." is ephemeral in the real app** (set on each save, cleared on next submit); the replica holds it for the pause scene — faithful enough, but noted.
- **Dead animation CSS:** dropdowns/menus appear instantly in the real build (popover animation classes emit nothing); do not "fix" the replica to be fancier than the product.

## 16. Final recommended flow

**Feature 4 — Project-Level Agent Selection (approved sequence):**

> Compact AO shell with the demo project on its board → cursor hovers the project row, opens the **⋮ menu**, clicks **"Project settings"** → the real Settings page appears (header + project path), scrolled to the **Agents** section → **Default worker agent** menu opens with the real ranked agent list (icons + auth statuses) → worker changes **Codex → Cursor** → **Default orchestrator agent** menu opens → orchestrator changes **Codex → Claude Code** → cursor clicks **"Save changes"** → **"Saving…"** → **"Saved."** in success color, both rows keeping their new agents → **hold 2 s** → fade back to the board → loop. Autoplay pauses on hover/focus and out-of-view; with reduced motion, only the saved settings frame is shown statically.

Copy note: the existing `FEATURES[3]` tag/title/description ("Coverage" / "Use the agent you already trust") already matches this demo — no copy change required.
