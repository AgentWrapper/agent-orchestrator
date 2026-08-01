---
title: "Hero board UX & flow improvements — ideation"
date: 2026-08-02
status: open
scope: landing-page hero board (AppMockup.tsx) + FleetBoardDemo.tsx
related_plan: docs/plans/2026-08-02-001-feat-hero-board-column-redesign-plan.md
---

# Hero board UX & flow improvements — ideation

## Grounding context

- **Current code**: `frontend/src/landing/src/app/components/HeroSection/components/AppMockup/AppMockup.tsx`, `frontend/src/landing/src/app/components/FeaturesSection/components/FleetBoardDemo/FleetBoardDemo.tsx`.
- **Plan already committed**: `docs/plans/2026-08-02-001-feat-hero-board-column-redesign-plan.md` — restructure to Working → Staging → In Review → Ready to merge, with in-column amber-glow attention treatment.
- **User's root complaint**: current card flow between the 4 columns is random and non-intuitive; the "Needs you" column is usually empty and wastes space.
- **Design constraint**: `DESIGN.md` + `CLAUDE.md` pin the visual language to agent-orchestrator verbatim; ideas that require palette/brand deviations are out.

### Topic axes

Five orthogonal aspects of the board's UX/flow that any improvement should be recognizable on:

- **A1. Column semantics & communication** — labels, colors, per-column badges/counts
- **A2. Card flow mechanics** — how cards move, timing, direction, cadence
- **A3. Attention & interruption UI** — the "needs you" treatment and other urgency signals
- **A4. Card information hierarchy** — what a card shows, what's headline vs. footer
- **A5. Code leverage** — state derivation, column config, consolidation

---

## Survivors (top 7)

### S1. Bias `advanceCard` selection toward left-most columns

**Axis:** A2 · Card flow mechanics
**Basis:** `direct` — `AppMockup.tsx:2010-2027` (`runStep` uses `randomItem()` over ALL non-merging cards)

**What.** Weight the random pick so cards in `working` advance more often than cards in `staging`, which advance more often than cards in `in_review`. E.g., weights `[4, 3, 2, 1]` across the four columns.

**Why it matters.** The plan fixes the column *positions* but leaves the *advancement logic* fully random. The visible effect will still be "any card, any column, any time" — which is exactly what the user complained looked random. Biasing selection makes the pipeline visibly drain left-to-right without breaking the "not compulsory" requirement (any card can still advance; some just move faster than others).

**Meeting test.** Yes — this is the root fix for the flow complaint. A ~10-line change with an outsized perceived-quality delta.

---

### S2. "Head-of-line" treatment for the topmost card in each column

**Axis:** A2 · Card flow mechanics (spans A4)
**Basis:** `external` — restaurant chit rail / air-traffic-control queue metaphor; `reasoned` — differentiation between "actively happening" and "queued behind"

**What.** The topmost card in each column renders with a slightly brighter border and a subtle "current" indicator (e.g., a thin colored bar on the left edge matching the column color). Cards below it are dimmed ~5-10%, reading as "waiting behind."

**Why it matters.** Right now every card in a column has equal visual weight. A viewer can't tell what's *currently happening* vs. what's queued. Head-of-line treatment makes the demo readable at a glance: "in Working, right now, this card is being edited."

**Interaction with S1.** These reinforce each other — the head-of-line card is also the card most likely to advance next.

**Meeting test.** Yes — small CSS change, big affordance shift.

---

### S3. Cap simultaneous pulsing attention cards; overflow as summary chip

**Axis:** A3 · Attention & interruption UI
**Basis:** `reasoned` — the current plan sorts ALL `activityState === "waiting"` cards to top with pulsing amber; if the demo happens to accumulate 3+ waiting cards in one column, the pulses collide into noise

**What.** Show at most one pulsing card per column at any time (the topmost waiting card). Any additional waiting cards below it use the amber static border (no pulse animation) and the column header shows a `⚠ 2 waiting` chip.

**Why it matters.** Amber pulse is a scarcity signal — its value drops fast at multiplicity. The chip does the aggregation work; the pulse stays reserved for the one card that actually needs attention.

**Meeting test.** Yes — matters as soon as the demo state produces >1 attention card, which the current advance/spawn timing can easily do.

---

### S4. Promote `state` (activity) to the card's headline row

**Axis:** A4 · Card information hierarchy
**Basis:** `direct` — `AppMockup.tsx:1453-1522` (BoardCard renders title first, then branch/PR, then activity/time at the bottom)

**What.** The card's most dynamic field is its `activity` ("Editing files", "Reviewer assigned", "Approved"). Currently it's the last row. Move it to the top-right as a chip beside the agent avatar, so the state is scannable in the first ~200ms. The title stays as identifier below. Branch/PR stays as reference at the bottom.

**Why it matters.** For a demo intended to communicate "agents are actively doing things", the most active piece of info should be the most visually prominent. Right now the eye reads title → branch → PR → state, when the natural read order should be state → title → provenance.

**Caveat.** This touches every card visually — worth a mock-up before merging. Could also be done as a smaller change: just make the state text slightly larger/bolder in its current position.

**Meeting test.** Yes — affects the whole card design.

---

### S5. Inter-column "hand-off" trail on advancement

**Axis:** A2 · Card flow mechanics
**Basis:** `reasoned` + `external` — physical Kanban / conveyor visualization; Framer Motion `layoutId` already handles the position tween, this is adding a companion cue

**What.** When a card advances to the next column, a subtle "ghost" element (small dot or short fading trail matching the destination column color) briefly animates from the origin card's position toward the destination column header. ~300ms, low opacity, then gone.

**Why it matters.** The current Framer `layout` animation moves the card element itself between columns, but the transition reads as "card teleported to a new column" rather than "card was handed off." The ghost token adds a direction cue that reinforces left-to-right flow without disturbing the card's own motion.

**Risk.** Could feel over-animated. Should ship behind the same reduced-motion respect the rest of the app uses.

**Meeting test.** Yes — small polish, but it's the exact "flow doesn't feel like flow" complaint made visual.

---

### S6. Progressive column color scale

**Axis:** A1 · Column semantics
**Basis:** `direct` — `AppMockup.tsx:213-218` (`COLUMN_COLORS`) + the plan's proposed `staging: "#a78bfa"` violet

**What.** Replace the current arbitrary hue jumps (`blue → violet → yellow → green` in the planned schema) with a scale that reads as progression. Two candidates:
1. **Cool-to-warm ramp**: `#60a5fa (blue) → #7dd3fc (light blue) → #facc15 (yellow) → #4ade80 (green)` — familiar CI language, but repeats "yellow = caution" which the plan proposes for In Review.
2. **Monochrome saturation ramp**: `#60a5fa → #93c5fd → #bfdbfe → #4ade80 (only the final one shifts to green)` — reads as "getting quieter until it lands green." Cleaner but less colorful.

Either is preferable to the plan's proposed `#a78bfa` (violet) for Staging, which visually reads as a step *sideways* from blue, not forward.

**Why it matters.** Column color is a free semantic channel — currently unused. A viewer's eye reads horizontal color progression as "further right = more done" almost involuntarily.

**Meeting test.** Yes — one-line change to `COLUMN_COLORS`, meaningful semiotic gain.

---

### S7. Consolidate visual-state derivation into a column-config + card-state helper

**Axis:** A5 · Code leverage
**Basis:** `direct` — `BoardCard` in `AppMockup.tsx:1390-1527` derives icon, badge color, PR status text, and activity color through cascades of `card.tone === "ready" ? ... : card.tone === "blocked" ? ...` inline in JSX; `COLUMN_COLORS` is separate from `columns`

**What.**
- Extract `getCardVisualState(card): { badgeColor, iconComponent, stateLabel, prStatusText, prClass }` — one place per rendering concern.
- Merge `columns` array + `COLUMN_COLORS` map into a single `COLUMN_CONFIG` object keyed by `BoardColumnId`, holding `id`, `title`, `color`, and (new) any per-column defaults.

**Why it matters.** The current plan already adds ~5 more `column === "staging" ? ...` conditionals. Doing this consolidation *inside* the plan's implementation removes ~30 lines of scattered ternaries, makes adding a future column-state change (e.g., "Ready to merge shows a merge queue position") a one-object edit, and pays for itself immediately during the plan's own work.

**Meeting test.** Yes — this is the "do it while you're already touching these files" refactor. Cheap now, expensive to backfill.

---

## Honorable mentions (kept, not top-tier)

### HM1. Deliberate pacing rhythm

**Axis:** A5 · Demo rhythm
**Basis:** `direct` — `AppMockup.tsx:963-965` (`randomDelay` = 1000-3000ms uniform)

Uniform random pacing feels mechanical. Try: base cadence 2500-4000ms, but with a small chance (~15%) of a "burst" (2-3 advances in quick succession within 200ms). Mimics the rhythm of real agent activity — quiet, then a flurry.

Small change, hard to judge without playing with it. Worth trying if S1 (bias) alone doesn't produce enough visible flow.

---

### HM2. Animate the "PRs merged" counter on merge

**Axis:** A5 · Demo rhythm
**Basis:** `direct` — the topbar in `AppMockup.tsx:1204-1213` already shows `{mergedCount} PRs merged`; `mergeCard` in `AppMockup.tsx:1953-1959` increments it silently

Tiny polish: when `mergeCard` fires, brief tick animation on the topbar counter (scale bump + color flash for ~400ms). Reinforces "cards actually complete the pipeline" instead of vanishing without a trace.

Rejected from top tier only because it's isolated polish, not structural.

---

### HM3. Column-header WIP hint

**Axis:** A1 · Column semantics
**Basis:** `external` — standard Kanban practice; `reasoned` — anchors "this is a real pipeline" framing

Show `4 in progress` or `WIP: 4` in the column header alongside the existing count. Nudges the mental model from "list of cards" to "workflow with capacity."

Rejected from top tier because it's a minor label change and its value depends on whether viewers already read the board as Kanban (many will not).

---

## Rejected (with reasons)

- **"Focus mode" — click a column to zoom in, minimize the others.** The demo is passive/auto-cycling — a viewer isn't clicking. Introducing interactivity that a landing-page viewer won't discover adds complexity for no observable benefit.

- **Hide empty columns (e.g., collapse "Ready to merge" when nothing's there).** Destabilizes the layout — viewer sees columns appearing/disappearing as demo state cycles. Breaks the visual stability a hero demo depends on.

- **Group cards by feature/track within columns (mini-swimlanes).** The sidebar already provides per-track scoping. Adding intra-column grouping duplicates that channel and adds density.

- **"One protagonist card" narrative — show a single card moving through all 4 stages.** Contradicts the demo's core positioning ("many agents in parallel"). A landing viewer needs to see scale, not a single-card story.

- **Change amber ("needs you") to a positive color like purple.** Amber is universal warning language; the substitution loses semantics that viewers already parse instantly. Reframing "attention" as opportunity is a copy problem, not a color one.

- **Multi-repo aggregation in the demo.** Out of scope — the demo is one repo's board, and the sidebar tracks already provide within-repo variety.

- **Factory-floor / mechanical aesthetic.** Vague and violates `DESIGN.md`'s hard rule to clone agent-orchestrator's visual language verbatim.

- **Mobile vertical layout.** Already handled in the existing code (`snap-x`, `auto-cols-[85%]` on small viewports).

- **"Zero-metadata card" ultra-compact mode toggle.** Interesting but introduces a whole new mode users can't discover on a landing page. Belongs (if anywhere) in the real app, not the demo.

---

## Suggested next step

Fold **S1, S2, S3, S6, S7** into the existing plan as additional implementation units before starting `/ce-work` — they're small, all cohabit the same files, and each directly reinforces the "strict L→R, in-column attention" thesis the plan is built on. **S4** (metadata reorder) warrants its own visual review before committing. **S5** (hand-off trail) is worth prototyping once the column redesign lands.

The honorable mentions can wait — they're polish that reads better after the structural changes stabilize.
