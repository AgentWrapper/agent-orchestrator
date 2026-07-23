# ao browser

Inspect and control the current AO session's target-isolated browser. The desktop app must be open. The agent and user share the same live page, cookies, navigation state, and `WebContentsView`; the runtime remains usable while the Browser panel is hidden.

`AO_SESSION_ID` selects the target, so run these commands from inside an AO worker session.

This is the automation interface for AO's visible desktop Browser panel. Do not use Codex/host in-app browser connectors, `agent.browsers.get("iab")`, or a browser MCP for this panel: those belong to separate browser runtimes and will not discover or update AO's session-owned page.

## Core workflow

```bash
ao browser status
ao browser open http://localhost:5173
ao browser snapshot
ao browser click e1
ao browser fill e2 "hello"
ao browser press Enter
ao browser hover e3
ao browser wait --text "Saved"
ao browser snapshot
ao browser errors
```

Element references such as `e1` are short-lived. After navigation or a substantial DOM replacement, take another snapshot. A stale reference fails explicitly and never falls through to another session or page.

## Commands

```text
ao browser status [--json]
ao browser open <url> [--json]
ao browser snapshot [--interactive] [--json]
ao browser click <ref> [--json]
ao browser fill <ref> <text> [--json]
ao browser type <ref> <text> [--json]
ao browser press <key> [--json]
ao browser hover <ref> [--json]
ao browser scroll <up|down|left|right> [--amount <pixels>] [--json]
ao browser select <ref> <value> [--json]
ao browser check <ref> [--json]
ao browser uncheck <ref> [--json]
ao browser get <property> [ref] [--json]
ao browser wait (--text <text> | --selector <css> | --url <substring> | --ms <milliseconds>) [--timeout <milliseconds>] [--json]
ao browser screenshot [path] [--json]
ao browser console [--json]
ao browser errors [--json]
```

`fill` replaces the current value, while `type` inserts text at the current
cursor position. `press` accepts named keys and chords such as `Enter`,
`ArrowDown`, and `Control+A`. Page-level `get` supports `url`, `title`, and
`text`; with an element ref it supports `text`, `value`, and `checked`.

Without `--json`, `screenshot` writes a PNG and refuses to overwrite an existing file. With `--json`, it returns the structured response including base64 image data.

`ao preview` remains available for the passive URL/static-file workflow. Use `ao browser` when the agent needs to inspect or verify the page.
