# Sidebar Agent Icons Design

## Goal

Make active Worker sessions identifiable by their agent at a glance in the left project tree, while preserving the existing status signal and default-expanded project behavior.

## Scope

- Cover every agent in the current `AgentProvider` union.
- Add a small agent icon to both the normal and inline-rename Worker rows.
- Keep the existing status dot beside the icon rather than overlaying it.
- Keep projects expanded on first render so active Workers are immediately visible.
- Add regression coverage for icon selection and default expansion.

This change does not alter the daemon API, session data, project settings, polling behavior, or which sessions appear in the sidebar.

## Assets

Use marks obtained from each agent's official website or official source repository. Bundle them under `frontend/src/renderer/assets/agents/` so the desktop client never depends on remote image loading.

Normalize every asset to a transparent 64 by 64 pixel canvas, preserving aspect ratio and enough internal padding for visually consistent sizing. Where an official project only publishes a favicon, use that official favicon. Do not invent substitute artwork. The rendered size is 14 by 14 pixels.

## Component Design

Add one renderer-local `AgentIcon` component backed by an exhaustive `Record<AgentProvider, asset>`. It renders the bundled image at the fixed size and exposes the agent name through a tooltip. The exhaustive mapping makes a newly added agent a compile-time update instead of silently showing the wrong logo.

The Worker row leading content is:

```text
[14px agent icon] [6px status dot] [Worker name]
```

Both items use fixed dimensions, so loading, status changes, and editing cannot shift the row. Existing status colors and animation remain unchanged.

## Tree Behavior

The sidebar already initializes its collapsed-project set as empty, which means every project is expanded on first render. Preserve that implementation and add a test asserting that an active Worker is visible without clicking the project disclosure control. Manual collapse continues to work for the current application lifetime.

## Verification

- Component test: every supported provider resolves to a bundled icon.
- Sidebar test: different Worker providers render different icons.
- Sidebar test: projects are expanded and active Workers visible on first render.
- Sidebar test: inline rename retains the same agent icon.
- Run the focused Vitest files, frontend typecheck, and frontend build.
- Run the renderer with preview data and capture a desktop screenshot to confirm icon legibility, alignment, truncation, and default expansion.

## Issue Intake Note

Issue intake remains project-level and opt-in. Clearing `Enable issue intake` and saving prevents that project from polling the provider or spawning issue Workers. The daemon's lightweight global observer still wakes once per minute to inspect project configuration; when no projects are enabled, it returns without calling a tracker provider.
