# Desktop UI localization foundation

**Status:** long-term foundation with eight desktop locales

**Date:** 2026-08-04

**Surfaces:** Electron renderer first; main-process locale persistence for future native chrome

## Decision

AO uses `i18next` with `react-i18next` for desktop display text. English remains the default and source catalog. The supported translations are Simplified Chinese (`zh-CN`), Japanese (`ja`), Korean (`ko`), Spanish (`es`), French (`fr`), German (`de`), and Brazilian Portuguese (`pt-BR`).

| Concern | Decision |
| --- | --- |
| Runtime | `i18next` + `react-i18next` |
| React integration | One `I18nextProvider`; components use `useTranslation()` |
| Locales | `en`, `zh-CN`, `ja`, `ko`, `es`, `fr`, `de`, and `pt-BR` |
| Default | `en`; do not infer the OS language on first launch |
| Persistence | Main-process `~/.ao/ui-settings.json` through preload IPC |
| Fallback | Selected locale → English → key identifier |
| Interpolation | Standard i18next `{{name}}` syntax |
| Plurals | i18next/CLDR locale-required categories with `count` |
| Document metadata | Update both `<html lang>` and `<html dir>` on load and switch |

This supersedes the earlier first-party `t()` proposal. A standard runtime is the final architecture because localization is intended to grow beyond a two-locale experiment. It provides established fallback, interpolation, plural selection, React subscriptions, and future locale support without growing equivalent framework code in AO.

PR #2503 explored the same library direction. PR #3465 established the durable `~/.ao` persistence boundary, settings UI, aligned English/Chinese catalogs, and broad renderer migration. PR #3541 expanded that foundation to the eight supported locales.

## Architecture

- `frontend/src/renderer/i18n/instance.ts` creates the configured i18next instance with English available synchronously and registers selected translations on demand.
- `frontend/src/renderer/i18n/messages.ts` owns the typed English source catalog and the single dynamic-loader registry for every translated catalog.
- `frontend/src/shared/ui-locale.ts` is the canonical ordered locale and language-label registry shared by the main, preload, and renderer boundaries.
- `frontend/src/renderer/i18n/i18next.d.ts` derives typed translation keys from the English source catalog.
- `frontend/src/renderer/main.tsx` provides that instance to React.
- `frontend/src/renderer/stores/locale-store.ts` owns only persisted locale loading and selection. i18next owns translation state and React subscriptions.
- Pure presentation helpers use the configured i18next instance. Callers whose memoized output contains translated text pass the reactive `t` function explicitly.
- `frontend/src/main/ui-settings.ts` reads and atomically writes the selected locale beneath the AO data directory; preload exposes only the typed get/set bridge.

English is bundled in the initial renderer graph. Every translated catalog is emitted as a separate lazy chunk and loaded before the persisted locale is rendered or a newly selected locale is saved. This keeps seven unused full catalogs out of the startup chunk while preserving the no-flash startup behavior.

## Key conventions

- Use semantic, surface-oriented keys such as `settings.project.saveChanges`, not English sentences as identifiers.
- Keep user, repository, branch, PR, daemon payload, and terminal content as data; translate only surrounding UI chrome.
- Keep every catalog aligned with the non-empty English key set. The only permitted extra keys are CLDR plural categories required by that locale.
- Use interpolation for runtime values: `"shell.updatedAt": "Updated {{time}}"`.
- Use plural families and pass `count`: `pr.noun.file_one`, `pr.noun.file_other`, then `t("pr.noun.file", { count })`.
- Do not branch on locale in components and do not reconstruct English nouns in JSX.

## Delivered coverage

The desktop migration covers high-visibility chrome, including:

- Settings, language selection, project settings, update controls, and keyboard shortcuts
- Board lanes and empty states, sidebar, topbar, titlebar, notifications, and dialogs
- New Task and Create Project flows
- Session inspector, PR/CI/review presentation, compact relative time, and terminal chrome
- Connect Mobile setup and browser-panel controls
- Command palette actions, headings, states, and footer help
- Session files and diffs, migration, restore/replacement failures, terminal tabs, and reusable dialog/sidebar chrome

English remains the source of truth. The language selector persists through the main process, changes visible React text without restart, and updates the document language and direction.

## Scope boundaries

The desktop renderer's application chrome is extracted in this change. A CI test walks renderer TSX and rejects new hardcoded English JSX text and accessibility attributes. Its narrow allowlist contains only product names, keyboard chords, technical units/commands, example repository values, and the simulated external page shown by the browser-preview fixture.

Separate product work:

- Native main-process menus and operating-system dialogs
- Formatting known daemon notification/error types at the display layer
- Mobile, the landing site, long-form documentation, and CLI localization

Always leave agent terminal I/O, PR titles/bodies, branch names, paths, repository content, and unknown daemon/provider messages unchanged.

## Verification

- i18next unit tests cover English defaulting, on-demand catalog loading, every supported locale, English fallback, missing-key behavior, standard interpolation, exact catalog/placeholder parity, and required CLDR plural families.
- Locale-store tests cover persisted loading, a regional locale switch, catalog loading, `lang`, `dir`, single-flight initialization, stale-read protection, and IPC failure behavior.
- Component tests cover a live regional-locale switch, persistence failures, localized accessibility labels, and localized PR plural output.
- README parity tests keep translated code blocks, operational links, heading structure, and localized download actions synchronized with English.
- The renderer coverage test prevents newly hardcoded English JSX chrome from bypassing the catalogs.
- Command-palette tests require an explicit reactive translator so memoized commands cannot remain in the previous language.
- Frontend typecheck, the complete Vitest suite, and all Electron/Vite builds must pass before merge.
