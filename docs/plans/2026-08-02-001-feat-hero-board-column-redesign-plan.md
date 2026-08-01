---
title: "feat: Hero board column redesign — strict L→R flow with inline attention UI"
date: 2026-08-02
status: active
type: feat
---

# feat: Hero board column redesign — strict L→R flow with inline attention UI

## Summary

Redesign the hero landing page board demo from a 4-column layout that included a dedicated "Needs you" column into a semantically cleaner pipeline: **Working → Staging → In Review → Ready to merge**. Cards that require user attention stay in their current column but float to the top with an amber pulsing glow border instead of being shuffled to a separate column. Card flow is strictly left-to-right by default; right-to-left moves are allowed but are rare and context-driven (represented in the demo via the existing "spawn new task in Working" mechanic). The `FleetBoardDemo` in the FeaturesSection is updated to match the new schema.

---

## Problem Frame

The current board demo has a confusing flow:
- A "Needs you" column (col 2) is almost always empty — it is not useful screen real estate.
- Cards bounce: Working → Needs you → Working → In Review creates a zigzag that looks broken.
- The existing "In Review" column blurs two distinct phases: agent self-testing before raising a PR, and the human/CI review lifecycle after the PR is open.
- Visitors seeing the demo don't get a clear mental model of the agent pipeline.

The new schema makes the pipeline legible: each column maps to one unambiguous phase, and "needs user input" is a card-level signal, not a board position.

---

## Requirements

- R1: Remove the dedicated "Needs you" column from both board demos.
- R2: Column 1 ("Working") covers idle, initializing, running agents, and tasks where no PR exists yet.
- R3: Column 2 ("Staging") covers agent self-testing and internal review before a PR is raised.
- R4: Column 3 ("In Review") covers PR-open state: CI checks, reviewer assignment, human code review.
- R5: Column 4 ("Ready to merge") stays unchanged: approved PRs and merged outcomes.
- R6: Default card movement is strictly left-to-right: Working → Staging → In Review → Ready to merge.
- R7: Right-to-left movement is allowed (not blocked) but only happens in the demo via the existing "new task spawns to Working" mechanic — not as part of normal advancement.
- R8: Cards needing user attention are pinned to the top of their current column with an amber pulsing glow border. No column change required.
- R9: The `FleetBoardDemo` in FeaturesSection mirrors the new column IDs and labels.
- R10: Card advancement selection is weighted toward earlier columns so the pipeline visibly drains left-to-right (fixes root cause of the "random flow" complaint; the plan's column redesign alone does not change this).
- R11: The topmost card in each column receives a distinct "head-of-line / current" visual treatment to differentiate active work from queued work.
- R12: At most one attention card pulses per column at a time; additional waiting cards render with static amber border, and the column header surfaces a `⚠ N waiting` aggregate chip.
- R13: The column color scale is a progression a viewer can read as "further right = further along" — the plan's proposed violet Staging color is replaced.
- R14: Per-card visual state (badge color, icon, state label, PR class) and per-column metadata (label, color) are each derived from one place, not scattered ternaries.

---

## Key Technical Decisions

**KTD-1: Remove `action` column ID, introduce `staging` and `in_review`.**
The `BoardColumnId` union changes from `"working" | "action" | "pending" | "merge"` to `"working" | "staging" | "in_review" | "merge"`. All static data, `advanceCard`, column color map, and aria labels are updated in tandem. The `OrchestratorView`'s `waitingCards` filter switches from `column === "action"` to `activityState === "waiting"` so it works column-agnostically.

**KTD-2: Attention cards are sorted to the top within `BoardColumn`.**
Before rendering, cards are split into `attentionCards` (where `activityState === "waiting"`) and `normalCards`. `attentionCards` is rendered first. Framer Motion's `layout` prop on each `BoardCard` animates the reorder smoothly. This avoids any additional state or special column routing.

**KTD-3: Amber glow uses a CSS `box-shadow` keyframe animation.**
The existing `tone: "blocked"` card class already renders amber text. A new Tailwind arbitrary `animate-[attention-pulse_2s_ease-in-out_infinite]` class (or `className` conditional) adds a pulsing amber `box-shadow` to the card's border. The keyframe is defined in `tailwind.config` (or as a `@keyframes` in globals). The existing amber text and icon treatment is preserved alongside the border glow.

**KTD-4: `advanceCard` mapping changes.**
- `working` → `staging`: activity becomes "Running checks", activityState `"running"`, tone `"default"`.
- `staging` → `in_review`: activity becomes "Reviewer assigned", activityState `"reviewing"`, tone `"review"`.
- `in_review` → `merge`: activity becomes "Approved", activityState `"passed"`, tone `"ready"`.

Attention state (blocked/waiting) is set on cards placed in any column in the static initial data; the advancement loop still randomly picks and advances cards. When an "attention" card is advanced, it loses the attention state as it moves to the next column (it was "unblocked").

**KTD-6: Weighted card selection in `runStep`.**
Replace the current `randomItem(current.filter(...))` in `runStep` with a weighted picker keyed by column: `working` gets weight 4, `staging` 3, `in_review` 2, `merge` 1. Implementation: build a weighted array (repeat each card N times per its column weight) and pick uniformly, OR compute cumulative weights and binary-search. Keep `merge` in the pool so merges still fire — just less often than left-column advances. The result: over time, ~40% of picks come from Working, ~10% from Ready to merge, so cards visibly drain left→right.

**KTD-7: Head-of-line treatment via first-child selector, no new state.**
Within `BoardColumn`'s rendered card list (after attention-sort from KTD-2), the first `BoardCard` receives a subtle "current" affordance: a 2px left-edge accent bar in the column color, plus a slightly brighter border. Non-first cards render dimmed at ~0.85 opacity. Implementation: pass `isHead={index === 0}` to `BoardCard`, apply conditional classes. No global state, no ranking logic — position in array (already correctly sorted by attention + insertion order) is the source of truth.

**KTD-8: Attention pulse cap + waiting chip.**
`BoardColumn` counts waiting cards. Only `attentionCards[0]` receives the `animate-attention-pulse` class; the rest keep `border-[#fb923c]/50` (static amber outline) but no keyframe. When `attentionCards.length > 1`, the column header renders a `⚠ N waiting` chip beside the count. This preserves the pulse's scarcity value regardless of demo state.

**KTD-9: Column color scale (chosen palette).**
Replace `COLUMN_COLORS` with a cool-to-warm progression that reads as "further right = further along":
- `working`: `#60a5fa` (blue — same)
- `staging`: `#38bdf8` (sky — brighter cool, reads as "moving forward" not "sideways to violet")
- `in_review`: `#facc15` (yellow — same, retains CI-review conventions)
- `merge`: `#4ade80` (green — same)
Explicitly overrides the plan's earlier proposal of `#a78bfa` violet for Staging, which reads as a sideways step from blue.

**KTD-10: Consolidate `COLUMN_CONFIG` and `getCardVisualState`.**
- Merge the top-level `columns` array with `COLUMN_COLORS` into a single `COLUMN_CONFIG: Record<BoardColumnId, { title: string; color: string; weight: number }>` (weight lives here too — see KTD-6). The static seed cards data stays where it is.
- Extract `BoardCard`'s scattered `card.tone === "ready" ? ... : card.tone === "blocked" ? ...` cascades into one pure function `getCardVisualState(card): { badgeColor, iconComponent, stateLabel, prClass, prStatus }`. `BoardCard` calls it once and consumes the object. Adding a future state becomes a one-object edit.

**KTD-5: Static card data remapped.**
Cards previously placed in the `action` column are moved into `working` (if pre-staging) or `staging` (if they represent a "need input mid-test" moment) with `tone: "blocked"` and `activityState: "waiting"`. `trackCardTemplates` index mapping is updated: index 0 → `working`, index 1 → `staging`, index 2 → `in_review`, index 3 → `merge`.

---

## Scope Boundaries

### In scope
- `AppMockup.tsx` — full column schema, animation logic, card data, and attention UI.
- `FleetBoardDemo.tsx` — column labels and card state labels only.
- The amber glow keyframe — added to Tailwind config or a CSS utility.

### Deferred to Follow-Up Work
- Updating the `SessionsBoard.tsx` in the renderer (actual app board) — the user's request is scoped to the landing page demo only.
- Adding actual interactivity to dismiss an "attention" card's glow in the demo (auto-clears on advancement is sufficient for now).
- A right-to-left card animation (card visibly jumping back to `working` from a later column) — the existing mechanic of spawning a fresh card in `working` is sufficient for now.

### Outside scope
- The `AppMockup/constants.ts` workspace data (`WORKSPACES`, `FILE_CHANGES`, etc.) — these feed a different view mode (the LeftSidebar), not the board columns.

---

## High-Level Technical Design

### Column schema before vs. after

```
BEFORE                          AFTER
──────────────────────────────  ──────────────────────────────────────
[Working]  col 0  #60a5fa       [Working]   col 0  #60a5fa
[Needs you] col 1  #fb923c  ──► REMOVED — replaced by in-column attn UI
[In review] col 2  #facc15  ──► [Staging]  col 1  #a78bfa  (pre-PR)
[Ready]     col 3  #4ade80      [In Review] col 2  #facc15  (PR open)
                                [Ready]     col 3  #4ade80
```

### "Needs you" attention card treatment

```
Column (e.g., Working)
┌──────────────────────────────────────────┐
│ ┌── attention card (sorted first) ──────┐│ ◄── pulsing amber glow border
│ │  [⚠] Needs input · amber text        ││
│ └───────────────────────────────────────┘│
│ ┌── normal card ────────────────────────┐│
│ │  [⟳] Editing files · grey text       ││
│ └───────────────────────────────────────┘│
└──────────────────────────────────────────┘
```

### Card advancement state machine

```
working ──────► staging ──────► in_review ──────► merge ──(mergeCard)──► removed
   ▲                │                │
   │                └── attention?   └── attention?
   │                    stays in         stays in
   │                    staging          in_review
   │                    (amber glow)     (amber glow)
   └── spawnRandomTask() always adds to working
```

---

## Implementation Units

### U1. Update type definitions and column constants in AppMockup.tsx

**Goal:** Change `BoardColumnId` type and the `columns` array to reflect the new 4-column schema. Remove `action`, add `staging` and `in_review`.

**Requirements:** R1, R2, R3, R4, R6

**Dependencies:** none

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- Change `BoardColumnId = "working" | "action" | "pending" | "merge"` → `"working" | "staging" | "in_review" | "merge"`
- Update `columns` array: `{ id: "staging", title: "Staging", count: ... }` and `{ id: "in_review", title: "In Review", count: ... }`
- Update `COLUMN_COLORS` map: remove `action` and `pending` keys, add `staging: "#a78bfa"` and `in_review: "#facc15"` (keep yellow for review)
- Update the `aria-label` on the root `div` to describe the new column names
- Update `OrchestratorView`: change `waitingCards` filter from `card.column === "action"` to `card.activityState === "waiting"` — makes it column-agnostic

**Patterns to follow:** Existing column constant shape in `columns` array; `COLUMN_COLORS` object keyed by `BoardColumnId`.

**Test scenarios:**
- TypeScript compilation passes with no errors on the union type change
- All existing references to `"action"` and `"pending"` are updated or removed (no TS errors left)
- `COLUMN_COLORS` has exactly 4 entries matching the new `BoardColumnId` union

**Verification:** `npm run frontend:typecheck` passes; no `"action"` or `"pending"` strings remain in AppMockup.tsx.

---

### U2. Remap static card data to new column IDs

**Goal:** Update all static `StaticPreviewCard` and `PreviewCard` data so cards start in the correct new columns. Cards that previously occupied `action` are redistributed to `working` (with attention state) or `staging` (with attention state). Update `trackCardTemplates` index mapping.

**Requirements:** R2, R3, R4, R8

**Dependencies:** U1

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- In the top-level `columns` static data (the `satisfies PreviewColumn[]` block): change `id: "action"` → `id: "staging"`, `id: "pending"` → `id: "in_review"`. Cards in those columns should have activities fitting the new stages:
  - Staging cards: activity like "Running checks", "Testing route handling", activityState `"running"` or `"waiting"` (if attention card)
  - In Review cards: activity like "Reviewer assigned", "CI passing", activityState `"reviewing"` or `"passed"`
- In `trackCardTemplates`: the second element (index 1) in each track's card array now maps to `staging`; index 2 maps to `in_review`. Update the `column` assignment in `createInitialCards` — it uses `columns[index].id` so the type mapping is automatic once columns is updated.
- Cards with `tone: "blocked"` and `activityState: "waiting"` that were placed in `action` should now be placed in `staging` or `working`. Choose `staging` for "mid-testing decision" scenarios and `working` for "agent paused before testing" scenarios.
- Review the `landingIncomingCards` and `incomingCardsByTrack` arrays — these always spawn to `working`, no column reference to update beyond removing any `"action"` references.

**Patterns to follow:** Existing `previewCard()` helper for constructing static cards with defaults.

**Test scenarios:**
- Board renders with all 4 columns populated with cards on page load
- No column shows 0 cards unexpectedly (each should have at least 1 visible card in the initial state)
- Attention cards (tone blocked) appear in either `working` or `staging`, not in their own column

**Verification:** Visually inspect the hero board: 4 columns visible, populated, no empty "Needs you" column, attention cards present in Working or Staging.

---

### U3. Update `advanceCard` flow to skip `action`, route through `staging`

**Goal:** Change the card advancement logic so cards move working → staging → in_review → merge, with appropriate activity/state labels per stage.

**Requirements:** R6, R7

**Dependencies:** U1

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
```
advanceCard(card):
  if card.column === "working":
    → column: "staging", activity: "Running checks", activityState: "running",
      badge: null, tone: "default"
  if card.column === "staging":
    → column: "in_review", activity: "Reviewer assigned", activityState: "reviewing",
      badge: "Awaiting review", tone: "review"
  if card.column === "in_review":
    → column: "merge", activity: "Approved", activityState: "passed",
      badge: "Ready", tone: "ready"
  (merge is handled by mergeCard, not advanceCard)
```
- When advancing an attention card (tone: "blocked"), clear the attention state: reset tone to `"default"` for the staging transition, etc. This represents the user "unblocking" the card.
- Keep `time: "just now"` on every advance.

**Patterns to follow:** Existing `advanceCard` function shape — pure function returning a new `PreviewCard`.

**Test scenarios:**
- A card in `working` advances to `staging` (not to `action` — that column no longer exists)
- A card in `staging` advances to `in_review`
- A card in `in_review` advances to `merge`
- An attention card (tone: "blocked") that is advanced loses its attention state
- No card ever lands in a non-existent column

**Verification:** Watch the hero board for 30 seconds: cards visibly move left-to-right through 3 column transitions before merging.

---

### U4. Implement in-column attention card pinning (sort to top)

**Goal:** Inside `BoardColumn`, attention cards (`activityState === "waiting"`) are always rendered first in the cards list, making them appear at the top of the column.

**Requirements:** R8

**Dependencies:** U1, U2, U3

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- In `BoardColumn`, before the `AnimatePresence` render, partition the `cards` prop:
  ```
  const attentionCards = cards.filter(c => c.activityState === "waiting");
  const normalCards = cards.filter(c => c.activityState !== "waiting");
  const sortedCards = [...attentionCards, ...normalCards];
  ```
- Render `sortedCards` in the `AnimatePresence`. Framer Motion's `layout` prop on `BoardCard` handles the animated reorder when a card becomes an attention card or loses that state.
- No change to `BoardCard` component in this unit — just the rendering order.

**Patterns to follow:** Existing `AnimatePresence` + `motion.div` layout pattern in `BoardColumn`.

**Test scenarios:**
- When two cards exist in a column (one attention, one normal), the attention card always appears above the normal card
- If there are no attention cards, normal ordering is preserved
- When an attention card is advanced (cleared), Framer Motion animates it out of the top position

**Verification:** Visually: any amber/attention card is always the topmost card in its column.

---

### U5. Add amber pulsing glow border to attention cards in `BoardCard`

**Goal:** Attention cards (`activityState === "waiting"`) display a pulsing amber outer glow/border so they're immediately visually distinct.

**Requirements:** R8

**Dependencies:** U4

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`
- `frontend/src/landing/tailwind.config.ts` (or equivalent config file) — add keyframe

**Approach:**
- Add a CSS `@keyframes attention-pulse` that pulses `box-shadow` between `0 0 0 1px rgba(251,146,60,0.4)` and `0 0 0 4px rgba(251,146,60,0.0)` (amber, matches `#fb923c`).
- Register the keyframe in Tailwind config under `theme.extend.keyframes` and `theme.extend.animation`.
- In `BoardCard`, conditionally apply the animation class when `card.activityState === "waiting"`:
  ```jsx
  className={cn(
    "...(existing classes)...",
    card.activityState === "waiting" && "animate-attention-pulse border-[#fb923c]/50"
  )}
  ```
- The existing amber text + icon treatment (already present for `tone === "blocked"`) is preserved.

**Patterns to follow:** Existing Tailwind animation usage in the codebase (e.g., `animate-spin` on the spinner).

**Test scenarios:**
- An attention card has an amber-tinted border that pulses visibly (not just static)
- A non-attention card has no amber border or pulse
- The animation stops (or card disappears) when the card advances out of attention state

**Verification:** Visually: attention cards in the demo clearly pulse amber at the top of their column.

---

### U6. Update `FleetBoardDemo.tsx` to new column schema

**Goal:** Sync the FeaturesSection `FleetBoardDemo` with the new 4-column labels and card state descriptions.

**Requirements:** R1, R9

**Dependencies:** U1 (conceptually — independent file change)

**Files:**
- `frontend/src/landing/src/app/components/FeaturesSection/components/FleetBoardDemo/FleetBoardDemo.tsx`

**Approach:**
- Change `columns` array:
  - `{ id: "action", label: "Needs you", color: "#fb923c" }` → `{ id: "staging", label: "Staging", color: "#38bdf8" }` (sky, per KTD-9)
  - `{ id: "review", label: "In review", color: "#facc15" }` → `{ id: "in_review", label: "In Review", color: "#facc15" }`
- Update card `column` assignments (they use `0`, `1`, `2`, `3` indices — just ensure the existing cards are placed in meaningful columns for the new schema).
- Update `BoardCard` `state` logic for column 1 and 2:
  - Column 1 (`staging`): label `"Running checks"`, color `#7dd3fc` (light sky)
  - Column 2 (`in_review`): label `"Reviewer assigned"`, color `#93c5fd` (blue)
- The rotating `movingColumn` animation cycles through 0–3 unchanged.

**Patterns to follow:** Existing `columns` const shape in `FleetBoardDemo.tsx`.

**Test scenarios:**
- FleetBoardDemo renders with 4 columns showing labels: "Working", "Staging", "In Review", "Ready to merge"
- The cycling card animation still works across all 4 columns
- No "Needs you" label appears anywhere in this component

**Verification:** Visually inspect the FeaturesSection demo: correct column labels, animation still cycles.

---

### U7. Consolidate `COLUMN_CONFIG` + extract `getCardVisualState` helper

**Goal:** Merge `columns` array + `COLUMN_COLORS` map into a single `COLUMN_CONFIG` object. Extract per-card visual derivation from `BoardCard`'s inline ternaries into a pure `getCardVisualState(card)` function. Sets up cleaner ground for U8–U11.

**Requirements:** R14

**Dependencies:** U1 (needs new `BoardColumnId` union)

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- Define `COLUMN_CONFIG: Record<BoardColumnId, { title: string; color: string; weight: number }>`. The static seed `columns` array for initial data can be derived via `Object.entries(COLUMN_CONFIG)` OR kept as-is if the id order matters — pick whichever preserves the existing `createInitialCards` mapping with fewer edits.
- Delete `COLUMN_COLORS` (subsumed).
- Extract `getCardVisualState(card: PreviewCard)` returning `{ badgeColor, iconComponent, stateLabel, prClass, prStatus }`. Move the `tone === "ready" ? ... : tone === "blocked" ? ...` cascades and the `activityState === "passed" ? ...` icon-picker into it.
- `BoardCard` calls `getCardVisualState(card)` once at the top and consumes the object.

**Patterns to follow:** Existing pure-helper style in the file (e.g., `advanceCard`, `randomItem`).

**Test scenarios:**
- Every card renders identically to pre-refactor (visual regression check by eye)
- No `card.tone === "ready"` or similar cascades remain inline in `BoardCard`'s JSX
- Adding a new hypothetical tone requires editing exactly one function

**Verification:** `npm run frontend:typecheck` passes; visual diff of the board vs. main is nil.

---

### U8. Apply chosen column color scale (KTD-9)

**Goal:** Set `COLUMN_CONFIG` colors so viewers read column position as progression.

**Requirements:** R13

**Dependencies:** U7

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:** Set `COLUMN_CONFIG` colors to `working: "#60a5fa"`, `staging: "#38bdf8"`, `in_review: "#facc15"`, `merge: "#4ade80"`. Explicitly reject the violet `#a78bfa` proposed earlier in the plan — the sky→yellow→green scale reads as progression, violet reads as sideways.

**Test scenarios:**
- The four column-header color dots render in the specified hex values
- No violet remains anywhere in `AppMockup.tsx`

**Verification:** Visual: color progression left→right reads as "further along."

---

### U9. Weight card advancement toward left-most columns

**Goal:** Replace uniform-random `advanceCard` selection with a weighted picker so cards visibly drain left-to-right.

**Requirements:** R10

**Dependencies:** U3, U7

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- In `runStep` (the `useEffect` interval body), replace `randomItem(current.filter(...))` with a weighted picker:
  ```
  pickWeighted(cards, card => COLUMN_CONFIG[card.column].weight)
  ```
- Implement `pickWeighted` locally: sum weights, pick random threshold in `[0, total)`, walk cards accumulating weight until threshold passed. Return that card.
- Weight values are set in KTD-6: working=4, staging=3, in_review=2, merge=1. Keep them on `COLUMN_CONFIG` so weights and colors live in one place.

**Patterns to follow:** Existing `randomItem` helper (`AppMockup.tsx:967-970`) — `pickWeighted` sits beside it.

**Test scenarios:**
- Over 100 simulated `runStep` invocations with a uniformly-distributed board, `working` cards are picked roughly 4× more often than `merge` cards (rough ratio check, not exact)
- No card can be picked from a column that has zero cards (weighted picker returns `null` if all weights sum to 0)
- The demo still visibly cycles — cards don't stall in any column

**Verification:** Watch board for 60 seconds: the left columns drain into the right; `merge` fires reliably but less often than `working` advances.

---

### U10. Head-of-line card treatment

**Goal:** The topmost card in each column reads as "currently happening"; queued cards below read as "waiting behind."

**Requirements:** R11

**Dependencies:** U4 (needs the sort-attention-to-top ordering)

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- In `BoardColumn`, pass `isHead={index === 0}` when mapping `sortedCards` to `BoardCard`. First card in the sorted list = head-of-line regardless of whether it's an attention card or a normal card.
- In `BoardCard`, accept optional `isHead` prop:
  - When `isHead`: add a 2px left-edge accent bar in the column color (`border-l-2` with the column color), and slightly brighter border overall (e.g., `border-[var(--preview-border)]/80` vs. the base `border-[var(--preview-border)]`).
  - When not head: apply `opacity-[0.88]` so queued cards visibly recede.
- Column color is available via `COLUMN_CONFIG[card.column].color` — pass it or look it up in `BoardCard`.

**Test scenarios:**
- In a column with 3 cards, only the topmost has the accent bar; the other two are dimmed
- When cards advance and a new card floats to the top, the accent bar visibly moves with the reorder animation
- If the head card is an attention card, the accent bar and the amber glow coexist without visually clashing

**Verification:** Visual: the "currently active" card in each column reads as distinct from the queued ones.

---

### U11. Cap attention pulse to one per column; add `⚠ N waiting` chip

**Goal:** Preserve the amber pulse's scarcity value even when multiple cards need attention in the same column.

**Requirements:** R12

**Dependencies:** U4, U5

**Files:**
- `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`

**Approach:**
- In `BoardColumn`, compute `waitingCount = attentionCards.length`. Pass `isPulsing` to `BoardCard`: `true` only for `attentionCards[0]`, `false` for `attentionCards[1..N]` (they still get the amber border from U5, but no `animate-attention-pulse` keyframe).
- In the column header, when `waitingCount > 1`, render a small `⚠ {waitingCount - 1} waiting` chip beside the existing count. Use amber text on a subtle bg (`bg-[#fb923c]/10 text-[#fb923c]`). When `waitingCount <= 1`, render nothing.
- `BoardCard` conditionally applies `animate-attention-pulse` only when `card.activityState === "waiting" && isPulsing` (not on all waiting cards).

**Test scenarios:**
- Column with 1 waiting card: card pulses, no chip in header
- Column with 3 waiting cards: only topmost pulses, header shows `⚠ 2 waiting`
- Column with 0 waiting cards: no pulse, no chip
- When the pulsing card advances and a previously-static waiting card becomes topmost, the pulse animation transfers cleanly (no double-pulse mid-frame)

**Verification:** Force the demo into a state with 2+ attention cards in one column (e.g., temporarily bump the incoming-card spawn weight); confirm chip renders and only one card pulses.

---

## Open Questions

- **Tailwind config location**: The keyframe for `attention-pulse` needs to go in a Tailwind config. The landing app may use `frontend/src/landing/tailwind.config.ts` — verify the correct path before adding the keyframe. Alternatively it can be a `@keyframes` rule in a global CSS file if Tailwind's `safelist` path is tricky for a dynamic animation name.

---

## Sources & Research

Local research only — no external references needed. The implementation is contained within two self-contained React components using existing patterns (Framer Motion `layout`, Tailwind animation utilities, `AnimatePresence`).
