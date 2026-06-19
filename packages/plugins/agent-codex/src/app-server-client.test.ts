import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter, PassThrough, Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { CodexAppServerClient, type ApprovalDecision } from "./app-server-client.js";

// ---------------------------------------------------------------------------
// Helpers: fake child process
// ---------------------------------------------------------------------------
class FakeProcess extends EventEmitter {
  stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  pid = 12345;

  /** Lines written to stdin (captured for assertions) */
  stdinLines: string[] = [];

  constructor() {
    super();
    // Capture stdin writes
    const origWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: string | Buffer, ...args: unknown[]) => {
      this.stdinLines.push(chunk.toString());
      return origWrite(chunk, ...args);
    }) as typeof this.stdin.write;
  }

  /** Simulate the server sending a line on stdout */
  sendLine(data: string): void {
    this.stdout.write(data + "\n");
  }

  /** Simulate process exit */
  simulateExit(code: number | null = 0, signal: string | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  kill(_signal?: string): boolean {
    return true;
  }
}

function createFakeProcess(): FakeProcess {
  const proc = new FakeProcess();
  mockSpawn.mockReturnValue(proc);
  return proc;
}

/** Parse JSON-RPC messages written to stdin */
function parseStdinMessages(proc: FakeProcess): Array<Record<string, unknown>> {
  return proc.stdinLines
    .flatMap((line) => line.split("\n"))
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Find a request by method in stdin messages */
function findRequest(proc: FakeProcess, method: string): Record<string, unknown> | undefined {
  return parseStdinMessages(proc).find((msg) => msg["method"] === method);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Shared helper: connect a client to a fake process (handshake)
// ---------------------------------------------------------------------------
async function connectClient(client: CodexAppServerClient, proc: FakeProcess): Promise<void> {
  const connectPromise = client.connect();
  await new Promise((r) => setTimeout(r, 10));
  const initReq = findRequest(proc, "initialize");
  if (initReq) {
    proc.sendLine(JSON.stringify({ id: initReq["id"], result: {} }));
  }
  await connectPromise;
}

async function closeClient(client: CodexAppServerClient, proc: FakeProcess): Promise<void> {
  const closePromise = client.close();
  proc.simulateExit(0);
  await closePromise;
}

// =========================================================================
// Construction & Connection
// =========================================================================
describe("CodexAppServerClient", () => {
  describe("constructor", () => {
    it("creates client with default options", () => {
      const client = new CodexAppServerClient();
      expect(client.isConnected).toBe(false);
    });

    it("accepts custom options", () => {
      const client = new CodexAppServerClient({
        binaryPath: "/custom/codex",
        cwd: "/my/project",
        requestTimeout: 5000,
      });
      expect(client.isConnected).toBe(false);
    });
  });

  describe("connect", () => {
    it("spawns codex app-server and verifies spawn args", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      expect(client.isConnected).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("codex", ["app-server"], expect.any(Object));

      // Should have sent initialize request and initialized notification
      const initReq = findRequest(proc, "initialize");
      expect(initReq).toBeDefined();
      expect(initReq!["jsonrpc"]).toBe("2.0");
      const initializedNotif = findRequest(proc, "initialized");
      expect(initializedNotif).toBeDefined();
      expect(initializedNotif!["jsonrpc"]).toBe("2.0");

      await closeClient(client, proc);
    });

    it("uses custom binary path", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ binaryPath: "/opt/codex", requestTimeout: 500 });
      await connectClient(client, proc);

      expect(mockSpawn).toHaveBeenCalledWith("/opt/codex", ["app-server"], expect.any(Object));
      await closeClient(client, proc);
    });

    it("throws if already connected", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      await expect(client.connect()).rejects.toThrow("already connected");
      await closeClient(client, proc);
    });

    it("throws if client is closed", async () => {
      const client = new CodexAppServerClient();
      await client.close();
      await expect(client.connect()).rejects.toThrow("closed");
    });

    it("forwards cwd and env to spawn", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({
        cwd: "/my/project",
        env: { OPENAI_API_KEY: "sk-test" },
        requestTimeout: 500,
      });
      await connectClient(client, proc);

      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        ["app-server"],
        expect.objectContaining({
          cwd: "/my/project",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
      // env should merge with process.env
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[2].env).toBeDefined();
      expect(spawnCall[2].env.OPENAI_API_KEY).toBe("sk-test");

      await closeClient(client, proc);
    });

    it("emits 'connected' event after handshake", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      const events: unknown[] = [];
      client.on("connected", (result: unknown) => events.push(result));

      await connectClient(client, proc);

      expect(events).toHaveLength(1);
      await closeClient(client, proc);
    });

    it("sends clientInfo in initialize request", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      const initReq = findRequest(proc, "initialize");
      expect(initReq).toBeDefined();
      const params = initReq!["params"] as Record<string, unknown>;
      const clientInfo = params["clientInfo"] as Record<string, unknown>;
      expect(clientInfo["name"]).toBe("ao-agent-codex");
      expect(clientInfo["version"]).toBe("0.1.1");

      await closeClient(client, proc);
    });
  });

  describe("close", () => {
    it("sends SIGTERM to the process", async () => {
      const proc = createFakeProcess();
      const killSpy = vi.spyOn(proc, "kill");
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      await closeClient(client, proc);

      expect(killSpy).toHaveBeenCalledWith("SIGTERM");
      expect(client.isConnected).toBe(false);
    });

    it("is idempotent — calling close twice is safe", async () => {
      const client = new CodexAppServerClient();
      await client.close();
      await client.close(); // Should not throw
    });

    it("rejects pending requests on close", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      // Send a request that won't be answered
      const requestPromise = client.threadList();

      await closeClient(client, proc);

      await expect(requestPromise).rejects.toThrow("closed");
    });
  });

  // =========================================================================
  // Request / Response
  // =========================================================================
  describe("sendRequest", () => {
    let proc: FakeProcess;
    let client: CodexAppServerClient;

    beforeEach(async () => {
      proc = createFakeProcess();
      client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);
    });

    afterEach(async () => {
      await closeClient(client, proc);
    });

    it("correlates responses by id", async () => {
      const promise = client.sendRequest("thread/list", {});
      await new Promise((r) => setTimeout(r, 10));

      const msgs = parseStdinMessages(proc);
      const req = msgs.find((m) => m["method"] === "thread/list");
      expect(req).toBeDefined();

      proc.sendLine(
        JSON.stringify({
          id: req!["id"],
          result: { threads: [{ id: "t-1" }] },
        }),
      );

      const result = await promise;
      expect(result).toEqual({ threads: [{ id: "t-1" }] });
    });

    it("rejects on JSON-RPC error response", async () => {
      const promise = client.sendRequest("thread/start", {});
      await new Promise((r) => setTimeout(r, 10));

      const msgs = parseStdinMessages(proc);
      const req = msgs.find((m) => m["method"] === "thread/start");

      proc.sendLine(
        JSON.stringify({
          id: req!["id"],
          error: { code: -32600, message: "Invalid params" },
        }),
      );

      await expect(promise).rejects.toThrow("Invalid params");
    });

    it("times out if no response received", async () => {
      // requestTimeout is 500ms
      const promise = client.sendRequest("thread/start", {});
      await expect(promise).rejects.toThrow("timed out");
    }, 2000);

    it("throws if client is not initialized", async () => {
      const uninitClient = new CodexAppServerClient();
      await expect(uninitClient.sendRequest("thread/list", {})).rejects.toThrow("not initialized");
    });

    it("throws after client is closed", async () => {
      await closeClient(client, proc);
      // After close, initialized=false so "not initialized" check fires first
      await expect(client.sendRequest("thread/list", {})).rejects.toThrow();
      // Prevent afterEach from double-closing
      proc = createFakeProcess();
      client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);
    });

    it("resolves to empty object when response has no result field", async () => {
      const promise = client.sendRequest("thread/list", {});
      await new Promise((r) => setTimeout(r, 10));

      const msgs = parseStdinMessages(proc);
      const req = msgs.find((m) => m["method"] === "thread/list");

      // Response with id but no result field
      proc.sendLine(JSON.stringify({ id: req!["id"] }));

      const result = await promise;
      expect(result).toEqual({});
    });
  });

  // =========================================================================
  // Thread Management
  // =========================================================================
  describe("thread management", () => {
    let proc: FakeProcess;
    let client: CodexAppServerClient;

    beforeEach(async () => {
      proc = createFakeProcess();
      client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;
    });

    afterEach(async () => {
      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });

    it("threadStart sends thread/start request with params", async () => {
      const promise = client.threadStart({ model: "o3-mini", cwd: "/project" });
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "thread/start");
      expect(req).toBeDefined();
      expect(req!["params"]).toEqual({ model: "o3-mini", cwd: "/project" });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: { id: "thread-abc" } }));
      const result = await promise;
      expect(result).toEqual({ id: "thread-abc" });
    });

    it("threadResume sends thread/resume request with threadId", async () => {
      const promise = client.threadResume("thread-123");
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "thread/resume");
      expect(req).toBeDefined();
      expect(req!["params"]).toEqual({ threadId: "thread-123" });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: { id: "thread-123" } }));
      const result = await promise;
      expect(result).toEqual({ id: "thread-123" });
    });

    it("threadList sends thread/list request", async () => {
      const promise = client.threadList("cursor-1", 10);
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "thread/list");
      expect(req).toBeDefined();
      expect(req!["params"]).toEqual({ cursor: "cursor-1", limit: 10 });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: { threads: [] } }));
      await promise;
    });

    it("threadStart sends thread/start with empty params by default", async () => {
      const promise = client.threadStart();
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "thread/start");
      expect(req).toBeDefined();
      expect(req!["params"]).toEqual({});

      proc.sendLine(JSON.stringify({ id: req!["id"], result: { id: "thread-default" } }));
      const result = await promise;
      expect(result).toEqual({ id: "thread-default" });
    });

    it("threadArchive sends thread/archive request", async () => {
      const promise = client.threadArchive("thread-old");
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "thread/archive");
      expect(req!["params"]).toEqual({ threadId: "thread-old" });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: {} }));
      await promise;
    });
  });

  // =========================================================================
  // Turn Management
  // =========================================================================
  describe("turn management", () => {
    let proc: FakeProcess;
    let client: CodexAppServerClient;

    beforeEach(async () => {
      proc = createFakeProcess();
      client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;
    });

    afterEach(async () => {
      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });

    it("turnStart sends turn/start with text input", async () => {
      const promise = client.turnStart({
        threadId: "t-1",
        input: "Fix the bug in auth.ts",
      });
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "turn/start");
      expect(req).toBeDefined();
      expect(req!["params"]).toEqual({
        threadId: "t-1",
        input: [{ type: "text", text: "Fix the bug in auth.ts" }],
      });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: { turnId: "turn-1" } }));
      const result = await promise;
      expect(result).toEqual({ turnId: "turn-1" });
    });

    it("turnStart includes optional cwd and model params", async () => {
      const promise = client.turnStart({
        threadId: "t-1",
        input: "Fix it",
        cwd: "/custom/dir",
        model: "o3-mini",
      });
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "turn/start");
      expect(req).toBeDefined();
      expect(req!["params"]).toEqual({
        threadId: "t-1",
        input: [{ type: "text", text: "Fix it" }],
        cwd: "/custom/dir",
        model: "o3-mini",
      });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: { turnId: "turn-2" } }));
      await promise;
    });

    it("turnInterrupt sends turn/interrupt", async () => {
      const promise = client.turnInterrupt("t-1", "turn-1");
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "turn/interrupt");
      expect(req!["params"]).toEqual({ threadId: "t-1", turnId: "turn-1" });

      proc.sendLine(JSON.stringify({ id: req!["id"], result: {} }));
      await promise;
    });
  });

  // =========================================================================
  // Notifications
  // =========================================================================
  describe("notifications", () => {
    it("routes server notifications to handler", async () => {
      const proc = createFakeProcess();
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

      const client = new CodexAppServerClient({
        requestTimeout: 500,
        onNotification: (method, params) => {
          notifications.push({ method, params });
        },
      });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      // Server sends a notification
      proc.sendLine(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "t-1", turnId: "turn-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        method: "turn/completed",
        params: { threadId: "t-1", turnId: "turn-1" },
      });

      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });

    it("emits notification events on the EventEmitter", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      const events: Array<[string, Record<string, unknown>]> = [];
      client.on("notification", (method: string, params: Record<string, unknown>) => {
        events.push([method, params]);
      });

      proc.sendLine(
        JSON.stringify({
          method: "thread/tokenUsage/updated",
          params: { inputTokens: 100 },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(events).toHaveLength(1);
      expect(events[0]![0]).toBe("thread/tokenUsage/updated");

      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });
  });

  // =========================================================================
  // Approval Requests
  // =========================================================================
  describe("approval handling", () => {
    it("auto-accepts approvals when no handler is provided", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      // Server sends approval request
      proc.sendLine(
        JSON.stringify({
          id: 0,
          method: "item/fileChange/requestApproval",
          params: { path: "test.ts" },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      // Should have auto-responded with accept
      const approvalResponse = proc.stdinLines.find((l) => l.includes('"accept"'));
      expect(approvalResponse).toBeDefined();

      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });

    it("falls back to 'decline' when approval handler throws", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({
        requestTimeout: 500,
        onApproval: async () => {
          throw new Error("handler crashed");
        },
      });

      await connectClient(client, proc);

      proc.sendLine(
        JSON.stringify({
          id: 99,
          method: "item/fileChange/requestApproval",
          params: { path: "dangerous.ts" },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      // Should have responded with "decline" due to handler error
      const declineResponse = proc.stdinLines.find((l) => l.includes('"decline"'));
      expect(declineResponse).toBeDefined();

      await closeClient(client, proc);
    });

    it("emits 'approval' event for approval requests", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      const events: Array<[string | number, string, Record<string, unknown>]> = [];
      client.on(
        "approval",
        (id: string | number, method: string, params: Record<string, unknown>) => {
          events.push([id, method, params]);
        },
      );

      await connectClient(client, proc);

      proc.sendLine(
        JSON.stringify({
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: { command: ["ls"] },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(events).toHaveLength(1);
      expect(events[0]![1]).toBe("item/commandExecution/requestApproval");

      await closeClient(client, proc);
    });

    it("delegates to custom approval handler", async () => {
      const proc = createFakeProcess();
      const decisions: ApprovalDecision[] = [];

      const client = new CodexAppServerClient({
        requestTimeout: 500,
        onApproval: async (_id, _method, _params) => {
          decisions.push("decline");
          return "decline";
        },
      });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      proc.sendLine(
        JSON.stringify({
          id: 42,
          method: "item/commandExecution/requestApproval",
          params: { command: ["rm", "-rf", "/"] },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(decisions).toEqual(["decline"]);

      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });
  });

  // =========================================================================
  // Process lifecycle
  // =========================================================================
  describe("process lifecycle", () => {
    it("rejects pending requests when process exits", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 5000 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      // Start a request
      const requestPromise = client.threadList();
      await new Promise((r) => setTimeout(r, 10));

      // Process exits unexpectedly
      proc.simulateExit(1, null);

      await expect(requestPromise).rejects.toThrow("exited");
      expect(client.isConnected).toBe(false);
    });

    it("emits exit event on process exit", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      const exits: Array<[number | null, string | null]> = [];
      client.on("exit", (code: number | null, signal: string | null) => {
        exits.push([code, signal]);
      });

      proc.simulateExit(0, null);
      expect(exits).toEqual([[0, null]]);
    });

    it("emits error and rejects pending on process spawn error", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 5000 });

      await connectClient(client, proc);

      const errors: Error[] = [];
      client.on("error", (err: Error) => errors.push(err));

      // Start a request
      const requestPromise = client.threadList();
      await new Promise((r) => setTimeout(r, 10));

      // Process emits error
      proc.emit("error", new Error("spawn ENOENT"));

      await expect(requestPromise).rejects.toThrow("spawn ENOENT");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("spawn ENOENT");
      expect(client.isConnected).toBe(false);
    });

    it("rejects pending requests before emitting error (no listener crash safe)", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 5000 });

      await connectClient(client, proc);

      // Do NOT attach an error listener — emit("error") will throw
      // Start a request that will be pending
      const requestPromise = client.threadList();
      await new Promise((r) => setTimeout(r, 10));

      // Process emits error — without a listener, emit("error") throws.
      // Pending requests must still be rejected before that throw.
      try {
        proc.emit("error", new Error("spawn ENOENT"));
      } catch {
        // Expected: uncaught error event from EventEmitter
      }

      await expect(requestPromise).rejects.toThrow("spawn ENOENT");
    });

    it("handles malformed JSON lines gracefully", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      // Send garbage — should not crash
      proc.sendLine("not valid json {{{");
      proc.sendLine("");
      proc.sendLine("   ");

      // Client should still be connected
      expect(client.isConnected).toBe(true);

      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });
  });

  // =========================================================================
  // sendNotification & sendApprovalResponse
  // =========================================================================
  describe("sendNotification", () => {
    it("sends a notification without id (no response expected)", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      client.sendNotification("custom/event", { key: "value" });
      await new Promise((r) => setTimeout(r, 10));

      const msg = parseStdinMessages(proc).find((m) => m["method"] === "custom/event");
      expect(msg).toBeDefined();
      expect(msg!["params"]).toEqual({ key: "value" });
      expect(msg!["id"]).toBeUndefined();

      await closeClient(client, proc);
    });

    it("is a no-op on closed client", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);
      await closeClient(client, proc);

      // Should not throw
      client.sendNotification("custom/event", {});
    });
  });

  describe("sendApprovalResponse", () => {
    it("sends approval response with decision", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      client.sendApprovalResponse(42, "acceptForSession");
      await new Promise((r) => setTimeout(r, 10));

      const response = proc.stdinLines.find((l) => l.includes('"acceptForSession"'));
      expect(response).toBeDefined();
      const parsed = JSON.parse(response!) as Record<string, unknown>;
      expect(parsed["id"]).toBe(42);
      expect(parsed["result"]).toEqual({ decision: "acceptForSession" });

      await closeClient(client, proc);
    });

    it("is a no-op on closed client", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);
      await closeClient(client, proc);

      // Should not throw
      client.sendApprovalResponse("req-1", "cancel");
    });
  });

  // =========================================================================
  // handleLine edge cases
  // =========================================================================
  describe("handleLine edge cases", () => {
    it("ignores JSON arrays", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      // Send a JSON array — should be silently ignored
      proc.sendLine(JSON.stringify([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 10));

      expect(client.isConnected).toBe(true);
      await closeClient(client, proc);
    });

    it("ignores JSON primitives (string, number)", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      proc.sendLine(JSON.stringify("hello"));
      proc.sendLine(JSON.stringify(42));
      proc.sendLine(JSON.stringify(null));
      await new Promise((r) => setTimeout(r, 10));

      expect(client.isConnected).toBe(true);
      await closeClient(client, proc);
    });

    it("ignores messages with unknown id and no method", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      // Message with id that doesn't match any pending request and no method
      proc.sendLine(JSON.stringify({ id: "unknown-id-999", result: { data: "orphan" } }));
      await new Promise((r) => setTimeout(r, 10));

      expect(client.isConnected).toBe(true);
      await closeClient(client, proc);
    });
  });

  // =========================================================================
  // Model Discovery
  // =========================================================================
  describe("model discovery", () => {
    it("modelList sends model/list request", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      const promise = client.modelList();
      await new Promise((r) => setTimeout(r, 10));

      const req = findRequest(proc, "model/list");
      expect(req).toBeDefined();

      proc.sendLine(
        JSON.stringify({
          id: req!["id"],
          result: { models: [{ id: "o3-mini" }, { id: "gpt-4o" }] },
        }),
      );

      const result = await promise;
      expect(result).toEqual({ models: [{ id: "o3-mini" }, { id: "gpt-4o" }] });

      const closePromise = client.close();
      proc.simulateExit(0);
      await closePromise;
    });
  });

  // =========================================================================
  // Concurrency & resource cleanup (review fixes)
  // =========================================================================
  describe("concurrency guards", () => {
    it("throws if connect() is called while already connecting", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });

      // Start connect but don't complete the handshake
      const connectPromise = client.connect();

      // Second connect() should throw immediately
      await expect(client.connect()).rejects.toThrow("already connecting");

      // Complete the handshake to clean up
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;
      await closeClient(client, proc);
    });

    it("cleans up process when initialize handshake fails", async () => {
      const proc = createFakeProcess();
      // Make kill trigger exit so close() doesn't hang
      vi.spyOn(proc, "kill").mockImplementation((_signal?: string) => {
        proc.simulateExit(1, "SIGTERM");
        return true;
      });
      const client = new CodexAppServerClient({ requestTimeout: 200 });

      // Start connect — don't answer the initialize request so it times out
      await expect(client.connect()).rejects.toThrow("timed out");

      // Client should have cleaned up — not connected, not connecting
      expect(client.isConnected).toBe(false);
    });

    it("allows retry after a failed connect (does not permanently close)", async () => {
      // First attempt: spawn a process that times out during handshake
      const proc1 = createFakeProcess();
      vi.spyOn(proc1, "kill").mockImplementation((_signal?: string) => {
        proc1.simulateExit(1, "SIGTERM");
        return true;
      });
      const client = new CodexAppServerClient({ requestTimeout: 200 });

      await expect(client.connect()).rejects.toThrow("timed out");
      expect(client.isConnected).toBe(false);

      // Second attempt should NOT throw "Client is closed" — it should be retryable
      const proc2 = createFakeProcess();
      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc2, "initialize");
      proc2.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      expect(client.isConnected).toBe(true);
      await closeClient(client, proc2);
    });

    it("drains stderr without blocking the child process", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      // Write a large amount of data to stderr — should not block
      const largeChunk = "x".repeat(65536);
      proc.stderr.write(largeChunk);
      await new Promise((r) => setTimeout(r, 10));

      expect(client.isConnected).toBe(true);
      await closeClient(client, proc);
    });

    it("resets connecting flag if spawn throws synchronously", async () => {
      // Make spawn throw (e.g. EMFILE, ENOMEM)
      mockSpawn.mockImplementationOnce(() => {
        throw new Error("spawn EMFILE");
      });

      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await expect(client.connect()).rejects.toThrow("spawn EMFILE");

      // connecting flag should be reset — a retry should not throw "already connecting"
      const proc = createFakeProcess();
      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const initReq = findRequest(proc, "initialize");
      proc.sendLine(JSON.stringify({ id: initReq!["id"], result: {} }));
      await connectPromise;

      expect(client.isConnected).toBe(true);
      await closeClient(client, proc);
    });
  });

  describe("readline cleanup on process exit/error", () => {
    it("closes readline on unexpected process exit", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      // Spy on readline close — the client stores it privately so we check
      // indirectly: after exit, sending another line should not cause errors
      proc.simulateExit(1, null);
      await new Promise((r) => setTimeout(r, 10));

      // Client should be disconnected
      expect(client.isConnected).toBe(false);

      // Sending data on stdout should not throw (readline is closed)
      expect(() => proc.sendLine('{"id":"x","result":{}}')).not.toThrow();
    });

    it("closes readline on process error", async () => {
      const proc = createFakeProcess();
      const client = new CodexAppServerClient({ requestTimeout: 500 });
      await connectClient(client, proc);

      // Catch the error event on the client to prevent unhandled error
      const errors: Error[] = [];
      client.on("error", (err: Error) => errors.push(err));

      proc.emit("error", new Error("process crashed"));
      await new Promise((r) => setTimeout(r, 10));

      expect(client.isConnected).toBe(false);
      expect(errors).toHaveLength(1);
    });
  });
});
