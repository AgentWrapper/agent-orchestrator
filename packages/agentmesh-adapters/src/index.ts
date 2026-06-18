/**
 * AgentMesh Adapters Registry
 *
 * Central registry for agent adapters that bridge AgentMesh coordination layer
 * with AO's SessionManager.
 */

import type { SessionManager } from "@aoagents/ao-core";
import type { AgentMeshAgentAdapter } from "@aoagents/agentmesh-core";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { DevinAdapter } from "./devin-adapter.js";
import { CursorAdapter } from "./cursor-adapter.js";
import { AiderAdapter } from "./aider-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { KimiCodeAdapter } from "./kimicode-adapter.js";

// Export individual adapters for direct instantiation
export { ClaudeCodeAdapter } from "./claude-code-adapter.js";
export { CodexAdapter } from "./codex-adapter.js";
export { DevinAdapter } from "./devin-adapter.js";
export { CursorAdapter } from "./cursor-adapter.js";
export { AiderAdapter } from "./aider-adapter.js";
export { GeminiAdapter } from "./gemini-adapter.js";
export { OpenCodeAdapter } from "./opencode-adapter.js";
export { KimiCodeAdapter } from "./kimicode-adapter.js";

export class AdapterRegistry {
  private adapters: Map<string, (sessionManager: SessionManager) => AgentMeshAgentAdapter>;

  constructor() {
    this.adapters = new Map();
    this.registerBuiltInAdapters();
  }

  private registerBuiltInAdapters(): void {
    this.register("claude-code", (sm) => new ClaudeCodeAdapter(sm));
    this.register("codex", (sm) => new CodexAdapter(sm));
    this.register("devin", (sm) => new DevinAdapter(sm));
    this.register("cursor", (sm) => new CursorAdapter(sm));
    this.register("aider", (sm) => new AiderAdapter(sm));
    this.register("gemini", (sm) => new GeminiAdapter(sm));
    this.register("opencode", (sm) => new OpenCodeAdapter(sm));
    this.register("kimicode", (sm) => new KimiCodeAdapter(sm));
  }

  register(name: string, factory: (sessionManager: SessionManager) => AgentMeshAgentAdapter): void {
    this.adapters.set(name, factory);
  }

  get(name: string, sessionManager: SessionManager): AgentMeshAgentAdapter | null {
    const factory = this.adapters.get(name);
    if (!factory) return null;
    return factory(sessionManager);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

// Singleton instance
export const adapterRegistry = new AdapterRegistry();
