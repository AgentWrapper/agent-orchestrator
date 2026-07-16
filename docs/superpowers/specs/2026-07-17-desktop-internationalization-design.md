# Desktop Internationalization Design

Date: 2026-07-17
Status: Approved for implementation

## Goal

Add complete English and Simplified Chinese support to the Electron desktop
application. On first launch the app follows the operating-system language. A
user can later choose System default, English, or Simplified Chinese in Global
settings, and that choice persists across restarts.

The normal desktop build and the separately packaged Remote client use the same
translations and behavior. This work changes presentation only: daemon APIs,
SSE, WebSocket, terminal, storage, session, agent, SCM, and Git behavior remain
unchanged.

## Scope

Translate application-owned user-facing text in:

- React routes, components, dialogs, forms, menus, empty states, status labels,
  tooltips, accessible names, validation messages, and known error states;
- Electron application menus, About and update dialogs, and native folder-picker
  titles;
- desktop notification templates owned by AO;
- relative time, date, count, and plural formatting; and
- stable daemon error codes and notification types for which AO owns the message.

Do not translate product and provider names, repository names, branches, paths,
commands, source code, terminal output, agent-generated content, or GitLab/GitHub
Issue, pull-request, merge-request, review, and comment content. Unknown provider
or daemon messages remain visible in their original form after a localized
application-owned prefix when useful.

The first release supports exactly these effective locales:

- `en` (English); and
- `zh-CN` (Simplified Chinese).

Other operating-system locales fall back to English. Chinese variants beginning
with `zh` resolve to Simplified Chinese for this release.

## Library and Resource Model

Use `i18next` and `react-i18next`. A custom dictionary is rejected because AO
already needs interpolation, plural rules, fallback behavior, React updates, and
locale-aware formatting. Separate compiled applications per language are rejected
because users must be able to switch language at runtime.

Translation resources are TypeScript modules bundled with the application. English
is the canonical key shape. The Simplified Chinese resource must satisfy the same
recursive key structure at compile time, and a test compares flattened key sets to
catch missing or extra entries. Resources are local and never fetched at runtime.

Keys are semantic and grouped by UI surface, for example:

```text
common.actions.save
projects.create.title
settings.language.system
errors.DIRECTORY_PERMISSION_DENIED
notifications.readyToMerge.title
```

Components use `useTranslation`; non-React renderer helpers receive or import the
initialized translator. User-visible enum values are mapped to translation keys
instead of being rendered directly.

## Locale Resolution and Persistence

The persisted preference is one of `system`, `en`, or `zh-CN`. Missing, corrupt,
or unknown values resolve to `system` without failing startup.

Electron main owns locale preference persistence in an atomically written JSON file
under the current AO-owned Electron user-data directory. This keeps all state below
`~/.ao`, works in both local and Remote builds, and lets the main process localize
menus and native dialogs before the renderer is ready. No language value is stored
in SQLite or sent to the daemon.

At startup:

1. main reads the stored preference;
2. `system` resolves from Electron's operating-system locale;
3. main initializes its translator and builds localized menus/dialogs;
4. preload exposes the preference and effective locale to the renderer; and
5. the renderer initializes i18next before the first React render and sets the
   document `lang` attribute.

Changing language in Global settings writes the preference through IPC, changes
the renderer language immediately, updates `document.documentElement.lang`, and
asks main to rebuild localized menus. A failed write leaves the previous language
active and presents a localized error.

The standard and Remote apps intentionally keep separate preferences because their
existing Electron user-data directories are separate. Both initially follow the
same operating-system locale.

## Formatting

Replace English-specific time and plural helpers with locale-aware helpers backed
by `Intl.RelativeTimeFormat`, `Intl.DateTimeFormat`, and i18next count interpolation.
The helpers receive the current effective locale and retain deterministic test hooks
for the current time.

Provider vocabulary remains accurate in both languages: GitHub pull requests and
GitLab merge requests use distinct translated labels. Raw provider identifiers and
URLs are never rewritten.

## Error and Notification Localization

The daemon protocol remains unchanged. Renderer error handling prefers a localized
message keyed by the existing stable API error `code`. If no translation exists,
it falls back to the daemon's redacted message and then a localized generic failure.
It must never interpolate raw credentials or unredacted transport errors.

AO-owned notification types map to localized title/body templates in the renderer
before both the in-app notification center and Electron notification are shown.
External or agent-authored body content is displayed unchanged. Existing notification
DTOs and IPC payloads do not change.

## UI Placement

Global settings gains a Language row with a normal select control:

- System default;
- English; and
- Simplified Chinese.

The current effective language is visible when System default is selected. No
restart is required. Layout dimensions must tolerate both English and Chinese at
the existing desktop minimum size without clipped buttons, overlapping labels, or
horizontal page scrolling.

## Migration Strategy

Add the locale foundation and tests first, then migrate application surfaces in
bounded groups: shell/navigation, projects and sessions, SCM/reviews, settings and
migration, remote connection/directory UI, browser/terminal controls, notifications,
and Electron main-process text. Do not ship or deploy until the migration audit finds
no remaining application-owned English literals outside an explicit allowlist for
brand names, code, protocol values, test fixtures, and external content.

Existing tests default to English to preserve stable selectors while migration is in
progress. Focused Chinese tests verify representative screens, interpolation, plural
behavior, dynamic language switching, and accessible labels.

## Verification

Automated verification covers:

- system locale resolution, explicit override, corrupt preference fallback, atomic
  persistence, and IPC round trips;
- exact English/Chinese translation-key parity;
- immediate renderer switching and Electron menu rebuild;
- English and Chinese relative time, dates, counts, provider labels, error codes,
  and notification templates;
- representative project creation, board, session, settings, SCM connection, Remote
  server, and Remote directory flows in Chinese;
- an audit for untranslated application-owned literals;
- full frontend tests and typecheck; and
- normal and Remote package builds.

Visual verification uses Playwright screenshots at desktop minimum, standard, and
wide viewports in both languages. It checks dialogs, settings, project creation,
board/session layouts, and the Remote directory picker for overflow and overlap.

## Packaging and Deployment

Produce a new separately named Remote application so the installed
`Agent Orchestrator.app` remains untouched. Install the new package locally only
after tests, typecheck, packaging, signature validation, and screenshot checks pass.

The daemon remains on `ubuntu@192.168.2.220`. Presentation-only changes do not require
a daemon protocol migration. Deployment verification reconnects the packaged Remote
client to `192.168.2.220:3011`, confirms the saved connection still works, exercises
Chinese and English switching, and verifies existing REST, SSE, terminal, SCM, and
remote-directory behavior is unchanged.
