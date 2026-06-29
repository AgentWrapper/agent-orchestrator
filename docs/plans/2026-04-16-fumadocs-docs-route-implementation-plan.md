# Agent Orchestrator /docs Plan — Strategy + Execution (All-Rounded)

Status: Approved planning artifact for implementation handoff
Owner: Agent Orchestrator team
Scope: Build complete user-facing docs at `/docs` inside `packages/web` now; migrate to `website/` later

---

## 0) Why this document exists

You asked for two things at once:
1. Rich strategic context (so implementers make good decisions), and
2. A one-shot coding brief (so they actually ship, not over-plan).

This document combines both. It is intentionally opinionated and execution-focused.

---

## 1) Product context and decision record

### Problem
Agent Orchestrator has strong feature docs, but no coherent user-facing docs experience. New users currently piece things together from README + scattered files.

### Goal
Ship a complete, high-clarity documentation experience that answers:
- What is AO?
- What can I do with AO?
- How do I do it right now?

### Confirmed staging decision
- Phase 1 (now): implement docs at `/docs` in `packages/web`.
- Phase 2 (later, after approval): copy/migrate docs module into root `website/` app.

### Why this is the correct strategy
1. Fastest path to real user value.
2. Lower risk than architecture move + docs rewrite simultaneously.
3. Lets us validate IA/content before migration.
4. Keeps later move mostly mechanical if boundaries are clean.

---

## 2) Inputs and constraints already validated

- Issue reference: #1133 (user-facing docs requirement).
- PR #1047 was useful as process/style input, but not merged on main.
- AO visual source of truth:
  - `DESIGN.md`
  - `packages/web/src/app/globals.css`
- Current docs source material to mine:
  - `README.md`
  - `SETUP.md`
  - `docs/CLI.md`
  - `TROUBLESHOOTING.md`
  - `ARCHITECTURE.md`
  - `agent-orchestrator.yaml.example`
  - selected user-relevant pieces of `docs/DEVELOPMENT.md`

---

## 3) Non-negotiable principles

1. User-first docs, not contributor diary.
2. Complete workflows, not fragmented reference dumps.
3. AO visual identity must remain consistent.
4. No placeholder pages in core journey.
5. Implementation must be portable to `website/`.
6. No breaking dashboard behavior.

---

## 4) Information architecture (Diátaxis)

### Tutorials (learning-oriented)
- First run from zero
- End-to-end issue -> PR flow
- Running multiple agents in parallel

### How-to guides (task-oriented)
- Configure GitHub issue workflow
- Configure Linear workflow
- Handle CI failures
- Handle review comments
- Add/operate multiple projects
- Remote access setup (incl. practical caveats)
- Recover stuck/orphan sessions

### Reference (lookup-oriented)
- CLI reference
- Config reference
- Plugin slot matrix
- Runtime behavior and status model
- Ports/env vars/endpoints references

### Explanation (understanding-oriented)
- Why orchestration beats single-agent terminal loops
- AO lifecycle model
- Reactions and escalation semantics
- Plugin architecture reasoning

---

## 5) Required sitemap for Phase 1

- `/docs`
- `/docs/getting-started`
- `/docs/installation`
- `/docs/quickstart/first-run`
- `/docs/workflows/parallel-issues`
- `/docs/workflows/ci-recovery`
- `/docs/workflows/review-loop`
- `/docs/workflows/multi-project`
- `/docs/configuration/overview`
- `/docs/configuration/projects`
- `/docs/configuration/reactions`
- `/docs/configuration/remote-access`
- `/docs/cli`
- `/docs/plugins`
- `/docs/troubleshooting`
- `/docs/faq`
- `/docs/changelog`
- `/docs/migration`

No core page above may be empty/placeholder.

---

## 6) UX + visual design requirements

### Must align with AO style
- warm dark palette
- dense but readable docs layout
- subtle borders and restrained depth
- Geist-like prose + JetBrains Mono for commands/code
- low-drama motion

### Must avoid
- cinematic/marketing-heavy visuals
- decorative effects that hurt reading
- detached design language that looks like another product

### Token anchor (dark mode)
Use AO tokens rather than hardcoded one-offs:
- `--color-bg-base: #121110`
- `--color-bg-surface: #1a1918`
- `--color-bg-elevated: #222120`
- `--color-text-primary: #f0ece8`
- `--color-text-secondary: #a8a29e`
- `--color-accent: #8b9cf7`
- `--color-accent-amber: #f97316`
- `--color-border-default: rgba(255,240,220,0.13)`

---

## 7) Fumadocs feature set to implement now

1. TOC + heading anchors
2. Full-text search (+ keyboard shortcut hint)
3. Syntax highlighted code blocks (Shiki), copy button, code groups
4. Callouts/admonitions: info, success, warning, danger
5. Sidebar from page tree
6. Last-updated metadata + edit links
7. Prev/next page navigation
8. Theme handling consistent with AO
9. Lightweight feedback mechanism per page
10. LLM-friendly output path if compatible in stack

OpenAPI docs integration:
- Include only if dependency compatibility is clean in Phase 1.
- Otherwise explicitly mark as Phase 2 extension.

---

## 8) Dependency and compatibility strategy (critical)

Because `packages/web` is on Next 15, do not casually install latest Fumadocs variants that force Next 16.

Use Next-15-compatible baseline:
- `fumadocs-core@15.0.0`
- `fumadocs-ui@15.0.0`
- `fumadocs-mdx@14.2.x`

Rules:
- Do NOT upgrade `packages/web` to Next 16 in this task.
- Do NOT adopt incompatible Fumadocs UI/Core versions.
- Any deviation must be justified with passing build/test proof.

---

## 9) Content migration strategy

### Source-to-target approach
Build a migration map from existing docs to new pages:
- source file
- target page
- keep/rewrite/drop decision
- missing gaps to author fresh

### Content rules
1. No copy-paste dumps from source docs.
2. Rewrite for user outcomes and task success.
3. One canonical home per concept.
4. Link advanced/internal docs instead of duplicating internals.

### Required depth standard per major page
Each page must include:
1. Purpose
2. Prerequisites
3. Exact steps/commands
4. Expected result
5. Failure modes + fixes
6. Next steps links

If this 6-part shape is missing, the page is not done.

---

## 10) Implementation architecture (Phase 1 in packages/web)

### Route and layout
- Add docs route tree under `packages/web/src/app/docs`.
- Add docs layout with:
  - top nav
  - left sidebar
  - right TOC on desktop
  - mobile-safe nav

### Integration with dashboard
- Add visible dashboard -> docs entry point.
- Add docs -> dashboard CTA.

### Content source
- Keep one docs content root (recommended `packages/web/content/docs/**`).
- Keep page tree config explicit and portable.

### Portability for future migration
- Keep docs-specific components isolated (e.g. `src/components/docs/*`).
- Avoid dependencies on dashboard runtime internals.
- Keep docs config/content decoupled from app-specific state.

---

## 11) Testing and QA plan

### Minimum automated tests
- docs home render
- representative docs leaf page render
- sidebar/nav path behavior
- mobile render sanity (no crash)

### Manual QA checklist
- Search returns expected pages
- TOC anchors jump correctly
- Code copy works
- Internal links have no dead ends
- Keyboard navigation works
- Mobile readability and nav work
- Contrast/accessibility smoke checks pass

### Validation commands (must run)
- `pnpm --filter @aoagents/ao-web typecheck`
- `pnpm --filter @aoagents/ao-web test`
- plus route smoke run in dev for `/docs`

---

## 12) Risks and mitigations

1) Docs/dashboard coupling becomes messy
- Mitigation: strict module boundaries from day one.

2) Big doc set, weak onboarding flow
- Mitigation: quickstart-first, path-driven docs home.

3) Stale commands/config snippets
- Mitigation: command verification pass before merge.

4) Pretty UI, weak utility
- Mitigation: enforce 6-part depth standard per page.

5) Dependency incompatibility with Fumadocs
- Mitigation: pin compatible versions and verify early.

---

## 13) Definition of done

### User success
- New user understands AO in <5 minutes.
- New user can complete first run from docs alone.

### Content completeness
- All required sitemap pages exist and are fully written.
- Core workflows and troubleshooting are actionable.

### Technical completeness
- Docs route is stable, searchable, navigable.
- No obvious runtime errors on docs pages.
- Typecheck and tests pass.

### Design completeness
- UI looks like AO product family, not a random template.

---

## 14) One-shot coding agent execution brief (copy-paste)

Implement this in one PR. Do not return a planning-only PR.

Build complete user docs in `packages/web` at `/docs` using Fumadocs with:
- docs route + layout + nav + sidebar + toc + search
- AO-aligned theming and typography
- full content for required sitemap pages
- dashboard/docs cross-links
- tests + validation evidence

Hard constraints:
- stay in `packages/web`
- no dashboard regressions
- no placeholders in core docs pages
- keep migration portability to `website/`
- use Next-15-compatible Fumadocs versions

PR must include:
1. implemented routes/components/content structure
2. dependency versions + compatibility reasoning
3. final sitemap
4. source docs used for migration
5. commands run + test results
6. follow-up notes for `website/` migration

---

## 15) Final recommendation

Ship `/docs` in `packages/web` now, with clean boundaries and portable docs modules. Then migrate to `website/` as a controlled second step after content and UX are validated.

This is the fastest path that still preserves long-term architecture quality.