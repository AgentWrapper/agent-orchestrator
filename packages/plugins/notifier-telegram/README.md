# @aoagents/ao-plugin-notifier-telegram

Telegram notifier for Agent Orchestrator — **two-way**:

- **Outbound** — pushes attention events (needs-input, stuck, CI failing, merge ready, …)
  to a Telegram chat via a bot, with an inline keyboard when an event carries choice options.
- **Inbound** — a long-poll listener routes your **replies** and **button presses** straight
  back into the right agent session via `ao send`. This is what AO has never had: answer an
  agent from your phone.

## How replies find their session

AO has no inbound channel, so the notifier embeds the session id in every message as a tag
(`ao:session=mae-10`). Telegram echoes the original text back when you **reply**, and a button
press carries the session in its `callback_data`. The listener recovers the session from either
— no shared state between the two processes.

> Reply to the **specific** message you want to answer (Telegram's reply/swipe), so the listener
> knows which session you mean.

## Setup

1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **bot token**.
2. Get your **chat id**: DM your new bot once (say "hi"), then open
   `https://api.telegram.org/bot<token>/getUpdates` and read `result[].message.chat.id`
   (a positive number for a DM, a negative one for a group).
3. Configure AO (`~/.agent-orchestrator/config.yaml`):

   ```yaml
   notifiers:
     telegram:
       botToken: "123456:ABC-DEF…"
       chatId: "987654321"
   notificationRouting:
     urgent: [telegram]
     action: [telegram]
   ```

   `notificationRouting` decides which events reach Telegram. Without an entry the notifier is
   registered but never dispatched (`defaults.notifiers` / routing take precedence).

Config keys: `botToken` (required), `chatId` (required), `listen` (default `true` — auto-start
the inbound listener), `enable` (default `true`).

## Inbound listener

The listener auto-starts as a detached child of the daemon when the notifier is created. To run
it standalone:

```bash
ao-telegram-listen        # reads ~/.agent-orchestrator/config.yaml (or $AO_CONFIG_PATH)
```

It is single-instance (lockfile `~/.agent-orchestrator/telegram-listener.pid`) and resolves `ao`
from `$AO_NODE`+`$AO_CLI` (bundled engine) or from `PATH`.

## Native front-ends (Maestro)

Native apps launch the daemon with `AO_DISABLE_NOTIFIERS=1` to own notifications themselves. To
run **only** Telegram in that daemon (so outbound + the inbound listener work, while desktop
notifications stay native), launch it with an allow-list:

```bash
AO_DISABLE_NOTIFIERS=1 AO_NOTIFIERS_ALLOW=telegram ao daemon
```

`AO_NOTIFIERS_ALLOW` (comma-separated manifest names) registers only the named notifiers and
overrides the disable flag for them.
