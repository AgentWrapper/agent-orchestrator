# Two-way attention system (issue #82)

A rock-solid, two-way attention system so Nick (a) is alerted immediately and
loudly whenever any orchestrator/worker needs him, and (b) can respond
immediately — without polling each session to find what's stuck.

**Ownership:** ops/nickify layer. Per the repo vanilla rule, nothing here
patches ao core. Every component only **reads** ao's public HTTP API
(`GET /api/v1/sessions`) and shells out to the public `ao send` CLI. The diff
is ops-only and touches no sensitive backend path.

## Components

| File                               | Unit                            | Role                                                                                                                                        |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops/attention-core.mjs`           | —                               | Pure logic: attention classification, dedup state machine, alert/digest rendering, `SLACK_MEMBER_ID` resolution, session→attention mapping. |
| `ops/slack-reply-core.mjs`         | —                               | Pure logic: Slack request-signature verification, thread↔session map, reply routing → `ao send` intent.                                     |
| `ops/slack-client.mjs`             | —                               | Thin Slack Web API / webhook sink (`postMessage`, `update`).                                                                                |
| `ops/attention-notifier.mjs`       | `ao-attention-notifier.service` | Outbound engine: poll, alert, digest, heartbeat/self-health.                                                                                |
| `ops/attention-reply-listener.mjs` | `ao-attention-reply.service`    | Inbound Slack Events endpoint → `ao send`.                                                                                                  |
| `ops/what-needs-me.mjs`            | — (CLI)                         | Terminal "what needs me" view.                                                                                                              |
| `ops/install-attention.sh`         | —                               | Nickify/deploy wiring: install units + verify env.                                                                                          |

## 1. Outbound alerts (deduped, complete)

The notifier polls `GET /api/v1/sessions` — the **authoritative current state**
across all projects — rather than only listening for creation events, so a
notifier restart cannot miss an in-flight `needs_input`. Each poll:

1. Maps every session's `activity.state` / `status` to an attention record
   (`waiting_input`/`needs_input` → `needs_input`; `blocked` → `blocked`).
   `ready_to_merge` on a sensitive backend path becomes `parked_sensitive_merge`.
2. `AttentionTracker.reconcile()` drops signatures no longer present (resolved),
   so a later re-entry alerts again; `observe()` alerts **once** per new
   `(project, session, kind)` signature and never re-spams an unchanged state.
3. New attention records are posted with an `<@SLACK_MEMBER_ID>` @mention; the
   posted message's `thread_ts` is bound to the session for the reply path.

## 2. Inbound reply-to-unblock (the missing half)

`ao-attention-reply.service` exposes `POST /slack/events` on loopback:3002 for
the Slack Events API. For each request it:

1. Verifies the Slack `v0=` HMAC signature (`SLACK_SIGNING_SECRET`) with a
   5-minute replay window; rejects forgeries with 401.
2. Answers the `url_verification` handshake.
3. Extracts the message, enforces the Nick-only allow-list (`SLACK_MEMBER_ID`),
   and routes it: a **threaded reply** goes to the session bound to that thread;
   a top-level `send <session> <message>` / `<session>: <message>` targets a
   session explicitly.
4. Delivers via `ao send --session <id> --message <text>`. Failures still
   return 200 so Slack does not retry-storm.

Slack reaches the loopback listener via the same tailnet/ingress boundary that
fronts the web surface (configure the Events API request URL accordingly).

## 3. "What needs me" view

- **Slack:** the notifier maintains one digest message, **edited in place**
  every tick, grouping all pending attention by project with reasons + links,
  and an explicit `✅ Nothing needs you` empty state.
- **Terminal:** `node ops/what-needs-me.mjs` prints the same aggregation for a
  shell, exiting non-zero if the daemon is unreachable.

## 4. Heartbeat / self-health

Silence must never be mistaken for health. The notifier logs a periodic
heartbeat and, after 3 consecutive failed polls, posts a `daemon_unhealthy`
@mention so Nick knows the eyes have gone dark.

## 5. Config lives in the deploy/nickify layer

`ops/install-attention.sh` installs the two units and verifies the env layer
carries `SLACK_MEMBER_ID`, `SLACK_SIGNING_SECRET`, and a Slack sink
(`SLACK_BOT_TOKEN`+`SLACK_CHANNEL` or `SLACK_WEBHOOK_URL`). `ops/deploy.sh`
invokes it whenever `ops/` changes. The notifier reads `SLACK_MEMBER_ID`
natively — the legacy `SLACK_MENTION_USER_ID` alias remains only as a fallback
for un-migrated hosts.

**Division of responsibility with the legacy notifier.** The two-way system
does _not_ replace `ao-slack-notifier.service` — the two run side by side with
disjoint ownership:

- The **attention notifier** (this system) owns **session-derived** attention
  it can poll authoritatively: `needs_input`, `blocked`, `no_signal` /
  dead-orchestrator.
- The **legacy SSE notifier** keeps owning **PR/merge events** that a session
  poll cannot see: `ready_to_merge` (including a parked sensitive merge),
  `pr_merged`, and park notes.

To avoid double-paging, the legacy notifier no longer mentions `needs_input`
(that overlap moved here). `install-attention.sh` therefore leaves the legacy
unit running.

## Delivery-robustness notes

- **Alert delivery is retried.** A signature is only committed as "alerted"
  _after_ a successful Slack post, so a transient Slack failure is retried on
  the next poll rather than silently dropped.
- **Webhook mode doesn't spam.** Without a bot token the digest cannot be
  edited in place, so it is reposted only when its rendered content changes.
- **Replies see late bindings.** The reply listener re-reads the shared state
  file per request and merges in thread→session bindings the notifier persisted
  after the listener started, so a reply to a post-startup alert still routes.

## Env keys

| Key                                 | Used by          | Purpose                                                                  |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `SLACK_MEMBER_ID`                   | notifier + reply | @mention target; inbound allow-list                                      |
| `SLACK_SIGNING_SECRET`              | reply            | inbound request verification                                             |
| `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` | notifier         | `chat.postMessage` / `chat.update` (enables in-place digest + threading) |
| `SLACK_WEBHOOK_URL`                 | notifier         | fallback sink (no threading / in-place edit)                             |
| `AO_PORT`                           | all              | ao daemon port (default 3001)                                            |
| `AO_ATTENTION_REPLY_PORT`           | reply            | inbound listener port (default 3002)                                     |

## Testing

Every decision is covered by fast `node --test` unit tests over the pure cores
and the injectable engines (no live daemon or Slack needed):
`ops/attention-core.test.mjs`, `ops/slack-reply-core.test.mjs`,
`ops/attention-notifier.test.mjs`, `ops/attention-reply-listener.test.mjs`,
`ops/what-needs-me.test.mjs`, `ops/install-attention.test.mjs`. Run all ops
tests with `npm run test:ops`.
