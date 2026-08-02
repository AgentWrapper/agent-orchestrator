# Chinese UI i18n — decision & plan

**Status:** architecture + thin skeleton (this draft PR)  
**Date:** 2026-08-03  
**Surfaces:** desktop Electron renderer first; main-process locale file for future native chrome

Synthesizes prior analysis from architecture, no-library verdict, and scope/impact notes.

---

## Decision

| Question | Answer |
|----------|--------|
| Skip a traditional i18n **library**? | **Yes** — no i18next / Lingui / FormatJS / Paraglide |
| Skip i18n **architecture**? | **No** — catalogs, keys, `t()`, EN fallback, switch, persistence are required |
| Default locale | **`en`** (never auto-force OS Chinese on first launch) |
| Locales v1 | `en` \| `zh-CN` only |
| Persistence | Main-process `~/.ao/ui-settings.json` + IPC (mirror update-settings / keybindings) |
| Storage shape | `{ "locale": "en" \| "zh-CN" }` — unknown/corrupt → `en` |
| Fallback | Missing zh key → English catalog → key id as last resort |
| Component rule | Call `t(key)`; **no Chinese literals** in components |

### Why first-party `t()` (not a library)

1. **Two locales**, desktop chrome scale (~300–500 strings), sparse plurals — framework features unused day one.
2. **Matches AO style:** thin Zustand stores, atomic JSON under `~/.ao`, explicit IPC bridges; zero new dep surface in Electron packaging/review.
3. **English as source catalog** makes fallback trivial: `zh[key] ?? en[key] ?? key`.
4. **Easy PR slicing:** skeleton + proof settings strings first; full extraction later without rewriting call sites if keys stay stable.
5. **Exit hatch:** if catalogs grow, rich text, third locale, or translator tooling appears, swap the resolver (e.g. FormatJS/i18next) without redrafting every component.

**Reject:** dual component trees, in-component `locale === 'zh' ? '…' : '…'`, CSS content hacks, OS-locale-only, runtime LLM translation, English-replacement-only.

---

## This PR (Phase 0) — skeleton only

| Piece | Location |
|-------|----------|
| Catalogs + typed keys + `t()` + `{var}` interpolation | `frontend/src/renderer/i18n/` |
| Persist locale under state dir | `frontend/src/main/ui-settings.ts` → `ui-settings.json` |
| IPC + preload types | `uiSettings:get` / `uiSettings:set` |
| Renderer locale store + `document.documentElement.lang` | `locale-store` |
| Language control next to Theme | `GeneralSettingsSection` |
| Proof + expanded migration | Settings + presentation maps + shell chrome + notifications chrome + inspector tabs + New Task/Confirm |
| Tests | `t()` fallback; presentation maps; settings switch; default `en` keeps English assertions green |

**Landed in this PR (beyond skeleton):** session status/activity/zone labels, PR display chrome, relative time, daemon failure copy, board columns/empty states, sidebar, topbar/titlebar, notification center chrome, updates/developer/project settings labels, keyboard shortcut labels, New Task dialog, Confirm cancel/close.

**Still English (intentional / follow-up):** agent terminal I/O, PR titles/bodies, daemon notify payloads, Create Project flow copy, many inspector detail section titles (Overview/Activity/Completion row labels), Connect Mobile setup, landing/mobile/CLI, brand “Agent Orchestrator”.

---

## Scope boundaries (desktop Chinese UI track)

### In scope (later phases)

- Renderer chrome: sidebar, board, inspector, dialogs, empty states, command palette, settings
- Presentation maps (`session-presentation`, `pr-display`, `format-time`, shortcut catalog labels)
- a11y labels for icon buttons
- Main-process menus/dialogs (phase with same catalogs)
- In-app notification **chrome** (filters, empty states) — not daemon payload bodies

### Out of scope by design

| Surface | Reason |
|---------|--------|
| Agent terminal I/O | Agent/tooling language |
| PR titles, branches, review bodies | User/SCM content |
| Daemon API errors / notify title-body written in Go | Domain English; prefer display-layer reformat later |
| CLI (`ao`) | Separate UX |
| `packages/mobile` | Separate app; no shared catalog yet |
| Landing / docs sites | Marketing/docs, not desktop shell |
| Brand “Agent Orchestrator” | Keep English unless product renames |

---

## Persistence & boot

1. Main reads `ui-settings.json` from the AO state dir (same root as `update-settings.json` / `keybindings.json`, under `~/.ao` or `AO_DATA_DIR`).
2. Preload exposes `ao.uiSettings.get/set`.
3. Renderer `locale-store` loads on root mount (like keybindings); default in-memory/`t()` path is `en` so CI stays green before load completes.
4. On set: write file → update store → set `document.documentElement.lang`.
5. Do **not** put locale in `app-state.json` (CLI/install marker) or localStorage-only (main would never see it).

---

## Phased follow-ups

| Phase | Work | Size |
|-------|------|------|
| **0 (this PR)** | Architecture + skeleton + settings proof strings | S |
| **1** | High-leverage maps: session-presentation, pr-display, format-time, shortcuts labels, command-palette groups | M |
| **2** | Settings remaining + dialogs + shell chrome (sidebar, titlebar, empty states) | M–L |
| **3** | Main menus / auto-updater dialogs / import-folder errors | M |
| **4** | Notification display-layer (format known types in UI; leave DB English) | M, separate PR |
| Later | Mobile shared catalogs; landing/docs if product wants | — |

### Test strategy (all phases)

- **Default locale remains `en`** in unit/e2e CI — do not flip global suite to Chinese.
- Cover zh with: `t()` unit tests, settings persistence, optional smoke for one Chinese label.
- Budget `data-testid` where English accessible names were the only handle when mass-migrating.

### Upgrade triggers (revisit a real library when 2+ apply)

Third locale; rich nested markup in translations; external translators/TMS; custom layer grows past ~200–300 LOC of framework-like code; heavy plural/select product copy.

---

## Open product questions (not blocking skeleton)

1. First-run OS Chinese auto-detect vs explicit-only (skeleton: explicit-only, default `en`)?
2. Status jargon: fully translate “CI failed” / “Draft PR” or keep English tokens?
3. Brand string: keep untranslated?
4. macOS system menus: invest in custom labels vs OS roles + English custom items initially?

---

## Bottom line

Skip the **library**; do not skip the **architecture**. Ship a minimal first-party dictionary layer that matches AO’s Electron/`~/.ao` settings patterns, keep English default and complete, and migrate strings incrementally.
