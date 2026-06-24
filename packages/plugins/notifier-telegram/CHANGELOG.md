# @aoagents/ao-plugin-notifier-telegram

## 0.1.0

### Minor Changes

- Initial release. Telegram bot notifier with:
  - Outbound notifications (plain text + inline keyboards for choice options / URL actions).
  - Inbound long-poll listener that routes replies and button presses back into sessions via
    `ao send`, recovering the target session from an embedded `ao:session=` tag or callback data.
  - Single-instance listener auto-started by the notifier (opt out with `listen: false`).
