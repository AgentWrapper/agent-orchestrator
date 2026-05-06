/**
 * Agent runtime detection — discovers available agent runtimes via plugin detect() methods.
 *
 * No hardcoded binary paths — relies entirely on each plugin's detect() export.
 */

import type { PluginModule } from "@aoagents/ao-core";
import { isHumanCaller } from "./caller-context.js";
import { promptSelect } from "./prompts.js";

export interface DetectedAgent {
  name: string;
  displayName: string;
}

/** Known agent plugins — package name mapping. */
const AGENT_PLUGINS: Array<{ name: string; pkg: string }> = [
  { name: "claude-code", pkg: "@aoagents/ao-plugin-agent-claude-code" },
  { name: "aider", pkg: "@aoagents/ao-plugin-agent-aider" },
  { name: "codex", pkg: "@aoagents/ao-plugin-agent-codex" },
  { name: "cursor", pkg: "@aoagents/ao-plugin-agent-cursor" },
  { name: "kimicode", pkg: "@aoagents/ao-plugin-agent-kimicode" },
  { name: "opencode", pkg: "@aoagents/ao-plugin-agent-opencode" },
];

/**
 * Discover which agent runtimes are available on this system.
 * Imports each agent plugin and calls its detect() method.
 */
export async function detectAvailableAgents(): Promise<DetectedAgent[]> {
  const available: DetectedAgent[] = [];

  for (const { name, pkg } of AGENT_PLUGINS) {
    try {
      const raw = await import(pkg);
      // Handle both named export and default export shapes
      const mod = (raw.detect ? raw : raw.default) as PluginModule;
      if (typeof mod?.detect === "function" && mod.detect()) {
        available.push({
          name,
          displayName: mod.manifest?.displayName ?? name,
        });
      }
    } catch {
      // Plugin not installed or import failed — skip
    }
  }

  return available;
}

/**
 * Select the agent runtime to use for config generation.
 *
 * - No agents detected → default to "claude-code"
 * - One agent available → auto-select it
 * - Multiple agents available + human caller → prompt to pick
 * - Multiple agents available + non-human → pick first (claude-code if available)
 */
export async function detectAgentRuntime(preDetected?: DetectedAgent[]): Promise<string> {
  const available = preDetected ?? await detectAvailableAgents();

  if (available.length === 0) {
    return "claude-code";
  }

  if (available.length === 1) {
    return available[0].name;
  }

  // Multiple agents available
  if (!isHumanCaller()) {
    // Non-interactive: prefer claude-code if available, else first
    return available.find((a) => a.name === "claude-code")?.name ?? available[0].name;
  }

  return await promptSelect(
    "Choose default agent runtime:",
    available.map((agent) => ({
      value: agent.name,
      label: agent.displayName,
      hint: agent.name,
    }))
  );
}
