import chalk from "chalk";
import type { Command } from "commander";
import {
  queryActivityEvents,
  searchActivityEvents,
  getActivityEventStats,
  droppedEventCount,
  isActivityEventsFtsEnabled,
  type ActivityEvent,
  type ActivityEventLevel,
  type ActivityEventKind,
} from "@aoagents/ao-core";

interface JsonEnvelope {
  version: number;
  query: Record<string, unknown>;
  meta: {
    resultCount: number;
    droppedEventCount: number;
    ftsEnabled: boolean;
    fallbackUsed: boolean;
    ts: string;
  };
  events: Record<string, unknown>[];
}

function toJsonOutput(ev: ActivityEvent): Record<string, unknown> {
  let data: unknown = ev.data;
  if (typeof ev.data === "string") {
    try {
      data = JSON.parse(ev.data);
    } catch {
      // leave as raw string if not valid JSON
    }
  }
  return { ...ev, data };
}

function parseSinceDuration(raw: string): Date | undefined {
  const match = raw.match(/^(\d+)(m|h|d)$/);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === "m" ? value * 60_000 : unit === "h" ? value * 3_600_000 : value * 86_400_000;
  return new Date(Date.now() - ms);
}

function formatRow(ev: ActivityEvent): string {
  const ts = new Date(ev.tsEpoch).toLocaleTimeString();
  const session = ev.sessionId ? ev.sessionId.slice(0, 12) : "—";
  const kind = chalk.cyan(ev.kind.padEnd(22));
  // Pad raw string before chalk-wrapping: chalk adds ANSI codes that inflate .length
  const levelLabel = ev.level.padEnd(9);
  const level =
    ev.level === "error"
      ? chalk.red(levelLabel)
      : ev.level === "warn"
        ? chalk.yellow(levelLabel)
        : chalk.gray(levelLabel);
  return `${chalk.dim(ts)}  ${kind}  ${level}  ${chalk.dim(session)}  ${ev.summary}`;
}

function jsonMeta(resultCount: number, fallbackUsed = false): JsonEnvelope["meta"] {
  return {
    resultCount,
    droppedEventCount: droppedEventCount(),
    ftsEnabled: isActivityEventsFtsEnabled(),
    fallbackUsed,
    ts: new Date().toISOString(),
  };
}

export function registerEvents(program: Command): void {
  const events = program
    .command("events")
    .description("Query activity event log (session spawns, transitions, CI failures)");

  events
    .command("list")
    .description("List recent activity events")
    .option("-p, --project <id>", "Filter by project ID")
    .option("-s, --session <id>", "Filter by session ID")
    .option("-t, --type <kind>", "Filter by event kind (e.g. session.spawned, lifecycle.transition)")
    .option("--log-level <level>", "Filter by log level (debug, info, warn, error)")
    .option("--since <duration>", "Show events from last N minutes/hours/days (e.g. 30m, 2h, 1d)")
    .option("-n, --limit <n>", "Max results", "50")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, string | undefined>) => {
      const sinceRaw = opts["since"];
      let since: Date | undefined;
      if (sinceRaw) {
        since = parseSinceDuration(sinceRaw);
        if (!since) {
          console.error(chalk.yellow(`Warning: unrecognised --since format "${sinceRaw}" (use e.g. 30m, 2h, 1d). No time filter applied.`));
        }
      }
      const limit = parseInt(opts["limit"] ?? "50", 10);

      const results = queryActivityEvents({
        projectId: opts["project"],
        sessionId: opts["session"],
        kind: opts["type"] as ActivityEventKind,
        level: opts["logLevel"] as ActivityEventLevel,
        since,
        limit,
      });

      if (opts["json"]) {
        const envelope: JsonEnvelope = {
          version: 1,
          query: {
            projectId: opts["project"] ?? null,
            sessionId: opts["session"] ?? null,
            kind: opts["type"] ?? null,
            level: opts["logLevel"] ?? null,
            since: sinceRaw ?? null,
            limit,
          },
          meta: jsonMeta(results.length),
          events: results.map(toJsonOutput),
        };
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.dim("No events found."));
        return;
      }

      console.log(
        chalk.dim(
          `${"TIME".padEnd(10)}  ${"KIND".padEnd(22)}  ${"LEVEL".padEnd(9)}  ${"SESSION".padEnd(12)}  SUMMARY`,
        ),
      );
      for (const ev of results) {
        console.log(formatRow(ev));
      }
      console.log(chalk.dim(`\n${results.length} event(s)`));
    });

  events
    .command("search <query>")
    .description("Full-text search across event summaries and data")
    .option("-p, --project <id>", "Filter by project ID")
    .option("-n, --limit <n>", "Max results", "100")
    .option("--json", "Output as JSON")
    .action(async (query: string, opts: Record<string, string | undefined>) => {
      const limit = parseInt(opts["limit"] ?? "100", 10);
      const results = searchActivityEvents(query, opts["project"], limit);
      const fallbackUsed = !isActivityEventsFtsEnabled();

      if (opts["json"]) {
        const envelope: JsonEnvelope = {
          version: 1,
          query: { q: query, projectId: opts["project"] ?? null, limit },
          meta: jsonMeta(results.length, fallbackUsed),
          events: results.map(toJsonOutput),
        };
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.dim("No events found."));
        return;
      }

      console.log(
        chalk.dim(
          `${"TIME".padEnd(10)}  ${"KIND".padEnd(22)}  ${"LEVEL".padEnd(9)}  ${"SESSION".padEnd(12)}  SUMMARY`,
        ),
      );
      for (const ev of results) {
        console.log(formatRow(ev));
      }
      console.log(chalk.dim(`\n${results.length} event(s)`));
    });

  events
    .command("stats")
    .description("Show event log statistics")
    .action(async () => {
      const stats = getActivityEventStats();
      if (!stats) {
        console.log(chalk.yellow("Event log unavailable (better-sqlite3 not loaded)."));
        return;
      }

      console.log(chalk.bold("Event Log Stats"));
      console.log(`  Total events:      ${stats.total}`);
      console.log(`  Dropped (process): ${stats.droppedThisProcess}`);
      if (stats.oldestTs) console.log(`  Oldest event:      ${stats.oldestTs}`);
      if (stats.newestTs) console.log(`  Newest event:      ${stats.newestTs}`);

      if (Object.keys(stats.byKind).length > 0) {
        console.log(chalk.bold("\nBy kind:"));
        const byKind = Object.entries(stats.byKind) as [string, number][];
        for (const [kind, count] of byKind.sort((a, b) => b[1] - a[1])) {
          console.log(`  ${kind.padEnd(30)} ${count}`);
        }
      }

      if (Object.keys(stats.bySource).length > 0) {
        console.log(chalk.bold("\nBy source:"));
        const bySource = Object.entries(stats.bySource) as [string, number][];
        for (const [source, count] of bySource.sort((a, b) => b[1] - a[1])) {
          console.log(`  ${source.padEnd(30)} ${count}`);
        }
      }
    });
}
