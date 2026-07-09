# Design Tokens

Single source of truth for the Agent Orchestrator renderer (excluding landing).  
Companion files: `DESIGN_AUDIT.md` (audit), `src/styles/tokens.css` (variables), `src/renderer/MIGRATION_GAPS.md` (migration status).

**Wired:** `tokens.css` is imported from `src/renderer/styles.css`. Components use Tailwind semantic utilities + `var(--*)` arbitrary values.

## Principles

1. **Extract, don't invent** — values come from the existing renderer dark UI, not a new brand.
2. **Semantic names** — prefer `--color-bg-primary` over `--color-gray-950`.
3. **Theme by swapping variables** — paint with `var(--color-*)`; never hardcode dark/light hex in components.
4. **Scale integrity** — spacing uses a 4px ladder with fractional steps for dense chrome; typography has fixed steps including half-steps used in the board.

## Theme switching

| Selector                       | When                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `:root`, `:root.dark`, `.dark` | Default **dark** (app primary; landing/docs share the same block) |
| `:root[data-theme="light"]`    | Renderer Zustand theme toggle                                     |
| `index.html` boot script       | Sets `data-theme` before first paint (avoids FOUC)                |

## Color tokens

| Token                                                                        | Intended use                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `--color-bg-primary`                                                         | App / window background                                      |
| `--color-bg-secondary`                                                       | Cards, panels, bordered surfaces, terminal canvas            |
| `--color-bg-tertiary`                                                        | Raised chrome (sidebar hover targets, secondary fills)       |
| `--color-bg-elevated`                                                        | Overlays, popovers stepping above tertiary                   |
| `--color-bg-sidebar`                                                         | Sidebar strip (darker than primary)                          |
| `--color-bg-terminal`                                                        | Terminal pane background                                     |
| `--color-text-primary` / `--color-text-muted` / `--color-text-passive`       | Body / secondary / disabled                                  |
| `--color-border` / `--color-border-strong`                                   | Hairline dividers / emphasis borders                         |
| `--color-accent` + `--color-accent-weak` / `--color-accent-dim`              | Primary actions, focus, tint fills                           |
| `--color-working` / `--color-warning` / `--color-success` / `--color-danger` | Status semantics                                             |
| `--color-preview-*`                                                          | Browser panel static mock (light chrome palette)             |
| `--color-term-*`                                                             | xterm ANSI palette (read by `terminal-themes.ts` at runtime) |
| `--color-project-accent-mint` / `--color-project-accent-sky`                 | Mock project accent swatches                                 |

### Legacy aliases

`tokens.css` keeps a small `--bridge-*` block so `@theme` can reference canonical colors without Tailwind name collisions. `--font-sans` / `--font-mono` alias `--font-family-*` for `styles.css` rules.

## Elevation tokens (`--elevation-*`)

| Token            | Tailwind utility | Use                           |
| ---------------- | ---------------- | ----------------------------- |
| `--elevation-sm` | `shadow-sm`      | Cards, floating sidebar       |
| `--elevation-md` | `shadow-md`      | Popovers, tooltips, dropdowns |
| `--elevation-lg` | `shadow-lg`      | Sheets, simple dialogs        |
| `--elevation-xl` | `shadow-xl`      | Large modals                  |

## Overlay

| Token           | Use                                               |
| --------------- | ------------------------------------------------- |
| `--color-scrim` | Dialog/sheet backdrop (`bg-[var(--color-scrim)]`) |

## Typography in Tailwind

Standard scale (remapped for dense UI):

| Utility           | Token                    | px   |
| ----------------- | ------------------------ | ---- |
| `text-micro`      | `--font-size-xs`         | 10   |
| `text-2xs`        | `--font-size-2xs`        | 10.5 |
| `text-caption`    | `--font-size-caption`    | 11   |
| `text-sm-md`      | `--font-size-sm-md`      | 11.5 |
| `text-xs`         | `--font-size-sm`         | 12   |
| `text-md-sm`      | `--font-size-md-sm`      | 12.5 |
| `text-control`    | `--font-size-base`       | 13   |
| `text-brand`      | `--font-size-brand`      | 14.5 |
| `text-sm`         | `--font-size-md`         | 14   |
| `text-subtitle`   | `--font-size-subtitle`   | 15   |
| `text-heading-sm` | `--font-size-heading-sm` | 17   |
| `text-heading`    | `--font-size-heading`    | 21   |
| `text-heading-lg` | `--font-size-heading-lg` | 22   |

Prefer these utilities over `text-[length:var(--font-size-*)]` in components.

## Overlay & terminal

| Utility / token                       | Use                              |
| ------------------------------------- | -------------------------------- |
| `bg-scrim`                            | Dialog/sheet backdrop            |
| `text-terminal` / `text-terminal-dim` | Mock terminal / xterm foreground |
| `text-success-bright`                 | Reviewer highlight, preview mock |

## Preview palette (browser mock)

| Utility                                                                                      | Token                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `bg-preview`                                                                                 | `--color-preview-bg`                       |
| `text-preview-foreground`                                                                    | `--color-preview-fg`                       |
| `text-preview-muted`                                                                         | `--color-preview-muted`                    |
| `text-preview-link`                                                                          | `--color-preview-link`                     |
| `text-preview-heading`                                                                       | `--color-preview-heading`                  |
| `text-preview-body`                                                                          | `--color-preview-body`                     |
| `border-preview` / `border-preview-card` / `border-preview-tile` / `border-preview-terminal` | Matching `--color-preview-*-border` tokens |
| `bg-preview-success` / `bg-preview-tile` / `bg-preview-terminal`                             | Tile and terminal fills                    |

## Icon sizes

| Utility          | Token              | px  |
| ---------------- | ------------------ | --- |
| `size-icon-2xs`  | `--size-icon-2xs`  | 12  |
| `size-icon-xs`   | `--size-icon-xs`   | 9   |
| `size-icon-sm`   | `--size-icon-sm`   | 13  |
| `size-icon-md`   | `--size-icon-md`   | 14  |
| `size-icon-base` | `--size-icon-base` | 16  |
| `size-icon-lg`   | `--size-icon-lg`   | 15  |
| `size-icon-xl`   | `--size-icon-xl`   | 18  |

Prefer `size-icon-*` over `h-3.5 w-3.5` / `h-4 w-4` in components.

## Letter-spacing (`tracking-*`)

| Utility             | Token                 | Value    |
| ------------------- | --------------------- | -------- |
| `tracking-tight-xl` | `--tracking-tight-xl` | -0.025em |
| `tracking-tight-lg` | `--tracking-tight-lg` | -0.015em |
| `tracking-tight`    | `--tracking-tight`    | -0.01em  |
| `tracking-wide-xs`  | `--tracking-wide-xs`  | 0.04em   |
| `tracking-wide-sm`  | `--tracking-wide-sm`  | 0.05em   |
| `tracking-wide`     | `--tracking-wide`     | 0.06em   |
| `tracking-wide-md`  | `--tracking-wide-md`  | 0.08em   |
| `tracking-wide-lg`  | `--tracking-wide-lg`  | 0.09em   |
| `tracking-wide-xl`  | `--tracking-wide-xl`  | 0.12em   |

## Line-height (`leading-*`)

| Utility           | Token                   | Value          |
| ----------------- | ----------------------- | -------------- |
| `leading-snug`    | `--line-height-snug`    | 1.42           |
| `leading-body`    | `--line-height-normal`  | 1.5            |
| `leading-row`     | `--line-height-row`     | 1.25rem (20px) |
| `leading-body-md` | `--line-height-body-md` | 1.55           |
| `leading-relaxed` | `--line-height-relaxed` | 1.6            |
| `leading-loose`   | `--line-height-loose`   | 1.7            |

## Motion (`duration-*`)

| Utility           | Token               | Value |
| ----------------- | ------------------- | ----- |
| `duration-fast`   | `--duration-fast`   | 120ms |
| `duration-normal` | `--duration-normal` | 150ms |

## Form control heights

| Utility           | Token                  | px  | Use                        |
| ----------------- | ---------------------- | --- | -------------------------- |
| `h-control-form`  | `--size-control-form`  | 32  | Buttons, inputs, select sm |
| `h-control-board` | `--size-control-board` | 36  | Select default             |

## Layout `@utility` helpers

| Utility                                           | Token / rule                                                 |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `w-dialog-md/lg/xl/orchestrator`                  | `--size-dialog-*`                                            |
| `w-notification-width`                            | `--size-notification-width`                                  |
| `grid-cols-notification`                          | `--size-notification-icon` (26px) column                     |
| `max-w-inspector-status-chip`                     | `--size-inspector-status-chip-max` (58%)                     |
| `w-font-size-label`                               | `--size-font-size-label` (44px)                              |
| `w-pr-col-number` / `w-pr-col-state`              | `--size-pr-col-number` (64px) / `--size-pr-col-state` (96px) |
| `shadow-timeline-dot` / `shadow-timeline-dot-now` | Inspector activity timeline nodes                            |
| `bg-surface-faint`                                | Inspector review list inset (`color-mix` on primary)         |
| `h-table-head`                                    | `--size-table-head` (40px) — PR table header row             |
| `bg-purple-subtle` / `text-purple-accent`         | Nightly badge tint                                           |

## Z-index (`z-*`)

| Utility      | Token          | Value | Use                                  |
| ------------ | -------------- | ----- | ------------------------------------ |
| `z-chrome`   | `--z-chrome`   | 10    | Topbar, sidebar, resize handles      |
| `z-titlebar` | `--z-titlebar` | 20    | macOS titlebar nav cluster           |
| `z-overlay`  | `--z-overlay`  | 50    | Dialogs, dropdowns, tooltips, sheets |

## Shared components

| Component      | Role                                              |
| -------------- | ------------------------------------------------- |
| `TopbarButton` | Shell topbar button variants                      |
| `StatusPill`   | Tinted status pill (topbar + inspector)           |
| `ResizeHandle` | Sidebar drag handle (`data-slot="resize-handle"`) |

## Toolbar layout

`top-toolbar` and `--spacing-toolbar` (`56px`) align fixed sidebar offset below the shell topbar.

## Radius in Tailwind

`@theme` maps `--radius-sm` … `--radius-panel` to `rounded-sm` … `rounded-panel`.

## Breakpoints

| Token                            | Value | Use                                                                |
| -------------------------------- | ----- | ------------------------------------------------------------------ |
| `--breakpoint-layout-narrow`     | 680px | Reviewer grid (`@custom-media --layout-narrow`)                    |
| `--breakpoint-inspector-compact` | 300px | Inspector `@container` (literal px; containers cannot use `var()`) |

## Spacing in Tailwind

`@theme` maps the full fractional ladder (`--spacing-0_5` … `--spacing-10`) to `--space-*`. Prefer Tailwind utilities (`p-5`, `gap-4.5`, `h-5.5`) over `*- [var(--space-*)]` arbitrary values — components are migrated to the utility form.

## Typography tokens

| Token                    | px   | Use                           |
| ------------------------ | ---- | ----------------------------- |
| `--font-size-2xs`        | 10.5 | Uppercase meta, board footers |
| `--font-size-xs`         | 10   | Micro labels                  |
| `--font-size-caption`    | 11   | Badges, kanban labels         |
| `--font-size-sm-md`      | 11.5 | Inspector tabs, status pills  |
| `--font-size-sm`         | 12   | Secondary chrome              |
| `--font-size-md-sm`      | 12.5 | KV rows, PR summaries         |
| `--font-size-base`       | 13   | Dense controls                |
| `--font-size-brand`      | 14.5 | Titlebar project name         |
| `--font-size-md`         | 14   | Body default                  |
| `--font-size-subtitle`   | 15   | Dialog titles, stat values    |
| `--font-size-heading-sm` | 17   | Empty-state headings          |
| `--font-size-heading`    | 21   | Dashboard subhead             |
| `--font-size-heading-lg` | 22   | Preview mock headings         |

## Spacing tokens

4px base with fractional steps for dense chrome:

| Token                                  | Value                                                          |
| -------------------------------------- | -------------------------------------------------------------- |
| `--space-0_5` … `--space-5_5`          | 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22 |
| `--space-6`, `--space-8`, `--space-10` | 24, 32, 40                                                     |

## Layout size tokens (`--size-*`)

Fixed chrome dimensions. Key dialog widths:

| Token                        | Value | Use                             |
| ---------------------------- | ----- | ------------------------------- |
| `--size-dialog-md`           | 420px | Agent sheet, small modals       |
| `--size-dialog-lg`           | 440px | Migration popup                 |
| `--size-dialog-orchestrator` | 460px | Orchestrator replacement dialog |
| `--size-dialog-xl`           | 560px | New task dialog                 |

Key sidebar widths:

| Token                    | Value |
| ------------------------ | ----- |
| `--size-sidebar-default` | 240px |
| `--size-sidebar-mobile`  | 288px |
| `--size-sidebar-icon`    | 48px  |

See `tokens.css` for toolbar, inspector, and control sizes.

## Radius tokens

| Token            | Value | Use                    |
| ---------------- | ----- | ---------------------- |
| `--radius-sm`    | 4px   | Small chips            |
| `--radius-md`    | 6px   | Default controls       |
| `--radius-lg`    | 8px   | Larger buttons / cards |
| `--radius-panel` | 13px  | Board column panels    |
| `--radius-full`  | 999px | Pills, avatars, dots   |

## Shadow tokens

| Token            | Use                         |
| ---------------- | --------------------------- |
| `--elevation-sm` | Hairline lift (`shadow-sm`) |
| `--elevation-md` | Popovers (`shadow-md`)      |
| `--elevation-lg` | Dialogs (`shadow-lg`)       |
| `--elevation-xl` | Large modals (`shadow-xl`)  |

## Architecture

```
tokens.css (:root --color-*, --font-*, --space-*, --size-*, --elevation-*)
    ↓ --bridge-* (12 vars for @theme name-collision avoidance)
    ↓ @theme inline (Tailwind/shadcn bridge in styles.css)
    ↓ Tailwind utilities (text-foreground, bg-surface, p-5, shadow-lg)
    ↓ components + styles.css rules
```

`terminal-themes.ts` reads `--color-term-*` via `getComputedStyle` when xterm mounts (not at module init).

## Out of scope

- Landing marketing palette (`src/landing/`)
- shadcn default rem widths in `ui/*` primitives

## Files

| Path                                      | Role                             |
| ----------------------------------------- | -------------------------------- |
| `frontend/src/styles/tokens.css`          | CSS custom properties            |
| `frontend/src/renderer/styles.css`        | App stylesheet + `@theme` bridge |
| `frontend/DESIGN_AUDIT.md`                | Original audit                   |
| `frontend/src/renderer/MIGRATION_GAPS.md` | Migration completion notes       |
