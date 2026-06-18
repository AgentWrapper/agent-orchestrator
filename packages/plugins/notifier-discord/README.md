# notifier-discord

Discord webhook notifier plugin for AO. Sends rich embed notifications for session events, PR creation, CI status, and escalations.

## Setup

1. In your Discord server: **Server Settings > Integrations > Webhooks > New Webhook**
2. Copy the webhook URL
3. Add to `agent-orchestrator.yaml`:

```yaml
defaults:
  notifiers:
    - desktop
    - discord

notifiers:
  discord:
    plugin: discord
    webhookUrl: https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

## Config options

| Option         | Default              | Description                            |
| -------------- | -------------------- | -------------------------------------- |
| `webhookUrl`   | (required)           | Discord webhook URL                    |
| `username`     | "Agent Orchestrator" | Bot display name                       |
| `avatarUrl`    | (none)               | Bot avatar image URL                   |
| `threadId`     | (none)               | Post to a specific thread              |
| `retries`      | 2                    | Retry attempts on 5xx                  |
| `retryDelayMs` | 1000                 | Base retry delay (exponential backoff) |

## Features

- Rich embeds with color-coded priority (red=urgent, blue=action, yellow=warning, green=info)
- PR links, CI status, and action buttons in embed fields
- Thread support for organizing notifications by project
- Retry with exponential backoff on 5xx responses
