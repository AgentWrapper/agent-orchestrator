# Daytona-only — Cloud Agents v5 Plan

**Status:** Plan (supersedes `azure-v4-plan.md` for v1 execution)
**Scope:** Single operator. Run the **entire AO stack inside one Daytona sandbox** — no coordinator, no Azure, no Postgres.

> **v5 collapses v4.** v4 put the `ao` daemon on an Azure VM (the *coordinator*) that drove agents in
> Daytona sandboxes over the SDK. v5 runs **the daemon AND the agent together inside one Daytona
> sandbox** — "AO exactly as it runs on a laptop, except the laptop is a cloud pod." This deletes the
> hardest ~70% of v4: the Daytona runtime adapter (Phase D), the coordinator VM, Caddy, the egress
> proxy, and the "one new wire" activity POST.

---

## Core idea

One Daytona sandbox = one `ao` daemon + N agent sessions (tmux + git worktrees, as on a laptop).
Clients (laptop Electron, mobile browser/app) are thin — they reach the in-pod daemon over HTTP/WS/SSE
through Daytona's preview URL. One daemon, one SQLite, one lifecycle ⇒ **all clients are consistent by
construction** (no sync to build).

```
  laptop Electron ─┐
  mobile browser  ─┼──►  https://3011-<id>.proxy.daytona.work   (Daytona preview proxy = TLS ingress)
  mobile app      ─┘            │
                               ▼
                 ┌─────────── Daytona sandbox (Linux, always-on) ───────────┐
                 │  ao daemon: loopback API 127.0.0.1:3001 (no auth)         │
                 │             + Connect Mobile LAN listener 0.0.0.0:3011    │
                 │               (bearer password; control routes refused)   │
                 │  tmux runtime → codex agent(s) in git worktrees           │
                 │  SQLite + lifecycle under ~/.ao  (persists via stop/start)│
                 └──────────────────────────────────────────────────────────┘
                        agent ── git push ─► GitHub ── poll ─► in-pod SCM observer
```

---

## Key decisions

- **Everything in the pod.** `ao daemon` + codex share one sandbox. No coordinator, no laptop-local execution.
- **Zero new AO adapter code.** Existing tmux runtime + gitworktree workspace work unchanged; `ao hooks`
  activity POST rides the in-pod loopback exactly as designed (no remote transport branch needed).
- **SQLite stays (v1).** No Postgres for now. Persist by `stop` (keeps disk) not `delete`; **never** put the
  DB on a Daytona FUSE volume (block-storage incompatible). All mutable state under one `~/.ao` tree.
  **Persistence is still an open design question** — the stop/start approach is the v1 stopgap; a proper
  durable story (incl. a possible **separate Postgres DB**) is deferred to phase 2 (see Deferred).
- **Free Tier 1 is enough.** Egress whitelist already covers GitHub + `*.openai.com` + `*.anthropic.com`
  + package registries. Tier 3+ only needed to reach *arbitrary* hosts — which this design avoids.
- **`AutoStopInterval: 0` is mandatory.** A running daemon does not count as activity; the default 15-min
  auto-stop would kill it.
- **Multi-client = Daytona preview URL (the proxy) + AO's existing Connect Mobile LAN listener** (binds
  `0.0.0.0:3011` behind a bearer password, refuses loopback-only control routes). Don't build a proxy; both
  halves exist — but the listener must be *enabled* headlessly in the pod (see Phase C, the one code gap).
- **Windows client.** CLI via `irm https://get.daytona.io/windows | iex`; image built server-side (amd64)
  by `daytona snapshot create --dockerfile` — no Docker Desktop, no cross-compile.

---

## The one open risk (spike proves it)

**Why a preview URL at all:** v5 moved the daemon *inside* the pod, but the client (Electron/mobile) stays
outside — and a Daytona pod is network-isolated with no public inbound. v4 didn't need this: its Azure VM
had a public IP + Caddy that served as the front door. Collapsing the coordinator into the pod deleted that
front door, so we need the pod's own ingress. Daytona offers exactly two: a **preview URL** (public,
TLS-terminated reverse proxy to one in-pod port — `https://3011-<id>.proxy.daytona.work`, pointing at the
LAN listener) or **SSH**. The preview URL is the ingress that replaces the Azure VM's public IP.

**The risk:** does Daytona's preview proxy pass the `/mux` WebSocket + the two SSE streams? REST is certain; WS/SSE
through the L7 proxy is unconfirmed. This is the make-or-break for the browser UI. Fallback if it doesn't:
**SSH tunnel** (`daytona ssh` + `-L 3001:localhost:3001`), which carries WS/SSE as raw TCP and preserves
AO's loopback bind (no network-bind change needed).

---

## Phases

**A — Image** (`cloud-agents/daytona/Dockerfile`, done)
Multi-stage: build `ao` from source (baked, amd64, static — CGO-free via `modernc.org/sqlite`); runtime
layer = git + tmux + codex + Node 22; `~/.ao` left to runtime disk. Build → `daytona snapshot create ao-codex`.

**B — In-pod spike (the real v1 milestone)**
1. `daytona create --snapshot ao-codex --name ao --auto-stop 0 --cpu 4 --memory 8192 --disk 10`
   (`create` measures `--memory` in **MB** — so 8192, not 8; `--cpu` is cores, `--disk` is GB. Note
   `snapshot create` measures `--memory` in **GB**, a different unit — easy to mix up.)
2. `daytona ssh ao` → `codex login --device-auth` (approve in browser) *or* pass `OPENAI_API_KEY`
3. **Pod prerequisites (fresh pod has neither):**
   - **git identity** — set `git config --global user.name/user.email`, else agent commits fail. (AO only
     self-sets identity for its own `initial commit`, not for agent commits.)
   - **`GITHUB_TOKEN`** — for clone of private repos + `git push`. Pass at create (`--env`) or configure a
     git credential helper. Public-repo-only spike can skip.
4. `nohup ao daemon >~/.ao/daemon.log 2>&1 &` (headless — **not** `ao start`, which is the Electron app)
5. `ao project add …` → `ao spawn …` → `ao send …` → watch the agent work.
   Proves image + auth + tmux runtime + agent loop, entirely in-pod. No networking yet.

**C — Remote UI**
1. **Enable the LAN listener.** There is **no `--server` flag**. The daemon always binds loopback
   `127.0.0.1:3001` (no auth); the network-facing listener is the **Connect Mobile LAN bind** on
   `0.0.0.0:3011`, which only starts once the bridge is *enabled* (sets a bearer password, persists
   `~/.ao/mobile/config.json`, re-armed on boot). Enabling is a controller action normally triggered from
   the desktop app's Settings → for a headless pod, hit that endpoint directly (curl the enable route on
   loopback from inside the pod) or add a small `ao` CLI/env path to enable it at boot. **This is real work,
   not config — the one code gap Phase C must close.**
2. Expose 3011: `daytona preview-url ao -p 3011` (signed, 1h) → open from laptop browser.
3. **Verify WS `/mux` + SSE work over preview.** If not, fall back to SSH tunnel (`-L 3001:localhost:3001`,
   which reaches the loopback API directly and needs neither the LAN bind nor the bearer password).

**D — Multi-client validation**
Open the same preview URL from laptop **and** phone simultaneously → confirm both see live session state +
terminal, consistent (one daemon, one DB). Handle the preview auth (`x-daytona-preview-token` / signed URL)
and the browser warning-page skip header on the mobile app.

**E — Persistence & lifecycle ops**
`stop` to park (keeps DB + codex login, frees CPU/RAM); `start` to resume; `archive` for zero-cost idle.
Document that `delete` wipes `~/.ao`. Preview URL is stable across stop/start (same sandbox id).

---

## Client changes

The daemon serves **only** the JSON API + WS/SSE — **not** the web UI. The React renderer is bundled
into and served by Electron (`app://renderer` → `dist/`). That split makes the two clients differ:

**Laptop Electron — bounded (this is v4's Phase F): bypass local-daemon assumptions, point at remote.**
- Read remote daemon URL + `AO_AUTH_TOKEN` (env for v1).
- Skip spawning a local daemon when a remote URL is set.
- Relax `daemonIdentityError` so a remote binary isn't rejected as foreign.
- Skip the supervisor link + daemon lifecycle/update management.
- Point renderer at remote base (`setApiBaseUrl` / `VITE_AO_API_BASE_URL` — already runtime-swappable;
  `/mux` + SSE URLs derive from it, so nearly free).
- Set the `ao_conn` cookie for the remote origin (`session.cookies.set`) so WS/SSE auth header-lessly;
  broaden the cookie's route scope server-side.
- CSP + CORS: allow the `https://*.proxy.daytona.work` origin (renderer connects cross-origin now;
  set `AO_ALLOWED_ORIGINS` on the daemon and the CSP `connect-src` on the client).

**Mobile — larger gap, and mostly NOT an Electron change.** A mobile browser hitting the preview URL gets
the API, not a UI (nothing serves HTML/JS). Needs the renderer served over HTTP: either **the daemon
serves the built bundle** (`go:embed dist` + SPA route — backend work) or **host the bundle separately**
pointed at the daemon API. The renderer's `VITE_NO_ELECTRON` web-preview mode is a head start but is
**mock-wired today**, not a live remote daemon. Deferred past v1.

---

## Caveats

- **One pod's ceiling: 4 vCPU / 8 GB / 10 GB disk.** Disk is the first limit (repo + node_modules +
  worktrees). More parallelism → several independent AO pods (no single pane), or revisit a coordinator.
- **Codex on a subscription is single-concurrency** (rotating refresh token shared across agents in one
  `~/.codex`). Use `OPENAI_API_KEY` for parallel sessions.
- **Preview URL is per-sandbox-id** — stable across stop/start, changes on recreate. Stable custom domain =
  optional custom preview proxy later.
- **`ao daemon` binds loopback by default** — the LAN-listener bind (Phase C) is the only AO code touched.
- **Connect Mobile is plaintext HTTP + a bearer *password*** (designed for a trusted home LAN). On the
  public internet it rides Daytona's preview TLS, so the transport is encrypted end-to-end to the proxy —
  but treat the password as the only gate and rotate it if leaked. Real OIDC auth is deferred.
- **Preview warning page** on Tier 1/2: first browser hit shows an interstitial (skip via
  `X-Daytona-Skip-Preview-Warning: true` header, or Tier 3). Easy for the app, one-time click in a browser.
- **codex `login --device-auth` needs device-auth enabled** in the ChatGPT account's security settings, and
  a browser to approve. API-key mode has neither requirement.

## Deferred

**Durable persistence (phase 2, still being designed).** v1 relies on Daytona `stop`/`start` to keep the
SQLite DB on the pod's disk — a stopgap, not a real durability guarantee (a pod delete or loss wipes
`~/.ao`). Phase 2 will implement a proper story, likely a **separate Postgres DB** off the pod (a larger
change: AO's storage is SQLite + goose + sqlc + trigger-based CDC), or off-box SQLite backup as a lighter
alternative. Undecided.

Other deferred: stable custom domain / own proxy, multi-pod fan-out, real email/OIDC auth (bearer token is
the v1 gate), per-agent sandbox isolation (the v4 coordinator model), conversation-history replay, autoscaling.