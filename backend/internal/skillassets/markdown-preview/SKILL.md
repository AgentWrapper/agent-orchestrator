---
name: markdown-preview
description: Render `.md` files and markdown text as styled HTML in the Electron browser panel, including file-watching for live refresh. Use when you want to show the user a rendered README, report, spec, or any markdown output.
trigger: You produce a `.md` file the user should preview, or want to display markdown content in the browser panel.
---

# Markdown Preview Skill

The AO Electron supervisor can render markdown (`--output.format markdown` / `.md` files) as styled HTML in the browser panel (the inspector rail's **Browser** tab). Rendering is done entirely on the main process with a strict CSP (`script-src 'none'`).

## How it works

- **File-based preview:** Any URL ending in `.md` that the user enters in the address bar (or that you open with `ao preview`) is detected by the renderer, fetched, rendered to HTML via `marked` + `DOMPurify`, and displayed.
- **File watching:** When a local `.md` file is opened from the worktree, the daemon watches it via the OS-native file watcher. Editing and saving the file triggers a live re-render in the browser panel (debounced at 300ms).

## Using from a session

1. **Generate a `.md` file** in the session worktree — for example a README, a bug report, a spec, or a summary.
2. **Auto-preview immediately:** After creating the file, run `ao preview <path-to-file>.md` to push it to the browser panel so the user sees it without extra steps.
3. **Multiple files:** If your task produces several `.md` files in one go (e.g., a report per issue), only auto-preview the **last** one — the panel can only show one at a time, and previous targets are immediately replaced.
4. **Live editing:** When the file is local and the user saves edits, the preview auto-refreshes.
5. **File deletion:** If the previewed file is deleted, the browser panel reverts to `index.html` (the default workspace entry point) or clears to blank if none exists — no error page is shown.

## `ao preview`

When running inside an AO session, `ao preview` opens any URL (including `file://` paths to `.md` files) in the browser panel:

```
ao preview path/to/file.md
ao preview https://example.com
```

The markdown preview is a client-side render — the daemon does not store or serve the rendered HTML. It is cached in the Electron main process per preview session.

## Security

- All rendered pages carry `script-src 'none'` — no JavaScript executes.
- HTML is sanitised through DOMPurify with a strict allowlist.
- Output is served from `app://md-preview/<id>`, an Electron custom protocol with no network exposure.
- The protocol handler only serves documents that the MarkdownHost cached; there is no general file serving.
