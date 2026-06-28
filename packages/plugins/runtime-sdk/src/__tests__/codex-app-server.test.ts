import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { SessionHost, type SessionHostOptions } from "../sdk-host.js";
import { runCodexAppServerMode } from "../providers/codex-app-server.js";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

class FakeProcess extends EventEmitter {
  stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  stdinLines: string[] = [];
  pid = 4567;

  constructor() {
    super();
    const originalWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: string | Buffer, ...args: unknown[]) => {
      this.stdinLines.push(chunk.toString());
      return (originalWrite as (...writeArgs: unknown[]) => boolean)(chunk, ...args);
    }) as typeof this.stdin.write;
  }

  sendLine(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal?: string): boolean {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    return true;
  }
}

function makeHost(extra: Partial<SessionHostOptions> = {}) {
  const persisted: string[] = [];
  const host = new SessionHost({
    aoSessionId: "codex-test",
    permissionMode: "bypassPermissions",
    persist: (line) => persisted.push(line),
    now: () => new Date("2026-06-28T00:00:00.000Z"),
    ...extra,
  });
  return {
    host,
    events: () => persisted.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function createFakeProcess(): FakeProcess {
  const proc = new FakeProcess();
  mockSpawn.mockReturnValue(proc);
  return proc;
}

function stdinMessages(proc: FakeProcess): Array<Record<string, unknown>> {
  return proc.stdinLines
    .flatMap((line) => line.split("\n"))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForRequest(proc: FakeProcess, method: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const found = stdinMessages(proc).find((msg) => msg["method"] === method);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`missing request ${method}`);
}

async function waitForEvent(
  events: () => Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const found = events().find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("missing event");
}

function respond(proc: FakeProcess, request: Record<string, unknown>, result: Record<string, unknown>): void {
  proc.sendLine({ id: request["id"], result });
}

const TEST_CODEX_HOME = join(tmpdir(), "mae-codex-test-home");

beforeEach(() => {
  vi.clearAllMocks();
  // Keep CODEX_HOME hermetic: the driver mkdir's it and points the spawn at it
  // (so a real run never clobbers the user's ~/.codex). Pin it to a temp dir.
  process.env.AO_CODEX_HOME = TEST_CODEX_HOME;
});

describe("Codex app-server provider", () => {
  it("starts a Codex thread and maps message/tool/usage/completion notifications", async () => {
    const proc = createFakeProcess();
    const { host, events } = makeHost();

    const done = runCodexAppServerMode(host, {
      cwd: "/workspace/project",
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "Follow project rules.",
      resumeFrom: null,
      model: "gpt-5.5",
      initialPrompt: null,
      apiKey: "sk-test",
    });

    respond(proc, await waitForRequest(proc, "initialize"), {});
    // codex app-server ignores OPENAI_API_KEY env — the driver must authenticate
    // explicitly via account/login/start, passing the resolved key through.
    const login = await waitForRequest(proc, "account/login/start");
    expect(login["params"]).toMatchObject({ type: "apiKey", apiKey: "sk-test" });
    respond(proc, login, { type: "apiKey" });
    // CODEX_HOME is redirected to the AO-managed dir, never the user's ~/.codex.
    const spawnEnv = (mockSpawn.mock.calls[0]?.[2] as { env?: Record<string, string> })?.env;
    expect(spawnEnv?.["CODEX_HOME"]).toBe(TEST_CODEX_HOME);
    const threadStart = await waitForRequest(proc, "thread/start");
    expect(threadStart["params"]).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      cwd: "/workspace/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "Follow project rules.",
    });
    respond(proc, threadStart, { thread: { id: "thr_1" }, model: "gpt-5.5" });

    host.submitTurn("Fix the failing test.");
    const turnStart = await waitForRequest(proc, "turn/start");
    expect(turnStart["params"]).toMatchObject({
      threadId: "thr_1",
      input: [{ type: "text", text: "Fix the failing test." }],
      model: "gpt-5.5",
      approvalPolicy: "never",
    });
    respond(proc, turnStart, { turn: { id: "turn_1", status: "inProgress" } });

    proc.sendLine({
      method: "item/agentMessage/delta",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "msg_1", delta: "I will inspect it." },
    });
    proc.sendLine({
      method: "item/started",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "pnpm test",
          cwd: "/workspace/project",
          source: "agent",
          status: "inProgress",
          commandActions: [],
        },
      },
    });
    proc.sendLine({
      method: "item/completed",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "pnpm test",
          cwd: "/workspace/project",
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });
    proc.sendLine({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        tokenUsage: {
          last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
          total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
        },
      },
    });
    proc.sendLine({
      method: "turn/completed",
      params: {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed", items: [], durationMs: 123 },
      },
    });

    await waitForEvent(events, (event) => event.type === "result");
    host.input.close();
    await done;

    expect(events().find((event) => event.type === "session" && event.subtype === "init")).toMatchObject({
      session_id: "thr_1",
      model: "gpt-5.5",
      tools: expect.arrayContaining(["Bash", "apply_patch"]),
    });
    expect(events().find((event) => event.type === "text-delta")).toMatchObject({
      text: "I will inspect it.",
      turn: 1,
    });
    expect(events().find((event) => event.type === "tool_use")).toMatchObject({
      id: "cmd_1",
      name: "Bash",
    });
    expect(events().find((event) => event.type === "tool_result")).toMatchObject({
      tool_use_id: "cmd_1",
      is_error: false,
      content: expect.stringContaining("ok"),
    });
    expect(events().find((event) => event.type === "usage")).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      model: "gpt-5.5",
    });
    expect(events().find((event) => event.type === "result")).toMatchObject({
      subtype: "success",
      text: "I will inspect it.",
      duration_ms: 123,
    });
  });

  it("routes Codex approval requests through SessionHost permissions", async () => {
    const proc = createFakeProcess();
    const { host, events } = makeHost({
      permissionMode: "default" as PermissionMode,
    });

    const done = runCodexAppServerMode(host, {
      cwd: "/workspace/project",
      permissionMode: "default" as PermissionMode,
      appendSystemPrompt: null,
      resumeFrom: null,
      model: "gpt-5.5",
      initialPrompt: null,
      apiKey: null,
    });

    respond(proc, await waitForRequest(proc, "initialize"), {});
    respond(proc, await waitForRequest(proc, "thread/start"), { thread: { id: "thr_1" }, model: "gpt-5.5" });

    host.submitTurn("Run tests.");
    respond(proc, await waitForRequest(proc, "turn/start"), { turn: { id: "turn_1", status: "inProgress" } });

    proc.sendLine({
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "cmd_1",
        command: "pnpm test",
        cwd: "/workspace/project",
      },
    });

    await waitForEvent(events, (event) => event.type === "permission_request");
    expect(events().find((event) => event.type === "permission_request")).toMatchObject({
      request_id: "perm-1",
      tool_name: "Bash",
    });
    expect(host.resolvePermission("perm-1", "allow")).toBe(true);

    for (let i = 0; i < 100; i++) {
      if (
        stdinMessages(proc).some(
          (msg) =>
            msg["id"] === 77 &&
            (msg["result"] as Record<string, unknown> | undefined)?.["decision"] === "accept",
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(stdinMessages(proc)).toContainEqual({ jsonrpc: "2.0", id: 77, result: { decision: "accept" } });

    proc.sendLine({
      method: "turn/completed",
      params: {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed", items: [], durationMs: 1 },
      },
    });
    await waitForEvent(events, (event) => event.type === "result");
    host.input.close();
    await done;
  });
});
