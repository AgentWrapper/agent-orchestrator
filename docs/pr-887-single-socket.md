# PR #887: Single-Socket Multiplexing

> `feat(web): single-socket — multiplex terminals + sessions over one WebSocket`
> +2,374 / -1,781 lines across 30 files

## What Changed

Replaced **3 separate real-time channels** with **1 multiplexed WebSocket** at `/mux`.

## Before vs After

```mermaid
graph LR
    subgraph "BEFORE: 3 Channels"
        B1[Browser Tab 1] -->|WS :14801/ws?session=A| T1[Terminal Server]
        B2[Browser Tab 2] -->|WS :14801/ws?session=B| T1
        B3[Browser Tab 3] -->|WS :14801/ws?session=C| T1
        B1 -->|SSE /api/events| NX[Next.js :3000]
        B2 -->|SSE /api/events| NX
        B3 -->|SSE /api/events| NX
        DEAD[Legacy ttyd :14800] -.->|unused| NOWHERE[ ]
    end
```

```mermaid
graph LR
    subgraph "AFTER: 1 Mux Socket"
        B1[Browser Tab 1] -->|WS /mux| MUX[Mux Server :14801]
        B2[Browser Tab 2] -->|WS /mux| MUX
        B3[Browser Tab 3] -->|WS /mux| MUX
        MUX -->|1 shared SSE| NX[Next.js :3000]
        MUX -->|node-pty| TERMS[Terminal PTYs]
    end
```

## Mux Protocol Flow

```mermaid
sequenceDiagram
    participant Browser
    participant MuxProvider
    participant MuxServer
    participant NextJS
    participant PTY

    Browser->>MuxProvider: mount (app root)
    MuxProvider->>MuxServer: WS connect /mux

    Note over MuxProvider,MuxServer: All traffic flows over this one socket

    Browser->>MuxProvider: open terminal (session A)
    MuxProvider->>MuxServer: {type: "open", sessionId: "A"}
    MuxServer->>PTY: spawn pty for session A
    PTY-->>MuxServer: output bytes
    MuxServer-->>MuxProvider: {type: "data", sessionId: "A", data: "..."}
    MuxProvider-->>Browser: render in xterm.js

    Browser->>MuxProvider: type in terminal
    MuxProvider->>MuxServer: {type: "data", sessionId: "A", data: "keystrokes"}
    MuxServer->>PTY: write to pty

    Browser->>MuxProvider: resize terminal
    MuxProvider->>MuxServer: {type: "resize", sessionId: "A", cols, rows}
    MuxServer->>PTY: resize pty

    NextJS-->>MuxServer: SSE session patch
    MuxServer-->>MuxProvider: {type: "session-patch", ...}
    MuxProvider-->>Browser: update session state (skip SSE)
```

## Code Structure Change

```mermaid
graph TB
    subgraph "Deleted"
        style Deleted fill:#4a1a1a,stroke:#ff6b6b
        OLD1["terminal-websocket.ts<br/>(-444 lines, legacy ttyd)"]
        OLD2["direct-terminal-ws.ts<br/>(-305 lines, per-session WS)"]
    end

    subgraph "Added"
        style Added fill:#1a3a1a,stroke:#6bff6b
        NEW1["mux-websocket.ts<br/>(+605 lines, mux server)"]
        NEW2["MuxProvider.tsx<br/>(+323 lines, React context)"]
        NEW3["mux-protocol.ts<br/>(+28 lines, shared types)"]
        NEW4["providers.tsx<br/>(+12 lines, app wrapper)"]
        NEW5["api/sessions/patches/route.ts<br/>(+42 lines, patch endpoint)"]
    end

    subgraph "Simplified"
        style Simplified fill:#1a1a3a,stroke:#6b6bff
        MOD1["DirectTerminal.tsx<br/>(63 added / 245 removed)<br/>uses hooks, no WS mgmt"]
        MOD2["useSessionEvents.ts<br/>(136 added / 73 removed)<br/>accepts mux patches"]
    end
```

## Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Single socket per tab | Reduces connections from N+1 to 1 per browser tab |
| MuxProvider at app root | All components share one connection via React context |
| Server-side SSE relay | Mux server subscribes once to Next.js, broadcasts to all clients |
| Manual WS upgrade routing | Works around `ws` library limitation with multiple servers on one port |
| Lazy SSE connection | `SessionBroadcaster` connects on first subscriber, disconnects on last |

## Connection Count: Before vs After

| Scenario (5 terminals open) | Before | After |
|-----------------------------|--------|-------|
| WebSocket connections | 5 (one per terminal) | 1 (mux) |
| SSE connections to Next.js | 1 per browser tab | 1 total (server-side) |
| Ports used | 14800 + 14801 + 3000 | 14801 + 3000 |
