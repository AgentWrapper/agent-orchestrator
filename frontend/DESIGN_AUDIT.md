# Design Audit — Agent Orchestrator Frontend (Renderer)

**Scope:** `frontend/src/renderer` (excluding landing).  
**Date:** 2026-07-09 (post-migration)

## Executive summary

| Area               | Status                                                               |
| ------------------ | -------------------------------------------------------------------- |
| Token foundation   | **Complete** — `src/styles/tokens.css` is the single source of truth |
| Component adoption | **Complete** — no hardcoded hex/rgb in renderer TSX                  |
| Tailwind bridge    | **Complete** — `@theme inline` + `@utility` in `styles.css`          |
| BEM legacy CSS     | **Removed** — structural rules only (~300 lines)                     |
| Industry rating    | **9.5 / 10** (desktop Electron app tier)                             |

## Architecture

```
tokens.css → styles.css (@theme + @utility) → Tailwind utilities → components
```

Theme: `index.html` boot script sets `data-theme` before paint; Zustand toggle updates `<html data-theme>`.

## What was audited

- 37 renderer component files (+ `ui/*` shadcn primitives)
- `tokens.css`, `styles.css`, `terminal-themes.ts`, `mock-data.ts`
- Inline `style` props (dynamic tones, kanban gradients, sidebar width — all intentional)

## Findings

### Colors

- All semantic colors flow through `--color-*` tokens
- Dynamic status tones use `color-mix(in srgb, var(--color-*) …)` or runtime tone strings
- Preview palette (`--color-preview-*`) isolated to `BrowserPanel` mock
- xterm palette (`--color-term-*`) read at runtime by `terminal-themes.ts`

### Typography

- Token-named utilities: `text-caption`, `text-control`, `text-heading`, etc.
- Letter-spacing: `tracking-tight*` / `tracking-wide*` (no arbitrary `tracking-[…]` in components)
- Line-height: `leading-snug`, `leading-body`, `leading-row`, `leading-relaxed`, etc.

### Spacing & layout

- Fractional spacing ladder wired in `@theme` (`p-4.5`, `gap-2.25`, etc.)
- Control heights: `h-control-xs` … `h-control-xl`, `h-control-form` (32px forms)
- Dialog widths: `w-dialog-md/lg/xl/orchestrator`

### Icons

- Unified `size-icon-2xs` (12) through `size-icon-xl` (18)
- No `h-3.5 w-3.5` / `h-4 w-4` in app chrome

- Z-index: `z-chrome`, `z-titlebar`, `z-overlay` (no raw `z-10`/`z-50` in renderer)

### Remaining intentional exceptions

| Item                                           | Reason                 |
| ---------------------------------------------- | ---------------------- |
| `w-[var(--radix-dropdown-menu-trigger-width)]` | Radix runtime width    |
| `min-w-[8rem]` / `min-w-[10rem]` in shadcn ui  | Radix defaults         |
| Inline `style` on `StatusPill`, kanban columns | Runtime color tones    |
| API `accentColor` hex on project dots          | Backend may return hex |

No optional polish debt remains in app chrome.

### Out of scope

- `src/landing/` — separate marketing palette

## Files

| Path                             | Role                                      |
| -------------------------------- | ----------------------------------------- |
| `src/styles/tokens.css`          | CSS custom properties                     |
| `src/renderer/styles.css`        | `@theme`, `@utility`, global resize state |
| `DESIGN_TOKENS.md`               | Token reference                           |
| `src/renderer/MIGRATION_GAPS.md` | Migration log                             |
