# Migration Gaps — `src/renderer`

**Status: complete** (2026-07-09). Renderer design system fully migrated.

## Closure pass (2026-07-09)

- **Z-index tokens** — `z-chrome` (10), `z-titlebar` (20), `z-overlay` (50); replaced all `z-10`/`z-20`/`z-50` in renderer
- **`bg-surface-faint`** — inspector review list inset
- **`h-table-head`** — PR table header height (`--size-table-head` → `--space-10`)
- **Removed `--space-11`** — only consumer was inspector empty state; now `py-10 px-5`

## Polish pass (2026-07-09, final)

- **`leading-row`** — replaces `leading-5` in forms, notifications, browser mock
- **PR table columns** — `w-pr-col-number`, `w-pr-col-state`
- **Timeline shadows** — `shadow-timeline-dot`, `shadow-timeline-dot-now`
- **Sidebar / shadcn** — `size-control-board`, `size-icon-base`, `h-control-md`, `size-control-form`
- **Token cleanup** — removed duplicate `--line-height-body`; `--size-hairline` wired in `ResizeHandle`
- **Docs** — removed phantom `--font-size-lg` from `DESIGN_TOKENS.md`

## Polish pass (2026-07-09)

- **Icon unification** — `size-icon-2xs` … `size-icon-xl`; replaced all `h-3.5`/`h-4` in app chrome
- **Typography tokens** — `tracking-tight*` / `tracking-wide*`, `leading-snug` … `leading-loose`
- **Motion tokens** — `duration-fast` (120ms), `duration-normal` (150ms)
- **Layout utilities** — `grid-cols-notification`, `max-w-inspector-status-chip`, `w-font-size-label`, `bg-purple-subtle`
- **Form controls** — `h-control-form` (32px) aligned across `ui/button`, `ui/input`, forms, select
- **`ResizeHandle` component** — replaced `.resize-handle` BEM; global CSS only for `body.is-resizing-x`
- **Test hooks** — `data-testid="inspector-section"` / `inspector-timeline-event` (removed BEM class names)
- **Token cleanup** — removed duplicate `--spacing-icon-*`; wired `--font-weight-*` in `@theme`

## BEM → Tailwind pass (2026-07-09)

- **`TopbarButton`** — replaces all `.dashboard-app-header__*` usage
- **`BrowserPanel`**, **`CenterPane`**, **`TitlebarNav`**, **`SessionInspector`** — full Tailwind
- **`styles.css` reduced** to ~300 lines (xterm, keyframes, session-split, resize global state)

## Intentionally out of scope

| Item                  | Reason                                            |
| --------------------- | ------------------------------------------------- |
| `src/landing/`        | Per project scope                                 |
| Radix runtime widths  | `w-[var(--radix-…)]`, `min-w-[8rem]`              |
| Dynamic inline styles | Kanban gradients, status pills, API accent colors |

## Verified

- `npm run typecheck`, `npx vitest run src/renderer`, `npx vite build` — all pass
