/**
 * Task Decomposer — LLM-driven recursive task decomposition.
 *
 * Classifies issues as atomic (one agent can handle it) or composite
 * (needs to be broken into subtasks). Composite tasks are recursively
 * decomposed until all leaves are atomic.
 *
 * Supports multiple LLM providers:
 *   - Anthropic (default) — via @anthropic-ai/sdk
 *   - MiniMax — via OpenAI-compatible API (https://api.minimax.io/v1)
 *
 * Integration: sits upstream of SessionManager.spawn(). When enabled,
 * complex issues are decomposed into child issues before agents are spawned.
 */

import Anthropic from "@anthropic-ai/sdk";

// =============================================================================
// TYPES
// =============================================================================

export type TaskKind = "atomic" | "composite";
export type TaskStatus = "pending" | "decomposing" | "ready" | "running" | "done" | "failed";

/** Supported decomposer LLM providers */
export type DecomposerProvider = "anthropic" | "minimax";

export interface TaskNode {
  id: string; // hierarchical: "1", "1.2", "1.2.3"
  depth: number;
  description: string;
  kind?: TaskKind;
  status: TaskStatus;
  lineage: string[]; // ancestor descriptions root→parent
  children: TaskNode[];
  result?: string;
  issueId?: string; // tracker issue created for this subtask
  sessionId?: string; // AO session working on this task
}

export interface DecompositionPlan {
  id: string;
  rootTask: string;
  tree: TaskNode;
  maxDepth: number;
  phase: "decomposing" | "review" | "approved" | "executing" | "done" | "failed";
  createdAt: string;
  approvedAt?: string;
  parentIssueId?: string;
}

export interface DecomposerConfig {
  /** Enable auto-decomposition for backlog issues (default: false) */
  enabled: boolean;
  /** Max recursion depth (default: 3) */
  maxDepth: number;
  /** Model to use for decomposition (default: claude-sonnet-4-20250514) */
  model: string;
  /** Require human approval before executing decomposed plans (default: true) */
  requireApproval: boolean;
  /**
   * LLM provider to use for decomposition (default: "anthropic").
   * - "anthropic": uses Anthropic SDK (ANTHROPIC_API_KEY)
   * - "minimax": uses MiniMax OpenAI-compatible API (MINIMAX_API_KEY)
   */
  provider?: DecomposerProvider;
}

export const DEFAULT_DECOMPOSER_CONFIG: DecomposerConfig = {
  enabled: false,
  maxDepth: 3,
  model: "claude-sonnet-4-20250514",
  requireApproval: true,
  provider: "anthropic",
};

// =============================================================================
// LINEAGE CONTEXT
// =============================================================================

/** Format the task lineage as an indented hierarchy for LLM context. */
export function formatLineage(lineage: string[], current: string): string {
  const parts = lineage.map((desc, i) => `${"  ".repeat(i)}${i}. ${desc}`);
  parts.push(`${"  ".repeat(lineage.length)}${lineage.length}. ${current}  <-- (this task)`);
  return parts.join("\n");
}

/** Format sibling tasks for awareness context. */
export function formatSiblings(siblings: string[], current: string): string {
  if (siblings.length === 0) return "";
  const lines = siblings.map((s) => (s === current ? `  - ${s}  <-- (you)` : `  - ${s}`));
  return `Sibling tasks being worked on in parallel:\n${lines.join("\n")}`;
}

// =============================================================================
// LLM CLIENT ABSTRACTION
// =============================================================================

/** Internal abstraction for LLM chat completion, allowing multiple providers. */
interface LLMClient {
  chatCompletion(params: {
    model: string;
    maxTokens: number;
    system: string;
    userMessage: string;
  }): Promise<string>;
}

/** Create an Anthropic-backed LLM client. */
function createAnthropicClient(): LLMClient {
  const client = new Anthropic();
  return {
    async chatCompletion({ model, maxTokens, system, userMessage }) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      });
      return res.content[0].type === "text" ? res.content[0].text.trim() : "";
    },
  };
}

/**
 * Strip MiniMax thinking tags from response text.
 * MiniMax M3/M2.7 models may include <think>...</think> blocks in output.
 */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Clamp temperature for MiniMax models.
 * MiniMax accepts temperature in the range [0, 1.0].
 */
function clampTemperature(temp: number): number {
  return Math.max(0, Math.min(1, temp));
}

/** Create a MiniMax-backed LLM client via OpenAI-compatible API. */
function createMiniMaxClient(): LLMClient {
  const apiKey = process.env["MINIMAX_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "MINIMAX_API_KEY environment variable is required when using provider: minimax. " +
        "Get your API key at https://platform.minimaxi.com/",
    );
  }

  const baseURL = process.env["MINIMAX_BASE_URL"] || "https://api.minimax.io/v1";

  return {
    async chatCompletion({ model, maxTokens, system, userMessage }) {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: clampTemperature(0.1),
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`MiniMax API error (${response.status}): ${body}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      return stripThinkingTags(text).trim();
    },
  };
}

/** Create an LLM client for the given provider. */
export function createLLMClient(provider: DecomposerProvider = "anthropic"): LLMClient {
  switch (provider) {
    case "minimax":
      return createMiniMaxClient();
    case "anthropic":
    default:
      return createAnthropicClient();
  }
}

// =============================================================================
// LLM CALLS
// =============================================================================

const CLASSIFY_SYSTEM = `You decide whether a software task is "atomic" or "composite".

- "atomic" = a developer can implement this directly without needing to plan further. It may involve multiple steps, but they're all part of one coherent unit of work.
- "composite" = this clearly contains 2+ independent concerns that should be worked on separately (e.g., backend + frontend, or auth + database + UI).

Decision heuristics:
- If the task names a single feature, endpoint, component, or module: atomic.
- If the task bundles unrelated concerns (e.g., "build auth and set up CI"): composite.
- If you're at depth 2 or deeper in the hierarchy, it is almost certainly atomic — only mark composite if you can name 2+ truly independent deliverables.
- When in doubt, choose atomic. Over-decomposition creates more overhead than under-decomposition.

Respond with ONLY the word "atomic" or "composite". Nothing else.`;

const DECOMPOSE_SYSTEM = `You are a pragmatic task decomposition engine for software projects.

Given a composite task, break it into the MINIMUM number of subtasks needed:
- A simple task might only need 2 subtasks.
- A complex task might need up to 7, but only if each is truly distinct.
- Do NOT pad with extra subtasks. Do NOT create "test and polish" or "define requirements" subtasks.
- Do NOT create subtasks that overlap or restate each other.
- Each subtask should represent real, distinct work.

Think about how an experienced developer would actually split this work.

Respond with a JSON array of strings, each being a subtask description. Example:
["Implement Stripe webhook handler", "Build subscription management UI"]

Nothing else — just the JSON array.`;

async function classifyTask(
  client: LLMClient,
  model: string,
  task: string,
  lineage: string[],
): Promise<TaskKind> {
  const context = formatLineage(lineage, task);
  const text = await client.chatCompletion({
    model,
    maxTokens: 10,
    system: CLASSIFY_SYSTEM,
    userMessage: `Task hierarchy:\n${context}`,
  });

  return text.toLowerCase() === "composite" ? "composite" : "atomic";
}

async function decomposeTask(
  client: LLMClient,
  model: string,
  task: string,
  lineage: string[],
): Promise<string[]> {
  const context = formatLineage(lineage, task);
  const text = await client.chatCompletion({
    model,
    maxTokens: 1024,
    system: DECOMPOSE_SYSTEM,
    userMessage: `Task hierarchy:\n${context}`,
  });

  const jsonMatch = (text || "[]").match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Decomposition failed — no JSON array in response: ${text}`);
  }

  const subtasks = JSON.parse(jsonMatch[0]) as string[];
  if (!Array.isArray(subtasks) || subtasks.length < 2) {
    throw new Error(`Decomposition produced ${subtasks.length} subtasks — need at least 2`);
  }

  return subtasks;
}

// =============================================================================
// TREE OPERATIONS
// =============================================================================

function createTaskNode(
  id: string,
  description: string,
  depth: number,
  lineage: string[],
): TaskNode {
  return { id, depth, description, status: "pending", lineage, children: [] };
}

/** Recursively decompose a task tree (planning phase — no execution). */
async function planTree(
  client: LLMClient,
  model: string,
  task: TaskNode,
  maxDepth: number,
): Promise<TaskNode> {
  const kind = task.depth >= maxDepth ? "atomic" : await classifyTask(client, model, task.description, task.lineage);

  task.kind = kind;

  if (kind === "atomic") {
    task.status = "ready";
    return task;
  }

  task.status = "decomposing";
  const subtaskDescriptions = await decomposeTask(client, model, task.description, task.lineage);

  const childLineage = [...task.lineage, task.description];
  task.children = subtaskDescriptions.map((desc, i) =>
    createTaskNode(`${task.id}.${i + 1}`, desc, task.depth + 1, childLineage),
  );

  // Recurse on children concurrently
  await Promise.all(task.children.map((child) => planTree(client, model, child, maxDepth)));

  task.status = "ready";
  return task;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Create a decomposition plan for a task. */
export async function decompose(
  taskDescription: string,
  config: DecomposerConfig = DEFAULT_DECOMPOSER_CONFIG,
): Promise<DecompositionPlan> {
  const client = createLLMClient(config.provider);
  const tree = createTaskNode("1", taskDescription, 0, []);

  await planTree(client, config.model, tree, config.maxDepth);

  return {
    id: `plan-${Date.now()}`,
    rootTask: taskDescription,
    tree,
    maxDepth: config.maxDepth,
    phase: config.requireApproval ? "review" : "approved",
    createdAt: new Date().toISOString(),
  };
}

/** Collect all leaf (atomic) tasks from a tree. */
export function getLeaves(task: TaskNode): TaskNode[] {
  if (task.children.length === 0) return [task];
  return task.children.flatMap(getLeaves);
}

/** Get sibling task descriptions for a given task. */
export function getSiblings(root: TaskNode, taskId: string): string[] {
  function findParent(node: TaskNode): TaskNode | null {
    for (const child of node.children) {
      if (child.id === taskId) return node;
      const found = findParent(child);
      if (found) return found;
    }
    return null;
  }

  const parent = findParent(root);
  if (!parent) return [];
  return parent.children.filter((c) => c.id !== taskId).map((c) => c.description);
}

/** Format the plan tree as a human-readable string. */
export function formatPlanTree(task: TaskNode, indent = 0): string {
  const prefix = "  ".repeat(indent);
  const kindTag = task.kind === "atomic" ? "[ATOMIC]" : task.kind === "composite" ? "[COMPOSITE]" : "";
  const statusTag = task.status !== "ready" ? ` (${task.status})` : "";
  let line = `${prefix}${task.id}. ${kindTag} ${task.description}${statusTag}`;

  if (task.children.length > 0) {
    const childLines = task.children.map((c) => formatPlanTree(c, indent + 1)).join("\n");
    line += "\n" + childLines;
  }

  return line;
}

/** Propagate done/failed status up the tree. */
export function propagateStatus(task: TaskNode): void {
  if (task.children.length === 0) return;
  task.children.forEach(propagateStatus);
  if (task.children.every((c) => c.status === "done")) {
    task.status = "done";
  } else if (task.children.some((c) => c.status === "failed")) {
    task.status = "failed";
  } else if (task.children.some((c) => c.status === "running" || c.status === "done")) {
    task.status = "running";
  }
}
