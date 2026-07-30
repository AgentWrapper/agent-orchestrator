# UI system audit — renderer

Measured 2026-07-30 against `feat/ui-revamp`. Scope: `frontend/src/renderer` and
`frontend/src/styles`. The question behind it: why does the UI read as
inconsistent, and what would it take to get the level of control a tightly
constrained design system gives you.

The short answer is that the app has **no enforced vocabulary**. It has a large
one. 438 custom properties, 15 font sizes, 19 radius tokens, and 215
hand-written CSS class blocks are all legitimate to use, so every component
makes its own choices and no two agree. Consistency is not a taste problem here;
it is a constraint problem.

## Method

Counts come from `rg` over the tracked source. Where an earlier informal count
was wrong, the corrected number is used and the correction is called out.

## Summary

| Finding                                                                         | Severity | Evidence                                                      |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| Type scale has 15 sizes, 7 of them inside a 3px span, including half-pixels     | High     | `--font-size-xs: 10px` … `--font-size-base: 13px`             |
| 19 radius tokens; 11 named after components; five values off any scale          | High     | `--radius-center-panel: 17px`, `--radius-topbar-control: 7px` |
| 169 of 438 tokens are named after a place, not a role                           | High     | `--size-settings-mobile-regen-width: 179px`                   |
| Two parallel styling systems: 215 bespoke class blocks beside shadcn/Tailwind   | High     | 2,568-line `styles.css`, 25 class families                    |
| Primitives are bypassed: 10 files import `ui/button`, most hand-roll `<button>` | Medium   | `Sidebar.tsx` has 12 raw `<button>`                           |
| Motion vocabulary is 2 duration tokens plus ad-hoc `transition-[…]` lists       | Medium   | 45 distinct transition property lists                         |
| No element recipe: alignment, icon size, gap, radius re-decided per control     | High     | 6 icon sizes spanning 9px; 8 control heights                  |
| `DESIGN.md` documents rules the code no longer follows                          | Medium   | uppercase eyebrows, mono UI labels, Inter                     |

## Two corrections to earlier informal numbers

I quoted these before writing the tooling; both overstated the problem and are
worth fixing so scope decisions rest on real numbers.

- **"502 arbitrary Tailwind values, 185 distinct."** Most are `data-[state=open]:`
  and `group-data-[…]` variant selectors, which are normal Radix usage, not magic
  numbers. Excluding variants and `var()` references leaves **131 uses**, and
  roughly a third of those are `transition-[background,color]`-style property
  lists, which are also legitimate. The real magic-number problem is **~40
  off-scale font sizes** (`text-[12px]`, `text-[9px]`, `text-[13px]`, `text-[7px]`,
  `text-[14px]`, `text-[15px]`, `text-[16px]`).
- **"32 raw hex colors in `.tsx`."** Nearly all are PR and issue references in
  strings and tests (`#2270`, `#324`). Raw hex in the renderer is **not** a
  problem; the color layer is the healthiest part of the system.

## Finding 1 — the type scale is not a scale

Fifteen font-size tokens exist:

```
10px  10.5px  11px  11.5px  12px  12.5px  13px  14px  15px  16px  16px  17px  21px  22px  28px
```

Seven of them live inside a 3px span, two are half-pixels, and `--font-size-2xs`
(10.5px) is _larger_ than `--font-size-xs` (10px), so the names no longer order
by size. On top of that, components bypass the tokens ~40 times with
`text-[12px]`-style literals, which means some 12px text is `text-sm` and some is
arbitrary — invisible in review, identical on screen, impossible to restyle
globally.

The utility usage is actually disciplined where it goes through the scale:
`text-xs` (97), `text-sm` (52), `text-2xs` (21), `text-micro` (12), `text-base`
(2). Five sizes carry 98% of the UI. The other ten tokens are the drift.

**Target:** five sizes, no half-pixels, names ordered by size.

| Token        | Size | Use                             |
| ------------ | ---- | ------------------------------- |
| `text-micro` | 10px | counts, keycaps, dense metadata |
| `text-2xs`   | 11px | secondary labels                |
| `text-xs`    | 12px | default UI text                 |
| `text-sm`    | 14px | emphasis, card titles           |
| `text-base`  | 16px | dialog titles, the rare heading |

Everything above 16px belongs to one or two specific surfaces and should be a
local class, not a global token.

## Finding 2 — radius encodes exceptions

Nineteen radius tokens, of which eleven are named after a component:

```
--radius-topbar-context: 8px      --radius-settings-panel: 14px
--radius-topbar-control: 7px      --radius-settings-row: 16px
--radius-command-palette: 12px    --radius-settings-action: 16px
--radius-command-item: 6px        --radius-settings-dialog-lg: 20px
--radius-center-panel: 17px       --radius-agents-sheet: 17px
--radius-welcome-panel: 17px
```

The base scale is `--radius: 10px` with derived steps at 4 / 6 / 8 / 10 / 14. So
7px, 12px, 16px, 17px, and 20px are unreachable from it — each exists because one
component wanted a number. 17px in particular is the kind of value nobody can
defend, and three surfaces share it.

Neighbouring elements with 16px and 17px corners are the exact thing that reads
as "sloppy" without anyone being able to name why.

**Target:** one base plus derived steps, and a single documented sub-scale
exception for the 2px status swatch.

| Token            | Value | Use                       |
| ---------------- | ----- | ------------------------- |
| `rounded-swatch` | 2px   | status squares only       |
| `rounded-xs`     | 4px   | scrollbars, tiny chips    |
| `rounded-sm`     | 6px   | inputs, small controls    |
| `rounded-md`     | 8px   | buttons, rows, menu items |
| `rounded-lg`     | 10px  | cards, panels             |
| `rounded-xl`     | 14px  | modals, sheets            |
| `rounded-full`   | pill  | badges, avatars, dots     |

Migration is mechanical: 7→6, 12→14, 16→14, 17→14, 20→14.

## Finding 3 — tokens are named after places, not roles

169 of 438 custom properties contain a surface name (`topbar`, `settings`,
`command`, `welcome`, `center-panel`, `agents-sheet`, …). The `settings` family
alone has 36 size tokens. Some of them:

```
--size-settings-mobile-regen-width: 179px
--size-settings-mobile-details-pad-x: 19px
--size-settings-mobile-switch-travel: 18px
--size-settings-mobile-label: 55px
--size-settings-row: 52px
```

These are magic numbers wearing a token's clothes, which is worse than an inline
magic number: the naming makes them look sanctioned, and they survive review.
179px is not a design decision, it is a measurement someone took once.

The distinction that matters: a token should name a **role** the value plays
(`--color-border-strong`, `--size-control-md`) so many components can share it.
The moment it names a **place** (`--radius-settings-row`), it can only ever have
one caller, and every new surface legitimately needs its own — which is exactly
how you get to 438.

The color tokens are the counter-example and should be the model. `--color-bg-*`,
`--color-text-*`, `--color-border-*`, `--color-status-*` are role-named, layered
over the shadcn preset, and shared widely. That layer is working.

**Target:** every token names a role. Place-named tokens are rewritten to point
at scale steps and then deleted. Realistic end state is roughly 150–200 tokens,
dominated by the color roles and the terminal palette (36 `--color-term-*` tokens
are legitimate — xterm needs them).

### One name, two meanings: `accent-foreground`

`styles.css` maps `--color-accent-foreground` to shadcn's `--accent-foreground`,
the text color for `bg-accent`. `tokens.css` then redefines the same custom
property as `--primary-foreground`, the text color for `bg-accent-strong`. The
two pairings invert each other, so whichever one a component picks, the other
becomes an illegible same-on-same pill — that is what made the board's warning
banner Restart button unreadable. Foreground tokens must be defined once, next
to the single background they pair with; anything else is a coin flip. Until the
color layer is consolidated, use `bg-primary`/`text-primary-foreground` for
solid controls.

## Finding 4 — two styling systems in one renderer

`renderer/styles.css` is 2,568 lines holding 215 class blocks across 25 families:

| Family               | Blocks | Family                     | Blocks |
| -------------------- | ------ | -------------------------- | ------ |
| `reverb-topbar`      | 43     | `window-titlebar`          | 9      |
| `session-inspector`  | 18     | `board-scrollbar`          | 9      |
| `reviewer-row`       | 18     | `reviewer-terminal`        | 7      |
| `reviewer-card`      | 18     | `session-files`            | 6      |
| `inspector-timeline` | 14     | `reviewer-status`          | 6      |
| `center-panel`       | 12     | `ao-startup`               | 6      |
| `browser-panel`      | 12     | `inspector-*` (4 families) | 15     |

These components cannot inherit anything from `components/ui/*` — not variants,
not hover and focus conventions, not motion tokens. Each family re-decides what a
hover state, a focus ring, and a disabled control look like. This is the single
largest source of the "all here and there" feeling, and it is why a visual fix
usually has to touch both a `.tsx` file and a CSS block.

**What must stay raw CSS** (roughly 400 lines, and that is fine):

- xterm theming and the terminal palette
- scrollbar pseudo-elements (`::-webkit-scrollbar`, `scrollbar-gutter`)
- `@keyframes` and the `--animate-*` definitions
- the drag-region and traffic-light clearance rules
- `@theme` scale declarations

**What should become components:** the other ~1,900 lines, in five surface-sized
chunks — topbar (43), inspector (37 across four families), reviewer (49),
center/browser panel (24), titlebar and startup (15).

## Finding 5 — primitives are bypassed

`components/ui/` has 21 primitives. Only 10 files import `ui/button`, while raw
`<button>` elements appear across the renderer: `Sidebar.tsx` (12),
`KeyboardShortcutsSettingsDialog.tsx` (9), `CenterPane.tsx` (9),
`NotificationCenter.tsx` (5), `CreateProjectFlow.tsx` (5), `SessionsBoard.tsx` (4).
There is also a parallel `TopbarButton` component with its own variants.

Every hand-rolled button re-specifies height, padding, radius, hover, focus ring,
and disabled state. That is six chances to diverge per button.

**Target:** one `Button` with variants covering the real cases (including the
topbar's icon and compact forms), and a lint rule that flags raw `<button>` in
`renderer/components/**` outside `ui/`.

## Finding 6 — motion has no vocabulary

Two duration tokens exist (`--duration-fast: 120ms`, `--duration-normal: 150ms`)
against `DESIGN.md`'s documented three-tier scale (80 / 160 / 240ms) — the doc and
the code disagree. Meanwhile 45 distinct `transition-[…]` property lists are
spelled out inline, several of them one-offs like
`transition-[filter,background,color,border-color]`.

**Target:** three durations (`fast` 100ms, `normal` 150ms, `slow` 240ms), two
easings (enter `ease-out`, exit `ease-in`), and a small set of named transition
utilities so components stop enumerating properties.

## Finding 7 — element-level composition has no conventions

Scales are only half the problem. Even when two controls both use on-scale
values, they disagree about how a control is _assembled_ — alignment, icon size,
gap, padding, and which radius belongs on which height. Two examples the user
pointed at, both in the same 240px rail:

- **The sidebar's Settings footer button used `justify-center`.** Every other row
  in that rail is left-aligned, so its icon and label floated to the middle. A
  centered label only makes sense on an icon-only control.
- **The Search button used `rounded-settings-row` (16px) on a 32px control.** A
  16px radius on a 32px box is halfway to a pill, which is why it read as odd
  next to the 8px rows above it. It also pulled a settings-family token into the
  sidebar — Finding 3 in miniature.

Both are now fixed, along with two more `rounded-settings-row` leaks in the same
file (the collapsed-rail settings tile and the restart-to-update row).

The systemic version of this, measured:

**Icon sizes: six tokens, five of them within 5px, and the names don't order.**

```
--size-icon-xs: 9px   --size-icon-md: 14px    --size-icon-lg: 15px
--size-icon-sm: 13px  --size-icon-base: 16px  --size-icon-xl: 18px
```

`--size-icon-lg` (15px) is smaller than `--size-icon-base` (16px), the same
name-ordering bug the type scale has. 13px, 14px, 15px, and 16px icons are not
distinguishable on purpose — they are four people making the same decision
separately.

**Control heights: eight tokens, six of them within 10px.**

```
20  24  28  30  32  34  36  38
```

`DESIGN.md` documents three (24 / 28 / 32). The other five arrived one component
at a time.

**Gaps: thirteen values, including two off the 4px grid** — `gap-2.25` (9px, 3
uses) and `gap-1.75` (7px, 1 use).

The fix is not another token; it is a **recipe** that binds these together, so
"what radius goes on a 28px button" has one answer instead of being re-decided.
That recipe now lives in `DESIGN.md` under _The contract_:

| Control height | Radius           | Padding x | Gap       | Icon | Text       |
| -------------- | ---------------- | --------- | --------- | ---- | ---------- |
| 24px `h-6`     | `rounded-sm` 6px | `px-2`    | `gap-1.5` | 13px | `text-2xs` |
| 28px `h-7`     | `rounded-md` 8px | `px-2.5`  | `gap-2`   | 14px | `text-xs`  |
| 32px `h-8`     | `rounded-md` 8px | `px-3`    | `gap-2`   | 16px | `text-xs`  |
| 36px+ rows     | `rounded-md` 8px | `px-3`    | `gap-2`   | 16px | `text-sm`  |

Plus two alignment rules that would have caught both reported bugs:
**text-bearing controls are left-aligned** (`justify-center` is for icon-only
controls), and **an icon and its label are optically centered on the text
baseline**, not on the box.

Auditing every element against this recipe is a pass through roughly 46
components. It is the part of the work that most directly answers "the alignment
of stuff within the elements", and it is cheap once the recipe exists — the
questions become checkable instead of matters of taste.

## Finding 8 — the design doc has drifted

`DESIGN.md` currently instructs:

- **"Eyebrow labels: mono, uppercase, letter-spacing .12–.14em"** — uppercase is
  now banned by explicit user rule, and mono was removed from all UI chrome on
  2026-07-30.
- **"UI / body: Geist Variable"** in Typography, but Implementation notes still
  say the renderer "currently uses Inter" and tells you to migrate to a system
  stack. Both are stale; Geist is bundled and in use.
- **"Session status is a single ~14px glyph, never a text pill/badge"** — the
  board and topbar both use swatch + text labels.
- **Spacing** says the base unit is 4px, which is true and worth keeping.

A design doc that contradicts the code trains everyone to ignore it. This is why
the contract needs to be numbers that can be checked, not prose.

## What is already healthy

Worth stating plainly, because the fix should not disturb these:

- **Color roles.** Semantic, layered over the shadcn preset, dual-theme, and
  genuinely shared. The board status hues added on 2026-07-30 slot into the same
  structure.
- **Type usage.** Five utilities carry 98% of the UI even though fifteen exist.
  The scale is nearly there; it just needs the other ten deleted.
- **Spacing base.** 4px, consistently, via the Tailwind scale.
- **No raw hex.** The renderer goes through tokens for color.
- **Primitives exist.** 21 shadcn components are already in the tree — this is a
  consolidation job, not a build-from-scratch job.

## Proposed sequence

Effort is rough, in focused working days.

| #   | Step                                                       | Effort | Risk   | Payoff                              |
| --- | ---------------------------------------------------------- | ------ | ------ | ----------------------------------- |
| 1   | Collapse type + radius scales, delete place-named tokens   | 1–2d   | Low    | Immediate, visible                  |
| 2   | Add enforcement (lint + token test)                        | 0.5d   | None   | Makes step 1 permanent              |
| 3   | Consolidate `Button`/`TopbarButton` and the row primitives | 1d     | Low    | Kills the biggest divergence source |
| 4   | Motion vocabulary                                          | 0.5d   | Low    | Small but pervasive                 |
| 5   | Migrate bespoke CSS → components, one surface per PR       | 2–4w   | Medium | The real coherence win              |
| 6   | Rewrite `DESIGN.md` around the contract                    | 0.5d   | None   | Stops the doc drifting again        |

Steps 1–4 are about three days and change how the app feels. Step 5 is the grind
and should be sequenced by traffic: board → topbar → sidebar → settings →
inspector → reviewer. Each surface is independently shippable; nothing forces a
big-bang rewrite.

## Enforcement (step 2, in detail)

Without this the cleanup regresses within weeks.

1. **ESLint** — ban `text-[…]`, `rounded-[…]`, `p-[…]`, `gap-[…]`, `w-[…]`,
   `h-[…]` literals in `renderer/**/*.tsx`. Allow `data-*` variants, `var()`
   references, and `transition-[…]` property lists.
2. **Token test** — a vitest that parses `tokens.css` and fails when a token name
   matches a known surface word, or when a radius or font-size token is added
   outside the approved set.
3. **Raw `<button>` rule** — flag `<button>` outside `components/ui/`.
4. **CI** — these run in the existing frontend job; no new infrastructure.

The rule that makes all of it coherent: **if you need a value that is not on the
scale, change the scale — do not add an exception.**
