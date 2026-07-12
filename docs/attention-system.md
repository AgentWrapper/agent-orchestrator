# Two-way attention system (issue #82)

A rock-solid, two-way attention system so Nick (a) is alerted immediately and
loudly whenever any orchestrator/worker needs him, and (b) can respond
immediately — without polling each session to find what's stuck.

**Ownership:** ops/nickify layer. Per the repo vanilla rule, nothing here
patches ao core. Every component only **reads** ao's public HTTP API
(`GET /api/v1/sessions`) and shells out to the public `ao send` CLI. The diff
is ops-only and touches no sensitive backend path.

## Components

| File                               | Unit                         | Role                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops/attention-core.mjs`           | —                            | Pure logic: attention classification, dedup state machine, alert/digest rendering, `SLACK_MEMBER_ID` resolution, session→attention mapping.                                                                         |
| `ops/agent-health-core.mjs`        | —                            | Pure logic used by the Slack notifier for agent-harness health checks and recovery alerts.                                                                                                                          |
| `ops/slack-reply-core.mjs`         | —                            | Pure logic: Slack request-signature verification, thread↔session map, reply routing → `ao send` intent.                                                                                                             |
| `ops/ao-slack-notifier.mjs`        | `ao-slack-notifier.service`  | Single outbound engine: catches up unread daemon notifications, follows `/notifications/stream`, polls `/sessions` for blocked/no-signal/dead-orchestrator coverage, posts the Slack digest, and self-health pages. |
| `ops/attention-reply-listener.mjs` | `ao-attention-reply.service` | Inbound Slack Events endpoint → `ao send`.                                                                                                                                                                          |
| `ops/what-needs-me.mjs`            | — (CLI)                      | Terminal "what needs me" view.                                                                                                                                                                                      |
| `ops/install-attention.sh`         | —                            | Nickify/deploy wiring: install units + verify env.                                                                                                                                                                  |

## 1. Outbound alerts (single-notifier topology)

Current deploys run `ao-slack-notifier.service` as the only outbound Slack
notifier. It reads the daemon's durable notification API, performs replay-safe
catch-up of unread notifications, follows `/api/v1/notifications/stream`, polls
`/api/v1/sessions` for current blocked/no-signal/dead-orchestrator state, and
alerts through the configured Slack sink. This avoids double-paging while still
letting ao core remain the source of notification truth.

The former `ao-attention-notifier.service` session-poll engine has been deleted.
`ops/install-attention.sh` and `ops/deploy.sh` still disable its historical unit
and remove its state on upgraded hosts; the reply listener remains live.
The retired engine's urgency coverage now lives inside the single notifier. The
notifier polls `GET /api/v1/sessions` — the **authoritative current state**
across all projects — so it can page on states that are not first-class daemon
notifications today. `needs_input` remains owned by the durable notification
stream and appears in the digest; the poll path does not send a second
`needs_input` @mention. Each poll:

1. Maps every session's `activity.state` / `status` to an attention record.
   Poll-path @mentions are limited to `blocked`, worker `no_signal`, and
   `orchestrator_dead`; `needs_input` is digest-only here because the
   notification stream already pages it.
2. `AttentionTracker.reconcile()` drops signatures no longer present (resolved),
   so a later re-entry alerts again; `isOpen()`/`markOpen()` alert **once** per
   new `(project, session, kind)` signature after Slack delivery succeeds and
   never re-spam an unchanged state.
3. New attention records are posted with an `<@SLACK_MEMBER_ID>` @mention.
   The session-attention tracker and digest key persist in
   `AO_SLACK_NOTIFIER_STATE`, not the retired `~/.ao/attention-state.json`.

## 2. Inbound reply-to-unblock (the missing half)

`ao-attention-reply.service` exposes `POST /slack/events` on loopback:3002 for
the Slack Events API. For each request it:

1. Verifies the Slack `v0=` HMAC signature (`SLACK_SIGNING_SECRET`) with a
   5-minute replay window; rejects forgeries with 401.
2. Answers the `url_verification` handshake.
3. Extracts the message, enforces the Nick-only allow-list (`SLACK_MEMBER_ID`),
   and routes it. In the current single-notifier deployment, the reliable path
   is a top-level `send <session> <message>` / `<session>: <message>` command.
   Threaded replies are still supported by the listener when a thread→session
   binding already exists in the legacy attention-notifier state file, but
   `ao-slack-notifier.service` does not create new thread bindings.
4. Delivers via `ao send --session <id> --message <text>`. Failures still
   return 200 so Slack does not retry-storm.

Slack reaches the loopback listener via the same tailnet/ingress boundary that
fronts the web surface (configure the Events API request URL accordingly).

## 3. "What needs me" view

- **Slack:** `ao-slack-notifier.service` posts operator-relevant notification
  events, with replay-safe unread catch-up after restarts. It also posts a
  "what needs me" digest when the current session-derived attention set
  changes. With `SLACK_BOT_TOKEN` + `SLACK_CHANNEL`, the digest is updated in
  place; with webhook-only delivery, it is reposted when the content changes.
- **Terminal:** `node ops/what-needs-me.mjs` prints the current session-derived
  attention aggregation for a shell, exiting non-zero if the daemon is
  unreachable.

## 4. Heartbeat / self-health

Silence must never be mistaken for health. The outbound Slack notifier logs a
periodic heartbeat, @mentions on notification-stream/API health failures so
Nick knows alerts may be delayed until catch-up succeeds, and runs the
`AgentHealthNotifier` check for harness-level failures such as expired auth or
missing binaries.

## 5. Config lives in the deploy/nickify layer

`ops/install-attention.sh` installs and restarts the reply listener, verifies
the env layer carries `SLACK_MEMBER_ID`, `SLACK_SIGNING_SECRET`, and a Slack
sink (`SLACK_BOT_TOKEN`+`SLACK_CHANNEL` or `SLACK_WEBHOOK_URL`), and disables
any leftover `ao-attention-notifier.service` and removes the retired state file
(`AO_ATTENTION_LEGACY_STATE`, then `AO_ATTENTION_STATE`, then
`~/.ao/attention-state.json`) so frozen legacy attention records do not appear
live. `ops/deploy.sh` invokes that installer whenever `ops/` changes and
restarts `ao-slack-notifier.service` as the single outbound notifier. The
notifier reads `SLACK_MEMBER_ID` natively — the legacy `SLACK_MENTION_USER_ID`
alias remains only as a fallback for un-migrated hosts.

## Delivery-robustness notes

- **Alert delivery is retried.** A signature is only committed as "alerted"
  _after_ a successful Slack post, so a transient Slack failure is retried on
  the next poll rather than silently dropped.
- **Webhook mode is supported.** Without a bot token, alerts and digest updates
  use the incoming webhook sink instead of `chat.postMessage`; the digest is
  reposted only when its content changes.
- **Replies use explicit send syntax in the live topology.** New
  `ao-slack-notifier` messages do not add thread bindings, and install/deploy
  cleanup removes the retired state file. Explicit `send <session> <message>`
  / `<session>: <message>` is the supported reply path.
- **Empty attention clears are confirmed.** The session poller waits for two
  consecutive valid empty `/sessions?active=true` results before rewriting the
  digest to "Nothing needs you", avoiding transient all-clear flicker.

## Env keys

| Key                                 | Used by          | Purpose                                                                  |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `SLACK_MEMBER_ID`                   | notifier + reply | @mention target; inbound allow-list                                      |
| `SLACK_SIGNING_SECRET`              | reply            | inbound request verification                                             |
| `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` | notifier         | Slack Web API posting via `chat.postMessage`                             |
| `SLACK_WEBHOOK_URL`                 | notifier         | fallback incoming-webhook sink                                           |
| `AO_PORT`                           | all              | ao daemon port (default 3001)                                            |
| `AO_SESSION_ATTENTION_POLL_MS`      | notifier         | session attention poll period; `0` disables; positive values floor at 1s |
| `AO_SLACK_NOTIFIER_STATE`           | notifier         | notifier dedup, attention tracker, and digest cursor state file          |
| `AO_ATTENTION_REPLY_PORT`           | reply            | inbound listener port (default 3002)                                     |
| `AO_ATTENTION_STATE`                | cleanup          | legacy retired attention state path                                      |
| `AO_ATTENTION_LEGACY_STATE`         | cleanup          | cleanup-specific override for the retired attention state path           |

## Testing

Every decision is covered by fast `node --test` unit tests over the pure cores
and the injectable engines (no live daemon or Slack needed):
`ops/attention-core.test.mjs`, `ops/ao-slack-notifier.test.mjs`,
`ops/agent-health-core.test.mjs`, `ops/slack-reply-core.test.mjs`,
`ops/attention-reply-listener.test.mjs`,
`ops/env-file.test.mjs`, `ops/legacy-attention-state.test.mjs`,
`ops/what-needs-me.test.mjs`, `ops/install-attention.test.mjs`, and
`ops/deploy.test.mjs`. Run all ops tests with `npm run test:ops`.
