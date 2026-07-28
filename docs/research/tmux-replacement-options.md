# Research: Removing / replacing tmux

**Status:** research brief only (no implementation in this doc)  
**Date:** 2026-07-28  
**Scope:** Agent Orchestrator Go rewrite (`backend/` + Electron terminal surface)  
**Audience:** maintainers deciding short-term “no tmux pain” vs medium-term architecture  

This note is grounded in the current code paths, not the old TypeScript runtime.

---

## Executive summary

- On **macOS/Linux**, every agent/session terminal is a **tmux session**. The daemon shells out to the `tmux` CLI for lifecycle; each UI attach is a fresh **`tmux attach-session`** on a local PTY (`creack/pty` via `ptyexec`).
- On **Windows**, there is **no tmux**. The daemon already owns a **ConPTY pty-host** process with loopback attach, multi-client fan-out, and a scrollback ring — that is the template for a true “no external mux” Unix runtime.
- The pain users feel is mostly **packaging / PATH / binary skew**, not “tmux is a bad multiplexer.” Clean DMG installs fail with `RUNTIME_PREREQUISITE_MISSING`; GUI-launched daemons miss Homebrew `tmux`; dual tmux binaries desync client/server.
- **Short-term (recommended):** land **bundled private tmux fallback** ([#2443](https://github.com/AgentWrapper/agent-orchestrator/issues/2443), open PR [#2488](https://github.com/AgentWrapper/agent-orchestrator/pull/2488)) plus PATH-floor fixes. Keeps architecture; removes install pain.
- **Medium-term (recommended if “no tmux binary at all” is a product goal):** **daemon-owned PTY host on Unix**, porting the Windows conpty host model (`Serve` + ring + multi-client) to `creack/pty`. Same `ports.Runtime` / `Attacher` / `/mux` contracts; drop external mux.
- **Custom React output UI** is a **parallel product surface** for headless/JSONL harnesses, not a drop-in replacement for interactive TUIs (Claude Code, Codex, opencode, goose, shell terminals, mobile xterm). Prefer hybrid (D), not pure C.
- Swapping to zellij/screen/abduco/dtach/wezterm mostly **moves** dependency pain without matching what AO already built around tmux (or Windows ConPTY).

---

## 1. What tmux does today

### Role in the stack

```
Electron / mobile xterm
        │  WebSocket /mux (JSON frames, base64 PTY bytes)
        ▼
daemon terminal.Manager  (per-client attach, size arbitration)
        │  ports.Attacher.Attach
        ▼
runtimeselect → tmux (Darwin/Linux) | conpty (Windows)
        │
        ├─ Create / Destroy / IsAlive / Restart / SendMessage / Interrupt / GetOutput
        └─ Attach → ptyexec.Spawn(`tmux attach-session …`)  [Unix]
                 → loopback dial to pty-host                 [Windows]
```

Documented in `docs/architecture.md` (Terminal Multiplexing), `docs/stack.md` (runtime adapter = tmux CLI / conpty), and `docs/STATUS.md` (mux shipped).

### Lifecycle (hard responsibilities)

| Capability | How tmux implements it | Code anchors |
| --- | --- | --- |
| **Create session** | `tmux new-session -d -s <id> -x 220 -y 50 -c <cwd> <shell> -c <launchCmd>` | `adapters/runtime/tmux/commands.go`, `Create` |
| **Keep-alive after agent exit** | Launch string ends with `; exec "${SHELL:-/bin/sh}" -i` so the **session stays alive** for inspect / manual shell / `Restart` | `buildLaunchCommand` |
| **Restart agent in place** | `respawn-pane -k` on `id:0.0` — preserves handle + attach identity | `Restart`, `RuntimeRestarter` |
| **Destroy** | `kill-session -t =<id>` then **reap pane session trees** (`pkill -s` / `pgrep -s`) so background `&` children release ports | `Destroy`, issue #2523 class |
| **Liveness** | `has-session`; missing → dead; other errors → **probe failed** (must not be treated as death) | `IsAlive`, reaper + LCM rules |
| **Supervised workload** | `display-message #{pane_pid}` + `ps` walk for AO supervisor / relaunched child | `IsSupervisedProcessAlive` |
| **Send / interrupt** | `send-keys -l` chunks + delayed Enter; `C-c` for interrupt | `SendMessage`, `Interrupt` (enter delay mirrors conpty, #2342) |
| **Text output sample** | `capture-pane -p -S -<n>` for activity observer / `GetOutput` | activity observer, session_manager |
| **Attach / scrollback / modes** | Per-client `tmux attach-session`; **tmux owns** screen state, scrollback, alt-screen handshake | `Attach` + `terminal/attachment.go` comments |
| **Multi-viewer sizing** | `window-size largest` so phone secondary cannot shrink desktop | `setWindowSizeLargestArgs` |
| **Embedded UX** | `status off`, `mouse on`, attach with `-u` (UTF-8) and `-T RGB` | create options + `attachCommand` (#2484) |
| **Cwd correctness** | Verify `#{pane_current_path}` with retries; pin tmux CLI `cmd.Dir` to stable dir (#2775) | `verifyPaneWorkingDirectory`, `stableRunDir` |

Session identity: handle ID is the tmux session name derived from AO session id (`^[a-zA-Z0-9_-]+$`). Opaque outside the adapter (`ports.RuntimeHandle`).

### PTY attach model (soft vs hard)

- **Hard dependency (macOS/Linux spawn):** `session_manager.validateRuntimePrerequisites` requires `exec.LookPath("tmux")` or spawn fails with `ports.ErrRuntimePrerequisite` / `RUNTIME_PREREQUISITE_MISSING`.
- **Soft dependency (doctor):** `ao doctor` WARNs if tmux missing; PASS shows path/version when present. Windows reports built-in **conpty** instead.
- **Attach path is not “shared PTY in daemon”:** each `/mux` open → new `ptyexec.Spawn` of `tmux -u -T RGB attach-session -t <id>`. Detach closes that client process; the **session** remains.
- **Why attach-per-client:** terminal layer deliberately has **no** durable byte ring. Fresh attach replays modes + scrollback from the **runtime** (tmux client handshake). See `terminal/attachment.go` header comments.

### Platforms

| Platform | Runtime | External binary |
| --- | --- | --- |
| Darwin / Linux | `tmux.Runtime` | **Required** system (or future bundled) `tmux` |
| Windows | `conpty.Runtime` | **None** — daemon spawns self as `ao pty-host` |

Selection: `adapters/runtime/runtimeselect` (`GOOS != windows` → tmux).

### Persistence semantics (why tmux was chosen)

From `docs/stack.md` and issue discussion on #2443:

- Long-running sessions **outlive daemon restarts** (reconcile re-attaches; reaper probes `has-session`).
- Operators can still inspect a pane after the agent process exits (keep-alive shell).
- Multiple clients (desktop + mobile secondary role) attach without AO re-implementing a full terminal emulator server — **except on Windows**, where AO already did implement that.

---

## 2. Existing abstractions (do not reinvent)

### Ports (`backend/internal/ports/outbound.go`)

| Port / type | Meaning |
| --- | --- |
| `Runtime` | `Create`, `Destroy`, `GetOutput`, `IsAlive` |
| `RuntimeRestarter` | Optional in-place process replace |
| `Attacher` / `Stream` | Open sized ReadWriteCloser + `Resize` |
| `SupervisedProcessInspector` | Optional reaper detail for non-hook agents |
| `RuntimeConfig` | SessionID, WorkspacePath, Argv, Env |

CLI, session manager, lifecycle, reaper, and terminal mux talk to these — **not** to tmux types.

### Union interface used by daemon wiring

`runtimeselect.Runtime` = `ports.Runtime` + `Attacher` + `Interrupt` + `SendMessage` + `GetOutput`. Both tmux and conpty satisfy it at compile time.

### Windows path is already “Option A-shaped”

`adapters/runtime/conpty/`:

- Detached **pty-host** process owns ConPTY + agent argv.
- **B1** binary framing over loopback TCP.
- **Ring** (`MaxOutputLines = 1000`) for scrollback snapshot on connect.
- Multi-client fan-out; size policy **largest attached client** (mirrors tmux `window-size largest`).
- Registry (`ptyregistry`) for restart recovery.
- CLI entry: `ao pty-host` (`internal/cli/ptyhost.go`).

Unix already has half the attach plumbing: `ptyexec` wraps **`github.com/creack/pty`** (listed in `docs/stack.md`). Today it only wraps **attach CLIs**, not the agent itself.

### Terminal mux + Electron

| Layer | Responsibility |
| --- | --- |
| `internal/terminal` | Protocol (open/data/resize/close, primary/secondary role), attachment re-attach policy, shared grid arbitration |
| `httpd` | WebSocket upgrade to terminal manager |
| `useTerminalSession` | Client lifecycle, backoff, resize debounce/reassert |
| `XtermTerminal` | xterm.js + fit/webgl/canvas; **no** knowledge of tmux |
| Shell terminals | Same mux + runtime handles (`POST /api/v1/shell-terminals`); not agent-specific |

**Implication:** a runtime swap that still implements `Attacher` + `IsAlive` needs **no** frontend redesign for the live TUI path. A custom output UI is a **new** surface.

### Agent adapters

~20+ harness plugins under `adapters/agent/*` build **interactive** launch argv (`GetLaunchCommand`). Product line is “terminal-based agents.” Headless/print modes exist for some tools but are not the universal contract; activity is largely **hooks**, not JSONL scraping (`domain/activity` comments).

---

## 3. Options table

Effort: **S** days–1 week · **M** multi-week · **L** multi-month / multi-PR program.  
Risk: impact on shipping sessions, Windows parity, attach fidelity.

| ID | Option | Effort | Keep | Lose / risk | Fit to AO |
| --- | --- | --- | --- | --- | --- |
| **A** | **Daemon-owned PTY** on Unix (`creack/pty` host + stream to xterm via existing `/mux`) — generalize conpty host | **L** (design M if scoped to “conpty-like host on Unix”) | No external mux; same ports; multi-client + ring already designed on Windows; one mental model | Must reimplement: session persist across daemon restart, keep-alive shell, restart-in-place, process reaping, capture-pane equivalent, supervised-process walk, UTF-8/truecolor env, secondary sizing | **Best long-term “no tmux”** if product wants zero mux binary |
| **B1** | **zellij** as session manager | **M–L** | Rich multiplexing | Heavier binary; different CLI; still external dep; mouse/resize/TUI quirks; packaging + version skew **again** | Poor — pain shape unchanged |
| **B2** | **GNU screen** | **M** | Classic detach | Worse UX/API; still PATH dep; less maintained ergonomics | Poor |
| **B3** | **abduco / dtach** | **M** | Simple detach/attach | Weak multi-client/scrollback story vs what AO expects; still external | Weak |
| **B4** | **wezterm** (mux/cli) | **L** | Modern terminal | Huge dep surface; not aligned with headless daemon + Electron xterm | Poor |
| **C** | **Custom React output UI only** (structured events / JSONL) | **L** product | Clean logs, search, tool cards | Breaks interactive TUIs; loses real PTY for shell/reviewer/manual; mobile xterm path; many adapters | **Not** a tmux replacement alone |
| **D** | **Hybrid:** structured UI for headless harnesses; real PTY when TUI/shell needed | **M–L** staged | Keeps TUI agents; reduces need for PTY on some workers | Two surfaces to maintain; adapter matrix for headless vs TUI; migration rules | **Best product direction** after pain is fixed |
| **E** | **Keep tmux + bundle static private fallback** (+ PATH floor) | **S–M** (mostly packaging; PR exists) | Full current behavior; clean install works; system tmux still preferred | Still a mux in the stack; binary provenance/signing; dual-binary skew must stay disciplined | **Best short-term** |

### E — already planned / in flight

| Item | State | Notes |
| --- | --- | --- |
| [#2443](https://github.com/AgentWrapper/agent-orchestrator/issues/2443) Bundle tmux in macOS/Linux installers | **Open**, P1 | Clean install cannot spawn without system tmux |
| [#2488](https://github.com/AgentWrapper/agent-orchestrator/pull/2488) feat: bundle static tmux private fallback | **Open** (CI was red as of research date) | Resolver: `AO_TMUX_BIN` → PATH → `AO_BUNDLED_TMUX` → error; artifact workflow; Electron `extraResource` |
| [#2812](https://github.com/AgentWrapper/agent-orchestrator/issues/2812) / PATH floor | Open / related PRs | Headless/GUI daemon cannot see Homebrew tmux |
| [#1520](https://github.com/AgentWrapper/agent-orchestrator/issues/1520) dual tmux binary skew | Open (legacy symptoms still relevant) | Client/server must be same binary family |
| `docs/daemon-environment.md` | Proposed | GUI launch PATH/credentials → tmux not found |
| ADR for runtime swap | **None** | Only ADR present: LAN listener (`docs/adr/0001-…`) |

Issue #2443 explicitly deprioritizes dropping tmux for in-process PTY because it would sacrifice **persistence across daemon restarts** unless that is rebuilt (i.e. Option A done properly).

---

## 4. Recommendation

### Short-term — stop “tmux pain” without architecture rewrite

1. **Ship bundled private tmux** ([#2443](https://github.com/AgentWrapper/agent-orchestrator/issues/2443) / [#2488](https://github.com/AgentWrapper/agent-orchestrator/pull/2488)): system PATH wins; bundled fallback only when missing; never install into `/usr/local`.
2. **Single resolution helper** shared by spawn gate, runtime, doctor, attach (already the intent of #2488).
3. **PATH floor / login-shell env** for GUI and headless daemon starts (`docs/daemon-environment.md`, #2812 class) so non-bundled tools (`git`, harness CLIs) still resolve.
4. **Do not** start a zellij/screen migration in parallel — cost without strategic upside.

**Success metric:** DMG/AppImage user with empty PATH beyond OS defaults can add a project and spawn; `ao doctor` shows `tmux … via bundled` or `via PATH`.

### Medium-term — if the goal is “no tmux binary in the product”

**Prefer Option A (Unix daemon-owned PTY host), not B.**

Concrete shape that matches this codebase:

1. Extract/generalize the conpty **host engine** (`Serve`, ring, multi-client, largest-wins resize, keep-alive after child exit) behind a platform-neutral `ptyConn` (already abstracted).
2. Implement Unix `ptyConn` with `creack/pty` + process group kill (parity with tmux pane reaping).
3. Persist host identity under `~/.ao` (extend `ptyregistry` patterns) so **daemon restart ≠ session death**.
4. Keep `ports.Runtime` + `/mux` + xterm clients unchanged.
5. Feature-flag runtime selection: `tmux` (default) → `ptyhost` on Darwin/Linux until parity.
6. Only then remove the hard prerequisite and bundled binary.

**Parallel track (Option D slice):** optional structured output panes for harnesses that already emit reliable hooks/JSONL — **additive** beside the terminal pane, never blocking spawn of TUI agents.

### What not to recommend as primary

- Pure **C** (kill PTY, UI only): contradicts “live terminal control” product promise and shell terminals / mobile.
- **B** family: external mux remains; packaging and version skew remain; Windows still special-cased.

---

## 5. If custom output UI (design sketch)

Treat this as **D**, not a full tmux replacement.

### Data sources (today vs needed)

| Source | Exists today | Role in custom UI |
| --- | --- | --- |
| Agent **hooks** (`ao hooks` activity) | Yes — primary activity truth | Timeline of working/idle/needs_input |
| CDC / SSE `GET /api/v1/events` | Yes | Session/PR invalidation, not transcript |
| `Runtime.GetOutput` / `capture-pane` | Yes | Fallback text sample for terminal-idle detectors |
| Harness **stream-json / print** | Partial per adapter | Structured tool calls / tokens if harness supports |
| Full PTY byte stream | Yes via `/mux` | Keep for TUI; optional side channel for “raw” toggle |

Do **not** invent display status from log scraping; keep lifecycle derivation rules.

### Frontend reuse

- **Reuse:** session shell layout, inspector tabs, notification/activity chips, SSE invalidation patterns.
- **Do not force-fit:** `XtermTerminal` / `useTerminalSession` — those assume PTY frames. New component (event list / transcript) with its own API client.
- **Mobile:** still needs PTY path for TUI agents (`packages/mobile` session screen is xterm-based).

### Minimal API (illustrative — not implemented)

- `GET /api/v1/sessions/{id}/transcript?after=seq` — structured events (if/when stored).
- Or SSE channel for transcript deltas (separate from CDC session facts).
- Keep `POST …/send` as today (message → runtime `SendMessage` or harness-native channel).
- Feature flag: `output_surface: "pty" | "structured" | "both"`.

Storage note from `docs/stack.md`: **keep high-volume terminal output out of SQLite**; use files/ring/stream. Structured events should be bounded or externalized.

### Migrating existing tmux sessions

| Case | Approach |
| --- | --- |
| Live tmux-backed sessions | **No automatic conversion** to structured UI; they remain PTY until destroyed |
| New sessions after runtime flag | Created on ptyhost or structured mode only |
| User expectation | Document that “output UI” is new sessions / opted harnesses |
| Dual-run period | `runtimeselect` or config per project/harness |

Attempting to “scrape” tmux capture into a fake structured transcript is low value and high lie-factor.

---

## 6. Do-nots

1. **Do not break Windows ConPTY** or force tmux onto Windows.
2. **Do not treat `ProbeFailed` as session death** (architecture load-bearing rule).
3. **Do not drop multi-client attach** (desktop primary + mobile secondary) or invert size policy so small viewers shrink the shared grid.
4. **Do not remove scrollback/repaint-on-attach** without an equivalent ring/snapshot (Windows already has this; naive single-PTY without host dies on disconnect).
5. **Do not assume all agents are headless** — Claude Code / Codex / opencode / goose / shell terminals need a real TTY.
6. **Do not store derived display status** in SQLite as a side effect of a new UI.
7. **Do not hand-edit** generated OpenAPI/sqlc as part of a runtime experiment without the normal regen path.
8. **Do not kill the global tmux server** as a substitute for session teardown (`ao stop` / server lifecycle bugs like #2104 class are user-hostile).
9. **Do not mix tmux client binary A with server from binary B** — any bundle strategy must pin one family per AO process.
10. **Do not move daemon logic into Electron** — runtime stays in the Go daemon; UI stays thin.
11. **Do not force-delete dirty worktrees** while chasing “simpler” process cleanup.
12. **Do not block reviewer / orchestrator panes** that still need interactive terminals behind a structured-only gate.

---

## 7. Suggested PR / work sequence (future)

| Phase | Work | Depends |
| --- | --- | --- |
| 0 | Land #2488 (bundle) + doctor provenance + smoke on tmux-less PATH | — |
| 0b | PATH floor / shell-env for GUI daemon | #2812 / daemon-environment |
| 1 | Spike: Unix pty-host using conpty `Serve` + creack/pty; feature flag; one harness e2e | Phase 0 optional |
| 2 | Parity: restart, keep-alive, reaping, registry, supervised process, GetOutput | Phase 1 |
| 3 | Default new installs to pty-host; keep tmux as escape hatch | Phase 2 |
| 4 | Optional structured transcript UI for selected harnesses | Independent after hooks quality |
| 5 | Remove bundled tmux / hard dep | Phase 3 + soak time |

---

## 8. Key file map

| Area | Path |
| --- | --- |
| tmux adapter | `backend/internal/adapters/runtime/tmux/` |
| conpty host | `backend/internal/adapters/runtime/conpty/` |
| PTY spawn | `backend/internal/adapters/runtime/ptyexec/` |
| Platform select | `backend/internal/adapters/runtime/runtimeselect/` |
| Ports | `backend/internal/ports/outbound.go` |
| Terminal mux | `backend/internal/terminal/` |
| Spawn prerequisite | `backend/internal/session_manager/manager.go` (`validateRuntimePrerequisites`) |
| Doctor | `backend/internal/cli/doctor.go` |
| Frontend terminal | `frontend/src/renderer/components/XtermTerminal.tsx`, `…/TerminalPane.tsx`, `…/hooks/useTerminalSession.ts` |
| Stack decision | `docs/stack.md` |
| Architecture diagrams | `docs/architecture.md` (Terminal Multiplexing) |

---

## 9. Bottom line

| Horizon | Path |
| --- | --- |
| **Now** | Treat tmux as the Unix session persistence layer; **bundle it** and fix PATH. That is the high-ROI “no tmux pain” move. |
| **Next architecture step** | **Do not** hop to another multiplexer. **Generalize the Windows daemon-owned PTY host to Unix** behind existing ports. |
| **Product UI** | Add structured output as a **hybrid** lane; keep xterm + `/mux` for interactive and shell workloads. |

---

## Appendix A — Pain inventory (tmux-related)

Non-exhaustive issues that motivate packaging vs rewrite:

- Missing prerequisite on clean install — #2443  
- PATH / GUI daemon — #2812, `docs/daemon-environment.md`  
- Dual binary skew — #1520  
- Server cwd poison / pane cwd — #2775 class / #3027  
- send-keys paste/Enter — #2342 / #2105 / #3221  
- Session vs agent alive confusion — #2089  
- Side-effect collisions across AO instances — #2662  
- Stop destroying broader tmux server — #2104  

Many of these **remain relevant** under any external mux (B); several **vanish** if AO owns the PTY host (A) or never shells out to a user-visible mux.

## Appendix B — Vocabulary (match repo docs)

- **Daemon-primary:** lifecycle and runtime live in Go on loopback; Electron is supervisor/UI.  
- **Runtime adapter:** leaf implementing `ports.Runtime` (+ attach extras).  
- **Terminal mux:** WebSocket fan-in for panes; not the process isolation layer.  
- **Handle:** opaque runtime id (tmux session name or conpty session id).  
- **Primary/secondary:** client roles for shared grid size.  
