# Artifacts

Artifacts are structured cards an agent can publish to the **right rail** of
the session detail page. They turn the terminal — which is a stream of text —
into a richer surface where the agent can communicate plans, diffs,
explanations, and summaries.

This is the v1 feature. It ships always on; there is no feature flag.

---

## The two types

### 1. `markdown`

Formatted text. No HTML pass-through — the renderer escapes tags. Use this
for plans, summaries, status reports.

```bash
ao artifact publish \
  --type markdown \
  --id plan-v1 \
  --title "Implementation plan" \
  --content "## Steps\n1. Refactor router\n2. Add tests\n3. Update docs"
```

### 2. `html`

HTML rendered inside a **sandboxed iframe** (`sandbox="allow-scripts"`, no
`allow-same-origin` → null-origin → cannot reach auth tokens or call APIs
even if the agent is prompt-injected). Safe to use for diffs, charts,
tables, or any content where you want exact visual control.

```bash
ao artifact publish \
  --type html \
  --id diff-view \
  --title "Pending diff" \
  --content-file ./diff.html
```

The iframe receives a `postMessage("ao:resize", {height})` channel — the
renderer auto-sizes the iframe to its content's height. Pages can opt in by
emitting that message from inside.

---

## Where artifacts live on disk

```
~/.agent-orchestrator/projects/<projectId>/artifacts/<sessionId>/
  .staging/             ← agent writes <id>.json here; watcher ingests
    <id>.error          ← validation errors (sidecar file)
  <id>.json             ← canonical artifacts (after ingest)
```

The CLI writes to `.staging/`. A watcher in the dashboard process picks files
up, validates them against the schema, stamps `version`, `createdAt`,
`updatedAt`, and `source=agent`, then atomically renames into the canonical
slot.

Validation errors land as a `<id>.error` sidecar; `ao artifact publish` polls
for it for up to 2 seconds and surfaces the error.

### Limits

| Limit | Value |
|---|---|
| Max artifacts per session (non-`core-*`) | 32 (oldest evicted) |
| Per-file size cap | 256 KiB |
| Reserved id prefix | `core-` (reserved for future core synthesizers) |

---

## Agent author quick reference

```bash
# Markdown
ao artifact publish --type markdown --id <id> --title <title> --content <text>
ao artifact publish --type markdown --id <id> --title <title> --content-file <path>

# HTML (sandboxed iframe)
ao artifact publish --type html --id <id> --title <title> --content-file <path>

# Or supply the full JSON payload
ao artifact publish --spec-file <path>

# JSON output (for scripting)
ao artifact publish --type markdown --id <id> --title <title> --content <text> --json
```

Inside a managed session, `AO_SESSION_ID` is pre-set so you don't need
`--session`. The same id can be re-published — it replaces the prior artifact
and updates `updatedAt`.

Publish returns within ~50ms when ingest succeeds, or surfaces the
validation issue when it doesn't. Exit code is 0 on success, 1 on failure.

---

## What's NOT in v1

- Interactive artifacts (button responses, free-text input)
- Synthesized artifacts (e.g. auto-generated git diff)
- Cross-session artifact sharing
- Artifact history / version timeline
- Custom artifact types beyond `markdown` / `html`
- Pinning, reordering, deletion from the UI
- Push notifications when an agent publishes an artifact
