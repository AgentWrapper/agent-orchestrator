#!/usr/bin/env node
// ao-slack-notifier — read-only glue (decision D-b, adoption report).
// Consumes the ao daemon's SSE event stream and posts the operator-relevant
// events to Slack. Reads ao; never modifies it. No workflow logic lives here.
//
// Config (env or /home/orchestrator/agent-orchestrator/.env):
//   SLACK_BOT_TOKEN + SLACK_CHANNEL   -> chat.postMessage   (preferred)
//   SLACK_WEBHOOK_URL                 -> incoming webhook   (fallback)
//   AO_PORT (default 3001)
//
// Events forwarded: needs_input, ready_to_merge, pr_merged, session parks
// (queue park notes surface as notifications), daemon reconnect gaps.

import { readFileSync } from "node:fs";

const ENV_FILE = "/home/orchestrator/agent-orchestrator/.env";
try {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = process.env.AO_PORT || "3001";
const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL;
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;

if (!(TOKEN && CHANNEL) && !WEBHOOK) {
  console.error(
    "ao-slack-notifier: no Slack sink configured. Add SLACK_BOT_TOKEN + SLACK_CHANNEL " +
      "(or SLACK_WEBHOOK_URL) to " + ENV_FILE + " — the app creds alone cannot post.",
  );
  process.exit(1);
}

async function post(text) {
  try {
    if (TOKEN && CHANNEL) {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ channel: CHANNEL, text }),
      });
      const j = await r.json();
      if (!j.ok) console.error("slack error:", j.error);
    } else {
      await fetch(WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    }
  } catch (e) {
    console.error("slack post failed:", e.message);
  }
}

const INTERESTING = new Set(["needs_input", "ready_to_merge", "pr_merged"]);

function describe(ev) {
  const t = ev?.type ?? ev?.event ?? "";
  const n = ev?.notification ?? ev?.payload ?? ev ?? {};
  const kind = n.kind ?? n.type ?? t;
  if (!INTERESTING.has(kind) && !/park/i.test(JSON.stringify(n).slice(0, 400))) return null;
  const sess = n.sessionId ?? n.session ?? "";
  const proj = n.projectId ?? n.project ?? "";
  const title = n.title ?? n.message ?? "";
  const url = n.url ?? n.prUrl ?? "";
  const icon = { needs_input: "🖐️", ready_to_merge: "🟢", pr_merged: "🚀" }[kind] ?? "📌";
  return `${icon} *${kind}* ${proj ? `[${proj}] ` : ""}${sess ? `${sess}: ` : ""}${title} ${url}`.trim();
}

async function run() {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/events`, {
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);
      console.log("connected to ao event stream");
      let buf = "";
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          const msg = describe(ev);
          if (msg) await post(msg);
        }
      }
      throw new Error("stream ended");
    } catch (e) {
      console.error("event stream error, reconnecting in 10s:", e.message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

run();
