import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCODE_ACTIVITY_PLUGIN } from "./activity-plugin.js";

/**
 * Executes the real generated OpenCode activity plugin against synthetic
 * events and asserts the JSONL it writes. This proves the event→state mapping
 * and the env-based guards work, not just that the string contains markers.
 */

interface OpenCodeEvent {
  type: string;
}

type PluginHooks = {
  event?: (input: { event: OpenCodeEvent }) => Promise<void> | void;
};

type PluginFactory = (ctx: {
  directory?: string;
  worktree?: string;
}) => Promise<PluginHooks>;

let workDir: string;
let pluginUrl: string;
const savedEnv = { ...process.env };

async function loadPlugin(): Promise<PluginFactory> {
  // Write the generated plugin to a temp .mjs file and import it so we exercise
  // the exact source AO ships, as ESM (matching opencode's Bun loader).
  const pluginPath = join(workDir, "ao-activity.mjs");
  await writeFile(pluginPath, OPENCODE_ACTIVITY_PLUGIN, "utf8");
  // Cache-bust so each test gets a fresh module instance (dedup state resets).
  pluginUrl = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
  const mod = (await import(pluginUrl)) as Record<string, PluginFactory>;
  const factory = Object.values(mod).find((v) => typeof v === "function");
  if (!factory) throw new Error("plugin has no exported factory function");
  return factory;
}

async function readEntries(): Promise<Array<Record<string, unknown>>> {
  const logPath = join(workDir, ".ao", "activity.jsonl");
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ao-oc-plugin-"));
  await mkdir(workDir, { recursive: true });
  process.env["AO_SESSION_ID"] = "sess-xyz";
  delete process.env["AO_OPENCODE_HOOK_ACTIVITY"];
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(workDir, { recursive: true, force: true });
});

describe("OpenCode activity plugin — event mapping", () => {
  it("writes waiting_input on permission.asked", async () => {
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    await hooks.event!({ event: { type: "permission.asked" } });

    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      state: "waiting_input",
      source: "hook",
      sessionId: "sess-xyz",
    });
  });

  it("writes blocked on session.error", async () => {
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    await hooks.event!({ event: { type: "session.error" } });

    const entries = await readEntries();
    expect(entries[0]).toMatchObject({ state: "blocked", source: "hook" });
  });

  it("writes ready on session.idle (never idle — AO age-decay handles idle)", async () => {
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    await hooks.event!({ event: { type: "session.idle" } });

    const entries = await readEntries();
    expect(entries[0]).toMatchObject({ state: "ready", source: "hook" });
  });

  it("writes active on tool execution", async () => {
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    await hooks.event!({ event: { type: "tool.execute.before" } });

    const entries = await readEntries();
    expect(entries[0]).toMatchObject({ state: "active", source: "hook" });
  });

  it("ignores unrelated events", async () => {
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    await hooks.event!({ event: { type: "lsp.updated" } });
    await hooks.event!({ event: { type: "todo.updated" } });

    expect(await readEntries()).toHaveLength(0);
  });

  it("no-ops entirely when AO_SESSION_ID is unset (manual opencode runs don't bleed)", async () => {
    delete process.env["AO_SESSION_ID"];
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    // event handler should be absent or a no-op
    if (hooks.event) {
      await hooks.event({ event: { type: "permission.asked" } });
    }
    expect(await readEntries()).toHaveLength(0);
  });

  it("no-ops when AO_OPENCODE_HOOK_ACTIVITY=0 (opt-out)", async () => {
    process.env["AO_OPENCODE_HOOK_ACTIVITY"] = "0";
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    if (hooks.event) {
      await hooks.event({ event: { type: "permission.asked" } });
    }
    expect(await readEntries()).toHaveLength(0);
  });

  it("deduplicates rapid active events but always writes actionable states", async () => {
    const factory = await loadPlugin();
    const hooks = await factory({ directory: workDir });
    await hooks.event!({ event: { type: "tool.execute.before" } });
    await hooks.event!({ event: { type: "message.updated" } });
    await hooks.event!({ event: { type: "tool.execute.after" } });
    // actionable always writes through, even back-to-back
    await hooks.event!({ event: { type: "permission.asked" } });

    const entries = await readEntries();
    const active = entries.filter((e) => e.state === "active");
    const waiting = entries.filter((e) => e.state === "waiting_input");
    expect(active).toHaveLength(1);
    expect(waiting).toHaveLength(1);
  });
});
