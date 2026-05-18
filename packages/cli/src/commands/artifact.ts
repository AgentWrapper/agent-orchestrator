/**
 * `ao artifact publish` — agent-facing CLI for publishing artifacts to the
 * session detail right rail.
 *
 * Two artifact types:
 *   - `markdown`  — formatted text (no HTML pass-through)
 *   - `html`      — rendered inside a sandboxed iframe
 *
 * Operation:
 *   1. Resolve session from `--session` or `AO_SESSION_ID`.
 *   2. Build the artifact payload (or read from `--spec-file`).
 *   3. Write `<artifact-id>.json` into the session's `.staging` dir.
 *      The watcher picks it up, validates it, and moves it to the canonical
 *      artifacts dir (or writes an `<id>.error` sidecar on failure).
 *   4. Poll for the `.error` sidecar for up to 2 seconds. If it appears,
 *      surface the validation error. If the staging file disappears,
 *      ingest succeeded.
 *
 * The CLI does NOT call the dashboard HTTP API — it writes the staging
 * file directly. This works whether or not the dashboard is running.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  getSessionArtifactsStagingDir,
  loadConfig,
} from "@aoagents/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";

interface PublishOptions {
  type?: "markdown" | "html";
  id?: string;
  title?: string;
  content?: string;
  contentFile?: string;
  source?: string;
  specFile?: string;
  json?: boolean;
  session?: string;
}

function resolveSessionId(explicit: string | undefined): string {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env["AO_SESSION_ID"]?.trim();
  if (fromEnv) return fromEnv;
  console.error(
    chalk.red(
      "No session provided. Pass --session or set AO_SESSION_ID (set automatically inside managed sessions).",
    ),
  );
  process.exit(1);
}

async function buildPayload(opts: PublishOptions): Promise<Record<string, unknown>> {
  switch (opts.type) {
    case "markdown": {
      const markdown =
        opts.content ??
        (opts.contentFile ? await readFile(opts.contentFile, "utf-8") : "");
      return { markdown };
    }
    case "html": {
      const html =
        opts.content ??
        (opts.contentFile ? await readFile(opts.contentFile, "utf-8") : "");
      return { html };
    }
    default:
      throw new Error(`Unknown --type: ${String(opts.type)}`);
  }
}

interface PublishResult {
  ok: boolean;
  id: string;
  error?: unknown;
  message?: string;
}

function emitResult(opts: PublishOptions, result: PublishResult): never {
  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, id: result.id }));
    } else {
      console.log(JSON.stringify({ ok: false, id: result.id, error: result.error }));
    }
  } else if (result.ok) {
    console.log(`${chalk.green("✓")} published ${chalk.bold(`"${result.id}"`)}`);
  } else {
    console.error(
      `${chalk.red("✗")} ${chalk.bold(`"${result.id}"`)} ${result.message ?? "rejected"}`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}

async function publish(opts: PublishOptions): Promise<void> {
  // Determine artifact type/id/title up front when not using --spec-file.
  if (!opts.specFile) {
    if (!opts.type) {
      console.error(chalk.red("--type is required (markdown | html) unless --spec-file is used"));
      process.exit(1);
    }
    if (!opts.id) {
      console.error(chalk.red("--id is required unless --spec-file is used"));
      process.exit(1);
    }
    if (!opts.title) {
      console.error(chalk.red("--title is required unless --spec-file is used"));
      process.exit(1);
    }
  }

  const sessionId = resolveSessionId(opts.session);
  const config = loadConfig();
  const sm = await getSessionManager(config);
  const session = await sm.get(sessionId);
  if (!session) {
    console.error(chalk.red(`Session not found: ${sessionId}`));
    process.exit(1);
  }

  // Build the artifact body. With --spec-file the agent supplies the full JSON
  // (id/type/title/payload/source); otherwise assemble from flags.
  let body: Record<string, unknown>;
  let artifactId: string;
  if (opts.specFile) {
    const raw = await readFile(opts.specFile, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(chalk.red(`Failed to parse --spec-file: ${(err as Error).message}`));
      process.exit(1);
    }
    if (!parsed || typeof parsed !== "object") {
      console.error(chalk.red("--spec-file must contain a JSON object"));
      process.exit(1);
    }
    body = parsed as Record<string, unknown>;
    const specId = body["id"];
    if (typeof specId !== "string" || specId.length === 0) {
      console.error(chalk.red("--spec-file payload must have a string `id`"));
      process.exit(1);
    }
    artifactId = specId;
    // Per-flag overrides are accepted; they take precedence over spec values.
    if (opts.id) body["id"] = opts.id;
    if (opts.title) body["title"] = opts.title;
    if (opts.source) body["source"] = opts.source;
    if (opts.id) artifactId = opts.id;
  } else {
    let payload: Record<string, unknown>;
    try {
      payload = await buildPayload(opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
    artifactId = opts.id as string;
    body = {
      id: artifactId,
      type: opts.type,
      title: opts.title,
      payload,
    };
    if (opts.source) body["source"] = opts.source;
  }

  const stagingDir = getSessionArtifactsStagingDir(session.projectId, sessionId);
  await mkdir(stagingDir, { recursive: true });
  const stagingPath = join(stagingDir, `${artifactId}.json`);
  const errorPath = stagingPath.replace(/\.json$/, ".error");

  // Atomic write: tempfile then rename. Without this, the watcher could
  // observe a partially-written staging file if its awaitWriteFinish
  // threshold is ever lowered or swapped for a faster watcher. The .tmp
  // prefix is a dotfile so the chokidar watcher's ignore rule skips it.
  const tmpPath = join(stagingDir, `.${artifactId}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(body, null, 2), "utf-8");
    await rename(tmpPath, stagingPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  // Poll for ingest. Either the .error sidecar appears (validation failure)
  // or the staging file disappears (ingest succeeded). Bounded to ~2s.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    let errorRaw: string | null = null;
    try {
      errorRaw = await readFile(errorPath, "utf-8");
    } catch {
      // no .error sidecar yet
    }
    if (errorRaw !== null) {
      let errorJson: unknown;
      try {
        errorJson = JSON.parse(errorRaw);
      } catch {
        errorJson = { raw: errorRaw };
      }
      const firstIssue =
        (errorJson as { issues?: { message?: string }[] }).issues?.[0]?.message ??
        "validation failed";
      emitResult(opts, {
        ok: false,
        id: artifactId,
        error: errorJson,
        message: `rejected: ${firstIssue}`,
      });
    }
    let stillStaged = true;
    try {
      await stat(stagingPath);
    } catch {
      stillStaged = false;
    }
    if (!stillStaged) {
      emitResult(opts, { ok: true, id: artifactId });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  emitResult(opts, {
    ok: false,
    id: artifactId,
    error: "ingest_timeout",
    message: "ingest timeout — is the dashboard running? (pnpm dev)",
  });
}

export function registerArtifact(program: Command): void {
  const artifact = program.command("artifact").description("Manage artifacts on a session");

  artifact
    .command("publish")
    .description("Publish an artifact (markdown or html) to the session right rail")
    .option("--type <type>", "markdown | html (required unless --spec-file)")
    .option("--id <id>", "stable artifact id, e.g. plan-v2 (required unless --spec-file)")
    .option("--title <title>", "display title (required unless --spec-file)")
    .option("--content <text>", "inline content (markdown or html types)")
    .option("--content-file <path>", "read content from a file")
    .option("--source <label>", "free-form source label")
    .option("--spec-file <path>", "JSON file with the full artifact body (alternative to flags)")
    .option("--json", "emit JSON output")
    .option("-s, --session <name>", "session name (overrides AO_SESSION_ID)")
    .action(async (opts: PublishOptions) => {
      await publish(opts);
    });
}
