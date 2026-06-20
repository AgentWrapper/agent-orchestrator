import {
  recordActivityEvent,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@aoagents/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig } from "@aoagents/ao-core/utils";
import {
  buildInlineKeyboard,
  buildMessageText,
  extractOptions,
  truncate,
  TELEGRAM_MESSAGE_MAX,
} from "./shared.js";
import { maybeStartListener } from "./listener.js";

export const manifest = {
  name: "telegram",
  slot: "notifier" as const,
  description:
    "Notifier plugin: Telegram bot notifications with inline-keyboard replies + inbound reply listener",
  version: "0.1.0",
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: unknown;
}

/**
 * POST to the Telegram Bot API with retry/backoff. Mirrors the Discord notifier's
 * resilience: transient HTTP failures retry with exponential backoff, and a 429
 * honours `retry_after` without consuming the error-retry budget.
 */
async function callTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  retries: number,
  retryDelayMs: number,
): Promise<void> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
  let lastError: Error | undefined;
  let rateLimitRetries = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Telegram signals app-level errors in the JSON body even on some 200s,
      // and rate limits with HTTP 429 + parameters.retry_after.
      const json = (await response.json().catch(() => ({}))) as TelegramApiResponse;

      if (response.ok && json.ok) return;

      if (response.status === 429 || json.error_code === 429) {
        if (rateLimitRetries < retries) {
          const retryAfter = json.parameters?.retry_after;
          const waitMs = retryAfter ? retryAfter * 1000 : retryDelayMs;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          rateLimitRetries++;
          attempt--;
          continue;
        }
        recordActivityEvent({
          source: "notifier",
          kind: "notifier.rate_limited",
          level: "warn",
          summary: "Telegram Bot API rate-limit retry budget exhausted",
          data: { plugin: "notifier-telegram", method, rateLimitRetries },
        });
        lastError = new Error(`Telegram ${method} rate-limited (429)`);
        throw lastError;
      }

      lastError = new Error(
        `Telegram ${method} failed (${response.status})${json.description ? `: ${json.description}` : ""}`,
      );
      if (!isRetryableHttpStatus(response.status)) throw lastError;
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export function create(config?: Record<string, unknown>): Notifier {
  const botToken = config?.botToken as string | undefined;
  // chatId is required to send; coerce numbers (group ids are negative ints).
  const rawChatId = config?.chatId;
  const chatId =
    typeof rawChatId === "number"
      ? String(rawChatId)
      : typeof rawChatId === "string" && rawChatId.trim()
        ? rawChatId.trim()
        : undefined;

  const { retries, retryDelayMs } = normalizeRetryConfig(config);

  if (!botToken || !chatId) {
    console.warn(
      "[notifier-telegram] Not configured — notifications will be no-ops.\n" +
        "  Set notifiers.telegram.botToken and notifiers.telegram.chatId in your AO config.\n" +
        "  Create a bot with @BotFather (https://t.me/BotFather), then DM it once and read your\n" +
        "  numeric chat id from https://api.telegram.org/bot<token>/getUpdates",
    );
  } else {
    // The notifier lives for the daemon's lifetime, so this is the natural place
    // to bring up the long-poll listener that routes human replies back into
    // sessions. Guarded (single instance via lockfile, skipped under tests).
    maybeStartListener(config);
  }

  async function send(
    event: OrchestratorEvent,
    actions?: NotifyAction[],
  ): Promise<void> {
    if (!botToken || !chatId) return;
    const text = buildMessageText(event);
    const replyMarkup = buildInlineKeyboard(event.sessionId, extractOptions(event), actions);
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await callTelegram(botToken, "sendMessage", body, retries, retryDelayMs);
  }

  return {
    name: "telegram",

    async notify(event: OrchestratorEvent): Promise<void> {
      await send(event);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      await send(event, actions);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!botToken || !chatId) return null;
      await callTelegram(
        botToken,
        "sendMessage",
        {
          chat_id: chatId,
          text: truncate(message, TELEGRAM_MESSAGE_MAX),
          disable_web_page_preview: true,
        },
        retries,
        retryDelayMs,
      );
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
