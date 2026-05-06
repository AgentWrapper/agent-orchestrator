/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. User rules — inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() returns the split between persistent system instructions and
 * task-specific text so callers can route them to agents separately.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

export const BASE_AGENT_PROMPT = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If you're told to take over or continue work on an existing PR, run \`ao session claim-pr <pr-number-or-url>\` from inside this session before making changes.
- If CI fails, the orchestrator will send you the failures — fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments — address each one, push fixes, and reply to the comments.

## Reporting Progress to AO
The orchestrator infers your status from runtime signals, but explicit reports are always preferred — they are accurate and fresh. Run these commands from the session shell (AO_SESSION_ID is pre-set for you):

- \`ao acknowledge\` — run once after reading the initial task so AO knows you picked it up.
- \`ao report working\` — declare you are actively making progress (useful after pauses or long thinking blocks).
- \`ao report waiting\` — you are blocked on something AO cannot unblock on its own (e.g. waiting for a human, external service).
- \`ao report needs-input\` — you need a decision or info from the human before proceeding.
- \`ao report fixing-ci\` — you are working specifically on making CI green again.
- \`ao report addressing-reviews\` — you are working on reviewer-requested changes.
- \`ao report pr-created --pr-url <url>\` / \`draft-pr-created\` / \`ready-for-review\` — declare PR workflow milestones as soon as you create or update the PR.
- \`ao report completed\` — you finished non-coding research or analysis work that doesn't produce a PR.

Rules:
- Do NOT self-report \`done\`, \`terminated\`, or terminal PR states like \`merged\`/\`closed\` — AO owns those transitions via SCM ground truth.
- A fresh report is trusted over weak inference but runtime death, activity-based waiting_input, and SCM events (merged/closed PR, CI failure, reviews) still take precedence.
- Use \`--note "<text>"\` to attach a short rationale when the state change is non-obvious.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.`;

/** Trimmed base prompt for projects without a configured repo/remote. */
export const BASE_AGENT_PROMPT_NO_REPO = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- No remote repository is configured — work locally. PR, CI, and review features are unavailable.

## Reporting Progress to AO
Explicit reports help the orchestrator track your state accurately. Run these from the session shell (AO_SESSION_ID is pre-set):
- \`ao acknowledge\` — run once after reading the initial task.
- \`ao report working\` / \`waiting\` / \`needs-input\` — declare your current phase.
- \`ao report pr-created --pr-url <url>\` or \`draft-pr-created\` / \`ready-for-review\` — declare non-terminal PR workflow events when relevant.
- \`ao report completed\` — finish non-coding research or analysis work.
Do NOT self-report \`done\` or \`terminated\` — AO owns those transitions.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).`;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  if (project.repo) {
    lines.push(`- Repository: ${project.repo}`);
  }
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 */
export function buildPrompt(
  config: PromptBuildConfig,
): { systemPrompt: string; taskPrompt?: string } {
  const userRules = readUserRules(config.project);
  const systemSections: string[] = [];

  // Layer 1: Base prompt is always included for every managed session.
  // Use trimmed prompt when no repo is configured (PR/CI instructions don't apply).
  systemSections.push(config.project.repo ? BASE_AGENT_PROMPT : BASE_AGENT_PROMPT_NO_REPO);

  // Layer 2: Worker sessions are scoped to a single issue, so issue/task
  // context belongs in the system prompt with the rest of the session context.
  systemSections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    systemSections.push(`## Project Rules\n${userRules}`);
  }

  return {
    systemPrompt: systemSections.join("\n\n"),
    taskPrompt: config.userPrompt
      ? config.userPrompt
      : config.issueId
        ? `Work on issue: ${config.issueId}`
        : undefined,
  };
}
