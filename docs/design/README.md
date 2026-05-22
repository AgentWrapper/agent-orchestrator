# ao Dashboard — Design Research Artifacts

*Compiled February 2026 via competitive analysis, Playwright CSS extraction, and codebase audit.*

---

## Documents

| File | Description |
|------|-------------|
| [`design-brief.md`](./design-brief.md) | **Main design brief** — competitive analysis, full color palette, typography, all component specs, anti-patterns, implementation stack recommendation, and current codebase audit |
| [`session-detail-design-brief.md`](./session-detail-design-brief.md) | Design spec for `/sessions/[id]` — the single-agent investigation view |
| [`orchestrator-terminal-design-brief.md`](./orchestrator-terminal-design-brief.md) | Design spec for the orchestrator terminal — full-viewport command center with status strip |
| [`session-replacement-handoff.md`](./session-replacement-handoff.md) | Design plan for successor sessions, PR takeover, and context handoff after replacing a worker |
| [`token-reference.css`](./token-reference.css) | **Ready-to-use CSS** — drop-in replacement for `globals.css` `@theme` block |
| [`competitive-analysis-raw.md`](./competitive-analysis-raw.md) | Raw research notes from all 14 competitor sites (Linear, Vercel, Railway, Fly.io, Inngest, Temporal, Grafana, WandB, LangSmith, Retool, Render, PlanetScale, Supabase, GitHub Copilot) |
| [`design-brief-v1.md`](./design-brief-v1.md) | Original v1 brief (text-only research, pre-Playwright CSS extraction) — kept for reference |

## Screenshots

| File | Description |
|------|-------------|
| [`screenshots/linear-homepage.png`](./screenshots/linear-homepage.png) | Linear.app captured via Playwright (311KB) — source for verified CSS token extraction |
| [`screenshots/railway-homepage.png`](./screenshots/railway-homepage.png) | Railway.app captured via Playwright (444KB) — visual palette reference |

---

## Research Methods

**Phase 1 — Text analysis**: Two parallel research agents analyzed 14 competitor product sites via WebFetch, extracting visual patterns, color systems, and design philosophy from HTML/CSS content.

**Phase 2 — Playwright CSS extraction**: Installed `@playwright/mcp` and extracted live CSS custom properties from [linear.app](https://linear.app) using `document.styleSheets` enumeration. This yielded ground-truth values for Linear's token system — the most rigorous competitive design data available without access to their Figma files.

**Phase 3 — Playwright screenshots**: Captured screenshots of Linear and Railway via headless Chromium for visual reference.

**Phase 4 — Codebase audit**: Read the entire `packages/web/` source (components, types, CSS tokens) to map research recommendations against the actual implementation. Produced implementation audit sections in each brief with prioritized delta tables.

---

## Key Findings

1. **Linear's verified token system** (via Playwright CSS extraction) is the closest design benchmark. See `design-brief.md §1`.
2. **Current dashboard uses GitHub-inspired colors** (`#0d1117` base). Recommended shift: blue-cast dark (`#0C0C11`). See `design-brief.md §7`.
3. **The 6-level attention zone system** (`merge → respond → review → pending → working → done`) is architecturally correct and well-implemented. Visual polish is the primary gap.
4. **Highest-impact single change**: load Inter Variable via `next/font/google`. Immediately elevates the typography to Linear/Supabase tier.
5. **Orchestrator terminal** needs visual differentiation (violet accent, status strip, full-viewport height) — currently indistinguishable from agent session pages.

---

## Design Token Quick Reference

The recommended palette is in [`token-reference.css`](./token-reference.css). The current palette is in `packages/web/src/app/globals.css`.

```
Current base:      #0d1117  (GitHub blue-green dark)
Recommended base:  #0C0C11  (neutral blue-cast dark)

Current accent:    #58a6ff  (GitHub blue)
Recommended accent: #5B7EF8 (blue-indigo, between Linear blue and brand purple)
```

---

*All Linear CSS values are ground-truth verified from live CSS. Railway values are visually estimated from screenshot. Other competitor values are from text/HTML analysis.*
