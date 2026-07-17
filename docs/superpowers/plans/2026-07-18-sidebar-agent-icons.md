# Sidebar Agent Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small official Agent icon beside the existing status dot for every active Worker in the default-expanded left project tree.

**Architecture:** Bundle one normalized PNG per supported `AgentProvider` and expose them through a renderer-local, exhaustive `AgentIcon` component. `Sidebar.SessionRow` consumes the existing `session.provider`; the daemon API and workspace query stay unchanged.

**Tech Stack:** React 19, TypeScript 5.6, Tailwind CSS 4, Radix Tooltip, Vitest, Testing Library, Vite/Electron.

## Global Constraints

- Cover all 23 values in the current `AgentProvider` union.
- Source marks from official project websites or official source repositories.
- Store every mark on a transparent 64 by 64 pixel canvas and bundle it with the renderer.
- Render icons at 14 by 14 pixels beside, not over, the existing 6 by 6 pixel status dot.
- Preserve the existing status colors, animation, active-session filtering, and manual project collapse behavior.
- Preserve the current default-expanded project state; do not add persistence or API changes.
- Do not modify issue-intake polling behavior.

---

## File Structure

- Create `frontend/src/renderer/assets/agents/*.png`: normalized offline Agent marks.
- Create `frontend/src/renderer/components/AgentIcon.tsx`: exhaustive provider-to-asset and provider-to-label mapping plus tooltip.
- Create `frontend/src/renderer/components/AgentIcon.test.tsx`: mapping coverage and accessibility assertions.
- Modify `frontend/src/renderer/components/Sidebar.tsx`: render `AgentIcon` beside `SessionDot` in normal and rename modes.
- Modify `frontend/src/renderer/components/Sidebar.test.tsx`: default expansion and per-provider icon regressions.

### Task 1: Normalized Agent Assets And Mapping Component

**Files:**
- Create: `frontend/src/renderer/assets/agents/claude-code.png`
- Create: `frontend/src/renderer/assets/agents/codex.png`
- Create: `frontend/src/renderer/assets/agents/aider.png`
- Create: `frontend/src/renderer/assets/agents/opencode.png`
- Create: `frontend/src/renderer/assets/agents/grok.png`
- Create: `frontend/src/renderer/assets/agents/droid.png`
- Create: `frontend/src/renderer/assets/agents/amp.png`
- Create: `frontend/src/renderer/assets/agents/agy.png`
- Create: `frontend/src/renderer/assets/agents/crush.png`
- Create: `frontend/src/renderer/assets/agents/cursor.png`
- Create: `frontend/src/renderer/assets/agents/qwen.png`
- Create: `frontend/src/renderer/assets/agents/copilot.png`
- Create: `frontend/src/renderer/assets/agents/goose.png`
- Create: `frontend/src/renderer/assets/agents/auggie.png`
- Create: `frontend/src/renderer/assets/agents/continue.png`
- Create: `frontend/src/renderer/assets/agents/devin.png`
- Create: `frontend/src/renderer/assets/agents/cline.png`
- Create: `frontend/src/renderer/assets/agents/kimi.png`
- Create: `frontend/src/renderer/assets/agents/kiro.png`
- Create: `frontend/src/renderer/assets/agents/kilocode.png`
- Create: `frontend/src/renderer/assets/agents/vibe.png`
- Create: `frontend/src/renderer/assets/agents/pi.png`
- Create: `frontend/src/renderer/assets/agents/autohand.png`
- Create: `frontend/src/renderer/components/AgentIcon.tsx`
- Create: `frontend/src/renderer/components/AgentIcon.test.tsx`

**Interfaces:**
- Consumes: `AgentProvider` from `frontend/src/renderer/types/workspace.ts`.
- Produces: `AgentIcon({ provider, className? }: { provider: AgentProvider; className?: string }): JSX.Element`.

- [ ] **Step 1: Write the failing mapping test**

Create a test that renders all values from `AGENT_OPTIONS` and asserts every trigger has `role="img"`, an accessible product label, `data-agent-provider`, and a non-empty bundled `src`:

```tsx
for (const provider of AGENT_OPTIONS) {
  const { unmount } = render(
    <TooltipProvider><AgentIcon provider={provider} /></TooltipProvider>,
  );
  const icon = screen.getByRole("img");
  expect(icon).toHaveAttribute("data-agent-provider", provider);
  expect(icon.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/\.png$/));
  unmount();
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- AgentIcon.test.tsx`

Expected: FAIL because `AgentIcon.tsx` does not exist.

- [ ] **Step 3: Collect and normalize the official assets**

Reuse verified agent-specific assets already under `frontend/src/landing/public/docs/logos/`. Fetch missing marks from the official Amp, Antigravity, Augment Code, Cline, and Autohand sites. Replace the generic GitHub favicon for Copilot with GitHub's official `copilot-48.svg` from `primer/octicons`. Convert each source while preserving aspect ratio:

```text
Amp:       https://ampcode.com/amp-mark-color.svg
Agy:       https://antigravity.google/favicon.ico
Auggie:    https://augmentcode.com/favicon.svg
Cline:     https://cline.bot/assets/branding/favicons/favicon-256x256.png
Autohand:  https://autohand.ai/favicon.svg
Copilot:   https://raw.githubusercontent.com/primer/octicons/main/icons/copilot-48.svg
```

```bash
sips -s format png source.svg --out /tmp/source.png
ffmpeg -i source.png -vf "scale=48:48:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -frames:v 1 destination.png
```

Rasterize SVG inputs to PNG first, then apply the same normalization. Verify with `file frontend/src/renderer/assets/agents/*` that all outputs are 64 by 64 PNG images.

- [ ] **Step 4: Implement the exhaustive component**

Add static imports and an exhaustive mapping:

```tsx
type AgentIconMeta = { src: string; label: string };

const AGENT_ICON_META: Record<AgentProvider, AgentIconMeta> = {
  "claude-code": { src: claudeCodeIcon, label: "Claude Code" },
  codex: { src: codexIcon, label: "Codex" },
  aider: { src: aiderIcon, label: "Aider" },
  opencode: { src: opencodeIcon, label: "OpenCode" },
  grok: { src: grokIcon, label: "Grok Build" },
  droid: { src: droidIcon, label: "Droid" },
  amp: { src: ampIcon, label: "Amp" },
  agy: { src: agyIcon, label: "Agy" },
  crush: { src: crushIcon, label: "Crush" },
  cursor: { src: cursorIcon, label: "Cursor" },
  qwen: { src: qwenIcon, label: "Qwen Code" },
  copilot: { src: copilotIcon, label: "GitHub Copilot" },
  goose: { src: gooseIcon, label: "Goose" },
  auggie: { src: auggieIcon, label: "Auggie" },
  continue: { src: continueIcon, label: "Continue" },
  devin: { src: devinIcon, label: "Devin" },
  cline: { src: clineIcon, label: "Cline" },
  kimi: { src: kimiIcon, label: "Kimi" },
  kiro: { src: kiroIcon, label: "Kiro" },
  kilocode: { src: kilocodeIcon, label: "Kilo Code" },
  vibe: { src: vibeIcon, label: "Mistral Vibe" },
  pi: { src: piIcon, label: "Pi" },
  autohand: { src: autohandIcon, label: "Autohand" },
};
```

Render a fixed `size-3.5` tooltip trigger with `role="img"`, `aria-label`, and an inner decorative `<img className="size-full object-contain" alt="" />`.

- [ ] **Step 5: Run the focused test**

Run: `cd frontend && npm test -- AgentIcon.test.tsx`

Expected: PASS for all 23 providers.

- [ ] **Step 6: Commit Task 1**

```bash
git add frontend/src/renderer/assets/agents frontend/src/renderer/components/AgentIcon.tsx frontend/src/renderer/components/AgentIcon.test.tsx
git commit -m "feat: add official agent icons"
```

### Task 2: Sidebar Integration And Default-Expansion Regression

**Files:**
- Modify: `frontend/src/renderer/components/Sidebar.tsx:126-146,748-845`
- Modify: `frontend/src/renderer/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `AgentIcon` from Task 1 and existing `WorkspaceSession.provider`.
- Produces: Worker rows with stable `[AgentIcon][SessionDot][title]` leading content.

- [ ] **Step 1: Write failing sidebar assertions**

Add one test that renders two active Worker sessions with `claude-code` and `codex`, then asserts the project disclosure is expanded and both provider icons are visible before any click:

```tsx
expect(screen.getByRole("button", { name: "Project One" })).toHaveAttribute("aria-expanded", "true");
expect(screen.getByRole("button", { name: "Open fix login" })).toBeVisible();
expect(screen.getByRole("img", { name: "Claude Code" })).toHaveAttribute("data-agent-provider", "claude-code");
expect(screen.getByRole("img", { name: "Codex" })).toHaveAttribute("data-agent-provider", "codex");
```

Extend the rename test to assert the selected provider icon remains rendered while the input is active.

- [ ] **Step 2: Run the sidebar test to verify it fails**

Run: `cd frontend && npm test -- Sidebar.test.tsx`

Expected: FAIL because Worker rows do not yet render Agent icons.

- [ ] **Step 3: Integrate `AgentIcon` in both row states**

Import `AgentIcon`, then replace each single leading `SessionDot` with:

```tsx
<AgentIcon provider={session.provider} />
<SessionDot session={session} />
```

Keep fixed sizes and the existing row gap; do not change title truncation, pencil placement, click handling, status logic, or `collapsedIds` initialization.

- [ ] **Step 4: Run focused and full frontend checks**

Run:

```bash
cd frontend
npm test -- AgentIcon.test.tsx Sidebar.test.tsx
npm run typecheck
npx vite build --config vite.renderer.config.ts
```

Expected: all commands exit 0.

- [ ] **Step 5: Verify visually**

Run the renderer with preview data, open it through `ao preview`, and capture a desktop screenshot. Confirm projects start expanded, each visible Worker has a legible 14 pixel Agent mark followed by the unchanged status dot, long names still truncate, and no row shifts while renaming.

- [ ] **Step 6: Commit Task 2**

```bash
git add frontend/src/renderer/components/Sidebar.tsx frontend/src/renderer/components/Sidebar.test.tsx
git commit -m "feat: show agent icons in worker tree"
```
