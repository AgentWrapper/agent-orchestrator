# Agent Orchestrator — Technical Architecture

This document explains how the various parts of the Agent Orchestrator communicate with each other: where HTTP is used, where WebSocket is used, and what each carries.

---

## System Overview

```mermaid
graph TB
    subgraph Browser["Browser / Dashboard"]
        UI["React Dashboard\n(Next.js App Router)"]
        XTerm["xterm.js\nTerminal UI"]
    end

    subgraph NextJS["Next.js Server — :3000  (single process)"]
        subgraph HTTPAPI["① HTTP REST  /api/*  — request / response"]
            Sessions["GET /api/sessions\nGET /api/sessions/:id\nPOST /api/sessions/:id/message\nPOST /api/sessions/:id/restore\nPOST /api/sessions/:id/kill\nPOST /api/spawn\nGET /api/projects  GET /api/agents\nGET /api/issues  POST /api/prs/:id/merge\nPOST /api/webhooks/**"]
            Patches["GET /api/sessions/patches\n(lightweight: id, status, activity,\nattentionLevel, lastActivityAt)"]
        end
        SessionMgr["Session Manager\n(reads flat files in\n~/.agent-orchestrator/)"]
    end

    subgraph MuxServer["② WebSocket Server — :14801  (separate Node process)"]
        MuxWS["ws://host:14801/mux\nMultiplexed — two sub-channels\nover one connection"]
        TermMgr["TerminalManager\n(node-pty → tmux PTY)"]
        Broadcaster["SessionBroadcaster\n(setInterval every 3s →\nGET /api/sessions/patches)"]
    end

    subgraph Agents["AI Agents  (one tmux window each)"]
        ClaudeCode["Claude Code"]
        Codex["Codex"]
        Aider["Aider"]
        OpenCode["OpenCode"]
    end

    subgraph External["External Services"]
        GitHub["GitHub API"]
        Linear["Linear API"]
    end

    %% ① HTTP — user actions & data fetching
    UI -- "① HTTP GET/POST\n(on demand: load sessions,\nsend message, spawn, merge PR…)" --> Sessions

    %% ② WebSocket terminal sub-channel
    XTerm -- "② WS sub-channel 'terminal'\nkeystrokes  →  {ch:terminal, type:data}\noutput      ←  {ch:terminal, type:data}" --> MuxWS
    MuxWS --> TermMgr
    TermMgr -- "PTY read/write" --> ClaudeCode
    TermMgr -- "PTY read/write" --> Codex
    TermMgr -- "PTY read/write" --> Aider
    TermMgr -- "PTY read/write" --> OpenCode

    %% ② WebSocket sessions sub-channel
    Broadcaster -- "HTTP GET /api/sessions/patches\nevery 3s" --> Patches
    Patches -- "reads" --> SessionMgr
    Broadcaster -- "② WS sub-channel 'sessions'\n{ch:sessions, type:snapshot,\n sessions:[{id,status,activity,\n  attentionLevel,lastActivityAt}]}" --> MuxWS
    MuxWS -- "session patches\n→ useSessionEvents()\n→ useMuxSessionActivity()" --> UI

    %% Mux auto-recovery calls back to Next.js
    TermMgr -- "① HTTP POST /api/sessions/:id/restore\n(auto-recovery when tmux dies)" --> Sessions

    %% External
    Sessions -- "REST calls" --> GitHub
    Sessions --> Linear
    GitHub -- "POST /api/webhooks/**" --> Sessions
```

---

## Communication Channels

### 1. HTTP / REST — `/api/*` on port 3000

Used for all request-response interactions. The browser calls these on demand; the CLI and the WebSocket server also use them.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List all sessions (with PR / issue metadata) |
| `/api/sessions/light` | GET | Lightweight session list (minimal fields) |
| `/api/sessions/patches` | GET | Ultra-light patches (id, status, activity, attentionLevel) — polled by the WS server every 3s |
| `/api/sessions/:id` | GET | Full session detail |
| `/api/sessions/:id/message` | POST | Send a message/command to a live agent |
| `/api/sessions/:id/restore` | POST | Respawn a terminated session |
| `/api/sessions/:id/kill` | POST | Terminate a running session |
| `/api/sessions/:id/files` | GET | Browse workspace files |
| `/api/sessions/:id/diff/**` | GET | File diff view |
| `/api/sessions/:id/sub-sessions` | GET / POST | List / create sub-sessions (forked agents) |
| `/api/spawn` | POST | Spawn a new agent session |
| `/api/projects` | GET | List configured projects |
| `/api/agents` | GET | List registered agent plugins |
| `/api/issues` | GET | Fetch backlog issues |
| `/api/backlog` | GET | Backlog summary |
| `/api/prs/:id/merge` | POST | Merge a PR |
| `/api/observability` | GET | Health and metrics summary |
| `/api/verify` | POST | Verify environment setup |
| `/api/setup-labels` | POST | Set up GitHub labels |
| `/api/webhooks/**` | POST | Inbound webhooks from GitHub / GitLab |

---

### 2. WebSocket (Multiplexed) — `ws://localhost:14801/mux`

A **bidirectional multiplexed channel** on a separate Node.js process. A single WebSocket connection carries two independent sub-channels:

- **`terminal` channel** — raw PTY I/O for xterm.js
- **`sessions` channel** — real-time session status patches (fed by `SessionBroadcaster` polling `/api/sessions/patches` every 3s)

```mermaid
sequenceDiagram
    participant XTerm as xterm.js
    participant MuxClient as MuxProvider (browser)
    participant MuxWS as WS Server :14801/mux
    participant PTY as node-pty (tmux)
    participant Next as Next.js :3000

    MuxClient->>MuxWS: connect ws://localhost:14801/mux

    Note over MuxClient,MuxWS: Open a terminal
    MuxClient->>MuxWS: {ch:"terminal", id:"sess-1", type:"open"}
    MuxWS->>PTY: attach tmux PTY
    MuxWS-->>MuxClient: {ch:"terminal", id:"sess-1", type:"opened"}

    Note over MuxClient,MuxWS: Terminal I/O
    XTerm->>MuxClient: user keystrokes
    MuxClient->>MuxWS: {ch:"terminal", id:"sess-1", type:"data", data:"ls\r"}
    MuxWS->>PTY: write to PTY
    PTY-->>MuxWS: output bytes
    MuxWS-->>MuxClient: {ch:"terminal", id:"sess-1", type:"data", data:"file1 file2\r\n"}
    MuxClient-->>XTerm: render output

    Note over MuxWS,Next: Session patches (every 3s)
    MuxWS->>Next: GET /api/sessions/patches
    Next-->>MuxWS: [{id, status, activity, attentionLevel, lastActivityAt}]
    MuxWS-->>MuxClient: {ch:"sessions", type:"snapshot", sessions:[...]}
    MuxClient-->>MuxClient: useSessionEvents() + useMuxSessionActivity() update React state

    Note over MuxWS,Next: Auto-recovery (session dead)
    MuxWS->>Next: POST /api/sessions/sess-1/restore
    Next-->>MuxWS: 200 OK
    MuxWS->>PTY: reattach to new tmux session
```

**Message types:**

| Direction | Channel | Type | Payload |
|-----------|---------|------|---------|
| Client→Server | `terminal` | `open` | `{ id }` |
| Client→Server | `terminal` | `data` | `{ id, data: string }` |
| Client→Server | `terminal` | `resize` | `{ id, cols, rows }` |
| Client→Server | `terminal` | `close` | `{ id }` |
| Client→Server | `subscribe` | — | `{ topics: ["sessions"] }` |
| Client→Server | `system` | `ping` | — |
| Server→Client | `terminal` | `opened` | `{ id }` |
| Server→Client | `terminal` | `data` | `{ id, data: string }` |
| Server→Client | `terminal` | `exited` | `{ id, code }` |
| Server→Client | `terminal` | `error` | `{ id, message }` |
| Server→Client | `sessions` | `snapshot` | `{ sessions: SessionPatch[] }` |
| Server→Client | `system` | `pong` | — |

---

## Process Map

```mermaid
graph LR
    subgraph Host
        CLI["ao CLI\n(packages/cli)"]
        Next["Next.js\npackages/web — :3000"]
        MuxSrv["Terminal WS Server\npackages/web/server — :14801"]
    end

    subgraph Storage["Flat-file Storage"]
        Sessions2["~/.agent-orchestrator/\n{hash}-{project}/\n  sessions/{id}  ← key-value\n  worktrees/{id}/\n  archive/{id}_{ts}/"]
    end

    CLI -- "pnpm ao start\nspawns both servers" --> Next
    CLI -- "spawns" --> MuxSrv
    Next -- "reads / writes" --> Sessions2
    MuxSrv -- "GET /api/sessions/patches (every 3s)" --> Next
    MuxSrv -- "POST /api/sessions/:id/restore (recovery)" --> Next
```

The CLI (`ao start`) forks two long-running processes:
- **Next.js** on `:3000` — serves the dashboard and all REST routes
- **Terminal WS server** on `:14801` — handles multiplexed WebSocket + PTY management + session patch polling

Both processes share no in-memory state; coordination happens through flat files in `~/.agent-orchestrator/` and HTTP calls from the WS server to Next.js.

---

## Data Flow Summary

| Scenario | Protocol | Path |
|----------|----------|------|
| Load dashboard | HTTP GET | Browser → `:3000/` (SSR page) |
| List sessions | HTTP GET | Browser → `:3000/api/sessions` |
| Spawn new agent | HTTP POST | Browser → `:3000/api/spawn` |
| Send message to agent | HTTP POST | Browser → `:3000/api/sessions/:id/message` |
| Real-time session status | WebSocket | Browser ← `:14801/mux` `sessions` sub-channel (pushed every 3s) |
| Terminal output / input | WebSocket | Browser ↔ `:14801/mux` `terminal` sub-channel (bidirectional) |
| WS server fetches patches | HTTP GET | `:14801` → `:3000/api/sessions/patches` (every 3s) |
| WS server restores session | HTTP POST | `:14801` → `:3000/api/sessions/:id/restore` |
| GitHub notifies of CI / PR | HTTP POST | GitHub → `:3000/api/webhooks/github` |
| CLI queries sessions | HTTP GET | `ao` CLI → `:3000/api/sessions` |
