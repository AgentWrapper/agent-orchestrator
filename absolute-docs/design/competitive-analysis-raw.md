# Competitive Visual Analysis — Raw Research Notes
*Compiled February 2026 via text/HTML analysis of 14 competitor sites*
*Used as source material for design-brief.md*

---

## Batch 1: Infrastructure & Developer Tool Dashboards

### Linear (linear.app)
**CSS token system** — Inter Variable, Berkeley Mono, Tiempos Headline. 9-level title scale. Quaternary text hierarchy.
Dark mode background: near-black `#08090A`. Panel bg: `#0F1011`. Brand accent: `#7070FF`.
Status colors: Blue `#4EA7FC`, Red `#EB5757`, Green `#27A644`, Orange `#FC7840`, Yellow `#F0BF00`.
Font weights: 300/400/510/590/680 (variable font, non-standard values).
*Ground-truth values confirmed via Playwright CSS extraction — see design-brief.md.*

### Vercel (vercel.com)
Pure black/white: `#000000` dark bg, `#FAFAFA` light bg. Zero saturation philosophy.
Geist + Geist Mono (proprietary typefaces). Status dots: colored circles inline with resource names.
Tone: Austere technical authority.

### Railway (railway.app)
Multi-theme architecture. Signature dark: `hsl(250, 24%, 9%)` ≈ `#13111C` (dark desaturated purple).
Inter + Inter Tight + JetBrains Mono + IBM Plex Serif. Semantic palette: `hsl(152)` green, `hsl(1)` red.
Shadow: `0 0 30px hsla(0,0%,30%,.25)` — diffuse ambient glow. Vaporwave Easter egg theme.
Tone: Playful sophistication.

### Fly.io
Dark navy `#0A0E27`. Electric purple/magenta CTAs.
Fricolage Grotesque (quirky headline) + Mackinac (warm serif body) + Fragment Mono.
Most typographically adventurous stack in the group.
Tone: Confident and rebellious.

### Inngest (inngest.com) — workflow orchestration
Stone-950 `#0A0A0A` warm black. "Inngest Lux" amber `#CBB26A`. Supplementary: green `#2C9B63`, rust `#CB5C32`.
Whyte + Whyte Inktrap (display), Circular (body). Top-border accent cards, `rounded-xl` 12px.
Grid background texture at 0.3 opacity. Stone-400 borders (`rgba(white, 0.1)`).
Tone: Warm enterprise dark mode.

### Temporal (temporal.io) — workflow orchestration
Deep ultraviolet/indigo backdrop, star-grid hero pattern. Magenta `~#D946EF` CTAs.
Rainbow gradients in testimonial sections. System sans-serif typography.
Tone: Cosmic reliability.

### Grafana (grafana.com)
White background (the outlier). Orange `#F46800` brand. Blue `#0066FF` CTAs.
Generous whitespace. High information density in actual product panels.
Tone: OSS pragmatism.

### Weights & Biases / wandb.ai
`#1A1C1F` charcoal. Cards: `#212429`/`#282A2F`. Cyan `#00AFC2` accent. Yellow-gold CTA gradient `#FFCC33→#FFAD33`.
Borders: `1px solid #34373C`. Source Serif 4 (headings!), Source Sans 3, Source Code Pro.
Upward box shadow: `0px -1px 16px rgba(10,14,21,0.5)`. Border-radius 8–16px.
Tone: Scientific gravitas meets ML ambition.

---

## Batch 2: LLM Observability, Internal Tools & Databases

### LangSmith (smith.langchain.com) — LLM observability
`#030710` near-black with blue cast. Electric blue `#4D65FF` interactive. JetBrains Mono as PRIMARY font.
Dense trace tree (left panel) + detail (right panel). Green ✓ / Red ✗ status icons.
Run types distinguished by icon + hierarchy position. Heat maps for evaluation results.
Tone: Analytical transparency. "Know what your agents are really doing."

### Retool (retool.com)
Dark charcoal bg. Px Grotesk (display) + Saans variable font (body). Canvas + sidebar model.
Tone: Enterprise sophistication with approachability.

### Render (render.com) — deployment dashboard
Purple-900 → orange gradient in announcement banner. Dark mode. Standard semantic status colors.
Service cards with inline status. Log explorer: terminal-style dark view.
Tone: Trustworthy speed and simplicity.

### PlanetScale (planetscale.com) — database dashboard
OKLCH-based green scale. Both light and dark mode. Lato + Montserrat.
Schema diff: green additions, red deletions. 117 documented UI screens, 49 components.
Branch status badges, deploy request workflow panels.
Tone: Engineering credibility at scale.

### Supabase (supabase.com)
Brand green: `#3ECF8E` / `#34B27B`. Background: `#11181C`. Inter font.
Built on Radix UI + Tailwind 3.4 + shadcn/ui. Table editor dense/spreadsheet-like.
Left sidebar: Table Editor / Database / Auth / Storage / Edge Functions / Realtime.
RLS enabled/disabled badge in table editor.
Tone: Radical developer empathy.

### GitHub Copilot agent mode (VS Code)
Deep purple brand. VS Code dark background inherits. Sequential tool invocation list.
Each tool call: labeled step, collapsible details. Undo Last Edit control after edits.
Agent "thinking" state: animated ellipsis. No dramatic animations — UI recedes for code.
Tone: Capability amplification.

---

## Cross-Cutting Patterns

**Dark mode as default**: LangSmith, Supabase, GitHub Copilot, Retool, WandB — all dark native.
**Status color convergence**: Green success / Red error / Amber warning universal. Differentiation in shape + animation.
**Typography split**: Monospace-forward (LangSmith with JetBrains Mono as primary) vs. clean sans (Supabase with Inter, Retool with Px Grotesk).
**Semantic color as brand**: Supabase `#3ECF8E` green = inseparable from identity. PlanetScale OKLCH green scale.
**Progressive disclosure**: All use expandable rows, tabs, collapsible sections to manage complexity.
**AI activity representation**: Copilot = inline step disclosure in dev environment. LangSmith = separate observability dashboard with trace trees. ao sits between these — a monitoring dashboard for the agent lifecycle.
