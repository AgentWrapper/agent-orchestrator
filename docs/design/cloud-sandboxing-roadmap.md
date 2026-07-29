# Cloud Sandboxing — Roadmap & Design

Status: **Phase 1 shipped (workers + orchestrator + share); Phases 2–4 designed here.**
Branch: `feat/cloud-sandbox-sharing`. Owner: Pritom.

This document covers the design for the next phases of AO cloud sandboxing:

1. **Orchestrator autonomy** (Phase 2 of the orchestrator work)
2. **OAuth (Clerk) + vendor-pays provisioning** (sandboxes on our infra; client just signs in) — *task 2*
3. **Web proxy / multi-device** (thin client layer, any device) — *task 3*

It assumes the Phase 1 baseline described below.

---

## Phase 1 baseline (done)

A cloud session runs a worker (or orchestrator) agent inside a per-session
Daytona sandbox instead of local tmux. It behaves identically to a local session
in the UI (board card, terminal, DB writes, notifications, actions) and adds
durability (survives app/laptop shutdown) and sharing (read-only link).

- **Provisioning** (`backend/internal/cloud/`): `Supervisor.SpawnCloud` creates a
  Daytona sandbox from a pre-baked snapshot (`ao-claude-code-v1`), uploads the
  cross-compiled `ao` linux binary, ports the harness credential (Keychain/file)
  and a GitHub token, clones the project's real git remote, boots a scoped
  `ao daemon` (agent-host mode) inside, and reaches it over a signed preview URL.
  Async: returns in ~1s (`provisioning`), flips to `ready` in ~15–35s.
- **Registry**: JSON file `~/.ao/…/cloud-sessions.json` (sandboxId → sessionId,
  project, harness, status). Restore-after-restart re-attaches live sandboxes.
- **Kind**: `worker` (default) or **`orchestrator`** — the orchestrator agent can
  itself run in a sandbox (Phase 1 orchestrator work).
- **Capability surface**: `POST /api/v1/cloud/sessions` (+ `ao spawn --cloud`).
  The `--cloud` flag is how an orchestrator (or any `ao` caller) spins up a cloud
  session on demand.
- **Auth today**: a single Daytona API key (`DAYTONA_API_KEY`) held by the local
  daemon, sourced from Azure Key Vault at launch. **This is the thing tasks 2 & 3
  replace.**

Key constants: sandbox `autoStopInterval` = Daytona default (15 min idle → stop,
disk preserved), `autoDeleteInterval` = 240 min after stop → delete. Setting
`autoStopInterval: 0` + `autoDeleteInterval: -1` keeps a sandbox up indefinitely
(the natural wiring for a "keep alive" / always-on session).

---

## Phase 2 — Orchestrator autonomy

**Goal:** the orchestrator decides, per task, whether to spin up a cloud sandbox
— rather than a human toggling Local/Cloud.

**Phase 1 gave the mechanism** (`ao spawn --cloud`). Phase 2 gives the
orchestrator the *judgment + permission* to use it:

- **Permission flag**: a project/orchestrator config `orchestrator.cloudWorkers`
  (off by default). When on, the orchestrator's system rules (`OrchestratorRules`)
  are extended to tell it it may spawn cloud workers with `ao spawn --cloud`, and
  when it's appropriate (long-running tasks, tasks that must survive the laptop,
  tasks it wants to hand off/share).
- **Policy hints**: optionally auto-cloud for tasks tagged long-running, or when
  the human is about to disconnect. Start manual (rules-driven), add heuristics
  later.

### The nesting constraint (important)

If the **orchestrator itself runs in a cloud sandbox** (Phase 1 `kind=orchestrator`),
its `ao spawn --cloud` hits the **sandbox's own** agent-host daemon — which has
**no `DAYTONA_API_KEY`** and is harness-scoped. So a cloud orchestrator cannot
provision cloud workers today. Options:

- **A (recommended):** cloud orchestrator's worker spawns are **delegated back to
  the owning (local/control-plane) daemon** that has provisioning rights, via a
  callback channel. The orchestrator sandbox calls "provision me a sibling
  worker" to the control plane, not to its local scoped daemon.
- **B:** give the orchestrator sandbox a **scoped, short-lived provisioning
  token** (not the raw Daytona key) so it can create siblings directly. Ties into
  task 2's per-tenant credential model.

Delegation (A) is cleaner and avoids putting provisioning creds inside a sandbox.
This is the natural convergence point with tasks 2 & 3: once provisioning is a
**control-plane** concern (not "whoever holds the key"), both the local app and a
cloud orchestrator ask the control plane to provision.

---

## Task 2 — OAuth (Clerk) + vendor-pays provisioning

**Goal:** a client signs in (Clerk) and clicks "Cloud" — sandboxes run on **our**
infrastructure, invisible to them, cost baked into pricing. No client ever
supplies a cloud credential. (Earlier draft floated bring-your-own-Daytona; that's
a dev-tool model, wrong for a product we sell — see DECISION below.)

### DECISION (2026-07-27): vendor-pays, NOT bring-your-own-Daytona

We are selling a product, so we do **not** ask clients for a Daytona key or any
cloud credential. Sandboxes run on **our** infrastructure, invisible to the
client (Vercel model: the customer never sees the underlying AWS). Cost is baked
into our pricing. This **removes** the per-tenant credential/vault/"Connect
Daytona" flow entirely — Task 2 shrinks to **identity + isolation + metering**.

So the two concerns become:

1. **User authentication** — who is this tenant? → Clerk (identity only).
2. **Provisioning** — always our single provisioning credential; **isolation +
   quotas + usage-metering per tenant**, not per-tenant credentials.

### Provisioning substrate — our infra, phased

`DaytonaClient` already takes a `baseURL`, so the substrate can change with
little-to-no provisioning-code change:

| Substrate | What | Code change | When |
|---|---|---|---|
| **Our Daytona org** (today) | Control plane holds *our* key; per-tenant isolation via sandbox labels (already set) + quotas/metering | ~none | now |
| **Self-hosted Daytona on our Azure** | Run Daytona's control plane + runners on our Azure subscription; compute billed to our Azure; full control | point `baseURL` at our instance | when cost/scale/control demands |
| **Native Azure provider** (ACI / Container Apps / AKS) | Drop Daytona; implement create/exec/upload/preview behind a provider interface against Azure APIs | large — reimplements signed preview URLs, toolbox exec, snapshots | last resort only |

**Azure:** we have an Azure subscription — the intended path is **self-hosted
Daytona ON Azure** (row 2), near-zero provisioning-code change, compute on our
Azure. A native Azure provider (row 3) is a big rebuild, only if we ever want to
drop the Daytona dependency.

**LICENSING — VERIFIED 2026-07-27 (read the actual LICENSE at tag v0.190.0):**

- **Client SDKs** (`@daytona/sdk`, `@daytona/api-client`, `@daytona/toolbox-api-client`):
  **Apache-2.0.** Our Go `DaytonaClient` (independent REST reimplementation) and
  the whole AO app are unaffected.
- **Daytona SERVER + runner** (`daytonaio/daytona`): **AGPL-3.0** (GNU Affero GPL v3
  — network copyleft). GitHub reports the repo license as `null` because it's
  non-standard placement; the LICENSE file is unambiguously AGPL-3.0.

What this means per substrate row:
- **Row 1 (Daytona's hosted cloud — today + build steps 1–3): NO AGPL concern.**
  We're a paying API client over HTTP; calling an AGPL network service does NOT
  make our code derivative. Build freely.
- **Row 2 (self-host Daytona server on our Azure): AGPL-3.0 applies.** Viable ONLY
  if we run it **unmodified** and comply with §13 (offer users the Corresponding
  Source — trivial when unmodified: point to the public repo). Our product stays
  proprietary because it only talks to Daytona over its API (independent work).
  **If we ever modify the Daytona server/runner, AGPL §13 forces us to publish
  those modifications' source** — avoid, or get Daytona's commercial/enterprise
  license (open-core vendors typically sell one precisely for this).
- **Row 3 (native Azure provider): NO Daytona, NO AGPL** — clean but a big rebuild.

**Verdict:** the current plan (steps 1–3 on Daytona cloud) has **zero** AGPL
exposure — proceed. AGPL only constrains the *later* self-host optimization:
unmodified-only, or a commercial license, else go Row 3. Keep the provider behind
the `DaytonaClient` interface so Row 3 stays a swap, not a rewrite.

### Auth provider (identity only)

| Provider | Pros | Cons |
|---|---|---|
| **Clerk** (chosen) | Fast DX, prebuilt UI, orgs/multi-tenant, JWT, generous free tier | Younger; pricing scales with MAU |
| WorkOS | Enterprise SSO/SCIM first-class | Heavier; enterprise-oriented |
| Auth0 | Mature, ubiquitous | Costlier, more config |
| Supabase Auth | Cheap, OSS, DB-adjacent | Fewer org/enterprise features |

Chosen: **Clerk** — identity + orgs/multi-tenant + JWT. It gives the stable
`tenantId`/`orgId` used to scope + meter provisioning. **Status: design-only, no
code yet** (no account, no SDK, no login built).

### Where the provisioning credential lives

- ONE provisioning credential (ours), held **only** by the hosted control plane
  (Task 3) in a vault (Azure Key Vault / KMS). Never on any client, never in a
  sandbox — same invariant as today's Daytona key.
- `Supervisor.APIKey()` stays a single key, but is resolved **control-plane-side**
  after the client authenticates (Clerk JWT), with per-tenant quota checks — not
  read from a client's env.

### Migration path

1. Keep `DAYTONA_API_KEY` env for single-tenant/dev.
2. Add Clerk identity to the client; control plane authenticates the JWT and
   provisions with our key, tagging sandboxes with the tenant + metering.
3. (Later, when scale demands) move the substrate to self-hosted Daytona on our
   Azure by repointing `baseURL`.

---

## Task 3 — Web proxy / multi-device

**Goal:** a thin client layer so any device (the Electron app today; mobile, web,
another desktop tomorrow) can reach the backend and spin up sandboxes on demand —
without embedding provisioning logic or holding the Daytona key.

### The shift

Today: **local daemon per user**, holds the key, provisions directly, and the
Electron renderer talks to it on loopback. That's single-device by construction.

Target: a **hosted control plane** (the "web proxy") that owns provisioning +
tenant credentials (task 2), and **thin clients** that authenticate (Clerk) and
issue high-level intents ("spawn cloud session", "stream terminal", "share") over
a relay. The heavy lifting (Daytona calls, credential handling, registry) moves
server-side; clients become views.

### Architecture — LOCKED 2026-07-27

**Two layers, don't conflate:**
- **Substrate = Daytona (stays).** Our `DaytonaClient` calls Daytona's *hosted
  cloud* to spin up sandboxes. We are an API client → no AGPL, no dead-OSS issue.
  (Daytona OSS was abandoned June 2026 + is AGPL, so self-hosting Daytona is off
  the table; a *native Azure provider* for sandbox compute is a separate, deferred
  option behind the same `DaytonaClient` interface.)
- **Control plane = ours, hosted on OUR Azure.** The multi-tenant service we
  build. Azure runs *our software*, not the sandboxes.

```
 device (Electron / mobile / web)
    │  authenticated (Clerk JWT)
    ▼
 OUR control plane  ── hosted on OUR Azure ──┐
   • Clerk auth, tenant scoping + metering    │
   • holds the ONE Daytona key (ours)         │
   • cloud-session registry (sqlite→pg)       │
   • relays terminal mux (WS) + REST          │
    │  DaytonaClient (HTTPS, our Bearer key)  │
    ▼                                          │
 Daytona cloud ──► spins up sandboxes (Daytona's infra)
    └── signed preview URLs still used for the sandbox's own daemon
```

Sandbox *compute* still runs on Daytona (billed via our Daytona account). Azure
hosts only the control-plane service (cheap: App Service / Container Apps). Moving
sandbox compute onto Azure later = the deferred native-provider build, same
interface.

- **Relay, not re-implement.** The sandbox already runs a full `ao daemon` reached
  by a signed preview URL. The web proxy's job is: authenticate the device, look
  up the tenant's sandboxes, and **proxy** REST + the terminal WebSocket through to
  the right sandbox — plus own provisioning. This reuses the existing per-session
  daemon; the proxy is a routing + auth + provisioning layer.
- **CORS wall reuse.** We already added `/api/v1/cloud/proxy` (server-side relay to
  a sandbox, dodging the Daytona edge's duplicate-CORS header). That is the
  embryo of the web proxy — generalize it into the hosted relay.
- **Registry moves to a real DB.** The JSON-file registry (fine for single-user
  desktop) becomes a `cloud_sessions` table (sqlite→postgres) keyed by tenant —
  this is the **one place a DB schema change enters** (none needed for Phase 1).

### Device flow

1. Device authenticates with Clerk → JWT.
2. Device calls control plane `GET /sessions` (tenant-scoped) → its cloud sessions.
3. "Spawn cloud" → control plane provisions with the tenant's Daytona key.
4. Terminal → device opens a WS to the control plane, which relays to the
   sandbox's mux (or hands back a scoped signed preview URL for direct connect).
5. Share → control-plane-minted **revocable, scoped** token (this is also model-B
   of the sharing feature — server-enforced instead of the current client-side
   readonly).

### Decisions to make before building

- **Does the local daemon stay?** Likely yes for *local* sessions (tmux on the
  user's machine) — but *cloud* provisioning + registry move to the control plane.
  So a hybrid: local daemon for local sessions, control plane for cloud. Clients
  talk to both (or the daemon proxies to the control plane).
- **Hosting**: where does the control plane run (our infra), and how does it hold
  each tenant's Daytona key securely (KMS)?
- **Transport**: WS relay through the proxy vs. handing clients scoped signed URLs
  for direct sandbox connection (lower proxy load, but exposes the sandbox host to
  the client — mitigated by short TTL + scope).

### Sequencing

Task 3 depends on task 2 (tenant identity + per-tenant creds) and subsumes the
sharing model-B. Suggested order: **task 2 (auth + per-tenant Daytona) → task 3
(control plane + relay + registry-to-DB) → Phase 2 orchestrator autonomy via
control-plane delegation.**

---

## Decisions locked (2026-07-27)

1. **Provisioning = vendor-pays on our infra.** No bring-your-own-Daytona, no
   per-tenant cloud credential. Sandboxes run on our infrastructure (our Daytona
   org now → self-hosted Daytona on our Azure when scale demands). Task 2 = Clerk
   identity + per-tenant isolation/quotas/metering, NOT credential collection.
2. **Hybrid daemon.** The local daemon stays for LOCAL (tmux) sessions on the
   user's machine; only CLOUD provisioning + registry + credential move to the
   hosted control plane. Clients talk to both.
3. **Sharing model-B: parked.** Keep model-A (client-side readonly) for now;
   revisit revocable/scoped tokens later (not folded into task 3 yet).

### Resulting build order

1. **Clerk identity** in the client + a **hosted control plane** that authenticates
   the JWT and provisions with our single key (tenant-tagged + metered).
2. **Registry → DB** (JSON → sqlite/postgres, tenant-scoped) in the control plane —
   the one schema change.
3. **Relay** (generalize `/cloud/proxy`) so any device reaches its cloud sessions.
4. (Later) self-hosted Daytona on Azure via `baseURL` repoint; sharing model-B;
   orchestrator autonomy via control-plane delegation.
