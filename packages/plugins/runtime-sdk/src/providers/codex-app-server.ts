/**
 * providers/codex-app-server.ts -- OpenAI Codex app-server driver.
 *
 * This is the Codex-like OpenAI path: instead of a text-only Responses chat loop,
 * it drives `codex app-server` and translates thread/turn/item notifications into
 * the runtime-sdk normalized event schema consumed by Maestro.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SessionHost } from "../host/session-host.js";
import type { UsageEventBody } from "../event-schema.js";

type JsonObject = Record<string, unknown>;
type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: JsonObject;
}

interface JsonRpcResponse {
  id: string | number;
  result?: JsonObject;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: JsonObject;
}

interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: JsonObject;
}

interface PendingRequest {
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodexAppServerClientOptions {
  binaryPath?: string;
  cwd: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  onNotification: (method: string, params: JsonObject) => void;
  onApproval: (
    id: string | number,
    method: string,
    params: JsonObject,
  ) => Promise<ApprovalDecision>;
}

interface CodexAppServerModeOptions {
  cwd: string;
  permissionMode: PermissionMode;
  appendSystemPrompt: string | null;
  resumeFrom: string | null;
  model: string;
  initialPrompt: string | null;
  apiKey: string | null;
}

interface TurnState {
  id: string | null;
  text: string;
  startedAtMs: number;
  usage?: UsageEventBody;
  completed: boolean;
  waiters: Array<() => void>;
}

const CODEX_TOOL_NAMES = [
  "Bash",
  "apply_patch",
  "mcp_tool",
  "dynamic_tool",
  "web_search",
  "sleep",
  "image_generation",
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonObject(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function extractThreadId(result: JsonObject): string | null {
  const thread = isObject(result["thread"]) ? result["thread"] : null;
  return (
    stringValue(thread?.["id"]) ??
    stringValue(result["threadId"]) ??
    stringValue(result["id"])
  );
}

function extractTurnId(result: JsonObject): string | null {
  const turn = isObject(result["turn"]) ? result["turn"] : null;
  return stringValue(turn?.["id"]) ?? stringValue(result["turnId"]) ?? stringValue(result["id"]);
}

function extractTurnStatus(result: JsonObject): string | null {
  const turn = isObject(result["turn"]) ? result["turn"] : null;
  return stringValue(turn?.["status"]) ?? stringValue(result["status"]);
}

function extractTurnDurationMs(turn: JsonObject | null, fallback: number): number {
  return numberValue(turn?.["durationMs"]) ?? fallback;
}

function permissionModeToCodexPolicy(mode: PermissionMode): {
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandbox: "danger-full-access" | "workspace-write";
} {
  if (mode === "bypassPermissions") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function userTextFromSdkMessage(userMsg: {
  message: { content: unknown };
}): string {
  return typeof userMsg.message.content === "string"
    ? userMsg.message.content
    : stableStringify(userMsg.message.content);
}

function buildUsageEvent(params: JsonObject, model: string): UsageEventBody | null {
  const tokenUsage = isObject(params["tokenUsage"]) ? params["tokenUsage"] : null;
  const last = isObject(tokenUsage?.["last"]) ? tokenUsage["last"] : null;
  const total = isObject(tokenUsage?.["total"]) ? tokenUsage["total"] : null;
  const usage = last ?? total;
  if (!usage) return null;

  const input = numberValue(usage["inputTokens"]) ?? 0;
  const output = numberValue(usage["outputTokens"]) ?? 0;
  const cached = numberValue(usage["cachedInputTokens"]) ?? 0;
  return {
    type: "usage",
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0,
    model,
    models: [
      {
        model,
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
        cost_usd: 0,
      },
    ],
  };
}

class CodexAppServerJsonRpcClient {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pending = new Map<string, PendingRequest>();
  private initialized = false;
  private closed = false;

  constructor(private readonly opts: CodexAppServerClientOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Codex app-server client is closed");
    if (this.initialized) return;

    const binary = this.opts.binaryPath ?? process.env.AO_CODEX_BINARY ?? "codex";
    this.process = spawn(binary, ["app-server"], {
      cwd: this.opts.cwd,
      env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to open stdio pipes for codex app-server");
    }

    this.process.stderr?.resume();
    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line) => this.handleLine(line));
    this.process.once("exit", (code, signal) => {
      this.rejectAll(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
      this.initialized = false;
    });
    this.process.once("error", (err) => {
      this.rejectAll(err);
      this.initialized = false;
    });

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "ao_maestro_runtime_sdk",
        title: "Maestro Runtime SDK",
        version: "0.9.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.sendNotification("initialized", {});
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    this.rejectAll(new Error("Codex app-server client closed"));
    this.readline?.close();
    this.readline = null;

    const proc = this.process;
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 5_000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          proc.kill("SIGTERM");
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.process = null;
  }

  threadStart(params: JsonObject): Promise<JsonObject> {
    return this.sendRequest("thread/start", params);
  }

  threadResume(threadId: string): Promise<JsonObject> {
    return this.sendRequest("thread/resume", { threadId });
  }

  turnStart(params: JsonObject): Promise<JsonObject> {
    return this.sendRequest("turn/start", params);
  }

  private sendRequest(method: string, params: JsonObject = {}): Promise<JsonObject> {
    if (this.closed) throw new Error("Codex app-server client is closed");
    if (method !== "initialize" && !this.initialized) {
      throw new Error("Codex app-server client is not initialized");
    }
    if (!this.process?.stdin?.writable) {
      throw new Error("codex app-server stdin is not writable");
    }

    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request ${method} timed out`));
      }, this.opts.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(request);
    });
  }

  private sendNotification(method: string, params: JsonObject): void {
    this.writeLine({ jsonrpc: "2.0", method, params });
  }

  private sendResponse(id: string | number, result: JsonObject): void {
    this.writeLine({ jsonrpc: "2.0", id, result });
  }

  private writeLine(message: unknown): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (!isObject(parsed)) return;

    if ("id" in parsed && parsed["id"] !== undefined) {
      const id = String(parsed["id"]);
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const response = parsed as unknown as JsonRpcResponse;
        if (response.error) {
          pending.reject(
            new Error(
              `Codex app-server error ${response.error.code ?? "unknown"}: ${
                response.error.message ?? "unknown error"
              }`,
            ),
          );
        } else {
          pending.resolve(isObject(response.result) ? response.result : {});
        }
        return;
      }

      const serverRequest = parsed as unknown as JsonRpcServerRequest;
      if (typeof serverRequest.method === "string") {
        void this.handleApproval(serverRequest);
      }
      return;
    }

    const notification = parsed as unknown as JsonRpcNotification;
    if (typeof notification.method === "string") {
      this.opts.onNotification(notification.method, isObject(notification.params) ? notification.params : {});
    }
  }

  private async handleApproval(request: JsonRpcServerRequest): Promise<void> {
    try {
      const decision = await this.opts.onApproval(
        request.id,
        request.method,
        isObject(request.params) ? request.params : {},
      );
      this.sendResponse(request.id, { decision });
    } catch {
      this.sendResponse(request.id, { decision: "decline" });
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

class CodexNotificationTranslator {
  private readonly turnById = new Map<string, number>();
  private readonly turnStates = new Map<number, TurnState>();
  private readonly emittedToolUses = new Set<string>();
  private readonly emittedToolResults = new Set<string>();
  private readonly itemText = new Map<string, string>();
  private activeTurn = 0;

  constructor(
    private readonly host: SessionHost,
    private readonly model: string,
  ) {}

  beginTurn(turn: number): void {
    this.activeTurn = turn;
    this.turnStates.set(turn, {
      id: null,
      text: "",
      startedAtMs: Date.now(),
      completed: false,
      waiters: [],
    });
  }

  setTurnId(turn: number, turnId: string | null): void {
    if (!turnId) return;
    const state = this.stateFor(turn);
    state.id = turnId;
    this.turnById.set(turnId, turn);
  }

  waitForTurn(turn: number): Promise<void> {
    const state = this.stateFor(turn);
    if (state.completed) return Promise.resolve();
    return new Promise<void>((resolve) => state.waiters.push(resolve));
  }

  handleNotification(method: string, params: JsonObject): void {
    switch (method) {
      case "turn/started":
        this.handleTurnStarted(params);
        break;
      case "item/agentMessage/delta":
        this.emitTextDelta(params);
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        this.emitReasoningDelta(params);
        break;
      case "item/started":
        this.handleItemStarted(params);
        break;
      case "item/completed":
        this.handleItemCompleted(params);
        break;
      case "rawResponseItem/completed":
        this.handleRawResponseItem(params);
        break;
      case "thread/tokenUsage/updated":
        this.handleUsage(params);
        break;
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "error":
        this.handleError(params);
        break;
      case "warning":
      case "guardianWarning":
      case "configWarning":
        this.handleWarning(params);
        break;
      default:
        break;
    }
  }

  private handleTurnStarted(params: JsonObject): void {
    const turn = isObject(params["turn"]) ? params["turn"] : null;
    const turnId = stringValue(turn?.["id"]) ?? stringValue(params["turnId"]);
    this.setTurnId(this.activeTurn, turnId);
  }

  private emitTextDelta(params: JsonObject): void {
    const delta = stringValue(params["delta"]);
    if (!delta) return;
    const turn = this.turnForParams(params);
    const itemId = stringValue(params["itemId"]);
    if (itemId) this.itemText.set(itemId, (this.itemText.get(itemId) ?? "") + delta);
    this.stateFor(turn).text += delta;
    this.host.emit({ type: "text-delta", block: 0, text: delta }, turn);
  }

  private emitReasoningDelta(params: JsonObject): void {
    const delta = stringValue(params["delta"]);
    if (!delta) return;
    this.host.emit({ type: "reasoning", block: 0, text: delta }, this.turnForParams(params));
  }

  private handleItemStarted(params: JsonObject): void {
    const item = isObject(params["item"]) ? params["item"] : null;
    if (!item) return;
    this.emitToolUseForItem(item, this.turnForParams(params));
  }

  private handleItemCompleted(params: JsonObject): void {
    const item = isObject(params["item"]) ? params["item"] : null;
    if (!item) return;
    const turn = this.turnForParams(params);
    this.emitMissingMessageText(item, turn);
    this.emitToolResultForItem(item, turn);
  }

  private handleRawResponseItem(params: JsonObject): void {
    const item = isObject(params["item"]) ? params["item"] : null;
    if (!item) return;
    const turn = this.turnForParams(params);
    const type = stringValue(item["type"]);
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      const id = stringValue(item["call_id"]) ?? stringValue(item["id"]) ?? `raw-${this.emittedToolUses.size + 1}`;
      if (!this.emittedToolUses.has(id)) {
        const name =
          type === "local_shell_call"
            ? "Bash"
            : stringValue(item["name"]) ?? stringValue(item["namespace"]) ?? type;
        const input =
          type === "function_call"
            ? parseJsonObject(String(item["arguments"] ?? "{}"))
            : { input: item["input"] ?? item["action"] ?? item };
        this.host.emit({ type: "tool_use", block: 0, id, name, input }, turn);
        this.emittedToolUses.add(id);
      }
    }
    if (
      type === "function_call_output" ||
      type === "custom_tool_call_output" ||
      type === "tool_search_output"
    ) {
      const id = stringValue(item["call_id"]) ?? stringValue(item["id"]) ?? `raw-result-${this.emittedToolResults.size + 1}`;
      if (!this.emittedToolResults.has(id)) {
        this.host.emit({
          type: "tool_result",
          tool_use_id: id,
          is_error: false,
          content: stableStringify(item["output"] ?? item),
        }, turn);
        this.emittedToolResults.add(id);
      }
    }
  }

  private handleUsage(params: JsonObject): void {
    const turn = this.turnForParams(params);
    const usage = buildUsageEvent(params, this.model);
    if (!usage) return;
    this.stateFor(turn).usage = usage;
    this.host.emit(usage, turn);
  }

  private handleTurnCompleted(params: JsonObject): void {
    const turnObj = isObject(params["turn"]) ? params["turn"] : null;
    const turnId = stringValue(turnObj?.["id"]) ?? stringValue(params["turnId"]);
    const turn = turnId ? this.turnById.get(turnId) ?? this.activeTurn : this.activeTurn;
    if (turnId) this.setTurnId(turn, turnId);

    const state = this.stateFor(turn);
    const items = Array.isArray(turnObj?.["items"]) ? turnObj["items"] : [];
    for (const item of items) {
      if (isObject(item)) {
        this.emitMissingMessageText(item, turn);
        this.emitToolResultForItem(item, turn);
      }
    }

    const status = stringValue(turnObj?.["status"]) ?? "completed";
    const isError = status !== "completed";
    const durationMs = extractTurnDurationMs(turnObj, Date.now() - state.startedAtMs);
    this.host.emit(
      {
        type: "result",
        subtype: isError ? status : "success",
        is_error: isError,
        text: state.text,
        num_turns: turn,
        duration_ms: durationMs,
      },
      turn,
    );
    state.completed = true;
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private handleError(params: JsonObject): void {
    const err = isObject(params["error"]) ? params["error"] : params;
    const message =
      stringValue(err["message"]) ??
      stringValue(params["message"]) ??
      stableStringify(params);
    this.host.emit({ type: "error", message, fatal: true }, this.turnForParams(params));
  }

  private handleWarning(params: JsonObject): void {
    const message = stringValue(params["message"]);
    if (!message) return;
    this.host.emit({ type: "error", message, fatal: false }, this.turnForParams(params));
  }

  private emitMissingMessageText(item: JsonObject, turn: number): void {
    if (item["type"] === "agentMessage") {
      const id = stringValue(item["id"]) ?? `agent-${turn}`;
      const text = stringValue(item["text"]);
      if (!text) return;
      const previous = this.itemText.get(id) ?? "";
      if (text.length > previous.length) {
        const delta = text.slice(previous.length);
        this.itemText.set(id, text);
        this.stateFor(turn).text += delta;
        this.host.emit({ type: "text-delta", block: 0, text: delta }, turn);
      }
    }
    if (item["type"] === "reasoning") {
      const content = Array.isArray(item["summary"])
        ? item["summary"].filter((v): v is string => typeof v === "string").join("\n")
        : "";
      if (content) this.host.emit({ type: "reasoning", block: 0, text: content }, turn);
    }
  }

  private emitToolUseForItem(item: JsonObject, turn: number): void {
    const id = stringValue(item["id"]);
    if (!id || this.emittedToolUses.has(id)) return;
    const built = this.toolUseFromItem(item, id);
    if (!built) return;
    this.host.emit({ type: "tool_use", block: 0, id, name: built.name, input: built.input }, turn);
    this.emittedToolUses.add(id);
  }

  private emitToolResultForItem(item: JsonObject, turn: number): void {
    const id = stringValue(item["id"]);
    if (!id || this.emittedToolResults.has(id)) return;
    const built = this.toolResultFromItem(item);
    if (!built) return;
    this.emitToolUseForItem(item, turn);
    this.host.emit(
      {
        type: "tool_result",
        tool_use_id: id,
        is_error: built.isError,
        content: built.content,
      },
      turn,
    );
    this.emittedToolResults.add(id);
  }

  private toolUseFromItem(item: JsonObject, id: string): { name: string; input: JsonObject } | null {
    switch (item["type"]) {
      case "commandExecution":
        return {
          name: "Bash",
          input: {
            command: item["command"],
            cwd: item["cwd"],
            source: item["source"],
            commandActions: item["commandActions"],
          },
        };
      case "fileChange":
        return { name: "apply_patch", input: { changes: item["changes"], status: item["status"] } };
      case "mcpToolCall":
        return {
          name: `mcp:${String(item["server"] ?? "server")}.${String(item["tool"] ?? "tool")}`,
          input: {
            server: item["server"],
            tool: item["tool"],
            arguments: item["arguments"],
            pluginId: item["pluginId"],
          },
        };
      case "dynamicToolCall":
        return {
          name: item["namespace"] ? `${String(item["namespace"])}.${String(item["tool"] ?? id)}` : String(item["tool"] ?? id),
          input: { arguments: item["arguments"] },
        };
      case "webSearch":
        return { name: "web_search", input: { query: item["query"], action: item["action"] } };
      case "sleep":
        return { name: "sleep", input: { duration_ms: item["durationMs"] } };
      case "imageGeneration":
        return { name: "image_generation", input: { status: item["status"], revisedPrompt: item["revisedPrompt"] } };
      case "collabAgentToolCall":
        return { name: `agent:${String(item["tool"] ?? id)}`, input: { prompt: item["prompt"], model: item["model"] } };
      case "subAgentActivity":
        return { name: "subagent", input: { kind: item["kind"], agentPath: item["agentPath"] } };
      default:
        return null;
    }
  }

  private toolResultFromItem(item: JsonObject): { isError: boolean; content: string } | null {
    switch (item["type"]) {
      case "commandExecution": {
        const status = stringValue(item["status"]);
        const exitCode = numberValue(item["exitCode"]);
        const isError = status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0);
        const output = stringValue(item["aggregatedOutput"]) ?? "";
        return {
          isError,
          content: [
            `$ ${String(item["command"] ?? "")}`,
            output,
            exitCode === null ? null : `exit_code: ${exitCode}`,
          ]
            .filter((v): v is string => v !== null && v.length > 0)
            .join("\n"),
        };
      }
      case "fileChange": {
        const status = stringValue(item["status"]);
        const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
        const content = changes
          .map((change) => {
            if (!isObject(change)) return stableStringify(change);
            return [`path: ${String(change["path"] ?? "")}`, String(change["diff"] ?? "")].join("\n");
          })
          .join("\n\n");
        return { isError: status === "failed" || status === "declined", content: content || String(status ?? "") };
      }
      case "mcpToolCall": {
        const error = isObject(item["error"]) ? item["error"] : null;
        return {
          isError: error !== null || item["status"] === "failed",
          content: error ? String(error["message"] ?? stableStringify(error)) : stableStringify(item["result"] ?? item["status"]),
        };
      }
      case "dynamicToolCall":
        return {
          isError: item["success"] === false || item["status"] === "failed",
          content: stableStringify(item["contentItems"] ?? item["status"]),
        };
      case "webSearch":
      case "sleep":
      case "imageGeneration":
      case "collabAgentToolCall":
      case "subAgentActivity":
        return { isError: false, content: stableStringify(item) };
      default:
        return null;
    }
  }

  private turnForParams(params: JsonObject): number {
    const turnId = stringValue(params["turnId"]);
    if (turnId) {
      const mapped = this.turnById.get(turnId);
      if (mapped !== undefined) return mapped;
    }
    return this.activeTurn;
  }

  private stateFor(turn: number): TurnState {
    let state = this.turnStates.get(turn);
    if (!state) {
      state = { id: null, text: "", startedAtMs: Date.now(), completed: false, waiters: [] };
      this.turnStates.set(turn, state);
    }
    return state;
  }
}

async function approvalForCodexRequest(
  host: SessionHost,
  permissionMode: PermissionMode,
  method: string,
  params: JsonObject,
): Promise<ApprovalDecision> {
  if (permissionMode === "bypassPermissions") return "accept";

  const toolName = method.includes("fileChange")
    ? "apply_patch"
    : method.includes("commandExecution")
      ? "Bash"
      : method;
  const result = await host.canUseTool(toolName, { method, ...params });
  return result.behavior === "allow" ? "accept" : "decline";
}

export async function runCodexAppServerMode(
  host: SessionHost,
  opts: CodexAppServerModeOptions,
): Promise<void> {
  const translator = new CodexNotificationTranslator(host, opts.model);
  const env: Record<string, string> = {};
  if (opts.apiKey) {
    env["OPENAI_API_KEY"] = opts.apiKey;
    env["AO_OPENAI_API_KEY"] = opts.apiKey;
  }
  const client = new CodexAppServerJsonRpcClient({
    cwd: opts.cwd,
    env,
    onNotification: (method, params) => translator.handleNotification(method, params),
    onApproval: (id, method, params) => approvalForCodexRequest(host, opts.permissionMode, method, params),
  });

  try {
    await client.connect();

    const permissions = permissionModeToCodexPolicy(opts.permissionMode);
    const threadResult = opts.resumeFrom
      ? await client.threadResume(opts.resumeFrom)
      : await client.threadStart({
          model: opts.model,
          modelProvider: "openai",
          cwd: opts.cwd,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: "user",
          sandbox: permissions.sandbox,
          ...(opts.appendSystemPrompt ? { developerInstructions: opts.appendSystemPrompt } : {}),
        });

    const threadId = extractThreadId(threadResult);
    if (!threadId) throw new Error("Codex app-server did not return a thread id");

    const activeModel = stringValue(threadResult["model"]) ?? opts.model;
    host.adoptSession(threadId, activeModel);
    if (opts.resumeFrom) {
      host.emit({ type: "session", subtype: "resumed", session_id: threadId }, 0);
    }
    host.emit(
      {
        type: "session",
        subtype: "init",
        session_id: threadId,
        model: activeModel,
        cwd: opts.cwd,
        permission_mode: opts.permissionMode,
        tools: CODEX_TOOL_NAMES,
      },
      0,
    );

    if (opts.initialPrompt) host.submitTurn(opts.initialPrompt);

    let turn = 0;
    for await (const userMsg of host.input) {
      turn++;
      translator.beginTurn(turn);
      const text = userTextFromSdkMessage(userMsg);
      try {
        const result = await client.turnStart({
          threadId,
          input: [{ type: "text", text }],
          cwd: opts.cwd,
          model: opts.model,
          approvalPolicy: permissions.approvalPolicy,
        });
        const turnId = extractTurnId(result);
        translator.setTurnId(turn, turnId);
        const status = extractTurnStatus(result);
        if (status === "completed" || status === "failed" || status === "interrupted") {
          translator.handleNotification("turn/completed", {
            threadId,
            turn: isObject(result["turn"]) ? result["turn"] : { id: turnId, status },
          });
        }
        await translator.waitForTurn(turn);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.emit({ type: "error", message, fatal: true }, turn);
        host.emit(
          {
            type: "result",
            subtype: "error",
            is_error: true,
            text: "",
            num_turns: turn,
            duration_ms: 0,
          },
          turn,
        );
      }
    }
  } catch (err) {
    host.emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      fatal: true,
    });
  } finally {
    await client.close();
    host.end();
  }
}
