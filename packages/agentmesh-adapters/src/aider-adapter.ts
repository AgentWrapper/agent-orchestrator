/**
 * Aider Agent Adapter
 *
 * Adapter for Aider - Git-aware AI coding assistant.
 * Optimized for automated commit workflows and git operations.
 */

import type {
  AgentMeshAgentAdapter,
  PreflightContext,
  PreflightResult,
  AgentStartConfig,
  AgentSession,
  AgentMessage,
  AgentOutput,
  AgentStatus,
  AgentSessionInfo,
} from "@aoagents/agentmesh-core";
import {
  type SessionManager,
  type SessionId,
  getShell,
  isWindows,
  getActivityLogPath,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export class AiderAdapter implements AgentMeshAgentAdapter {
  name = "aider";
  displayName = "Aider";

  constructor(private sessionManager: SessionManager) {}

  /**
   * Check if Aider CLI is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      const shell = getShell();
      const command = isWindows() ? "aider.exe" : "aider";
      const commandArgs = shell.args(`${command} --version`);

      const { stdout } = await execFileAsync(shell.cmd, commandArgs, {
        timeout: 5000,
        shell: isWindows() ? true : false,
      });

      const versionMatch = stdout.match(/Aider (\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : "unknown";

      return {
        ok: true,
        version,
        warnings: [],
      };
    } catch {
      return {
        ok: false,
        warnings: [],
      };
    }
  }

  /**
   * Start an Aider session with role context
   */
  async start(config: AgentStartConfig): Promise<AgentSession> {
    const { taskId, role, prompt, branch } = config;

    // Build role-specific prompt
    const rolePrompt = this.buildRolePrompt(role, prompt);

    // Spawn session through AO's SessionManager
    const session = await this.sessionManager.spawn({
      projectId: "agentmesh",
      issueId: taskId,
      branch,
    });

    // Send the role-specific prompt to the session
    await this.sessionManager.send(session.id, rolePrompt);

    return {
      aoSessionId: session.id,
      taskId,
      role,
      startedAt: new Date(),
    };
  }

  /**
   * Send a message to a running Aider session
   */
  async sendMessage(session: AgentSession, message: AgentMessage): Promise<void> {
    const messageText = this.formatMessage(message);
    await this.sessionManager.send(session.aoSessionId, messageText);
  }

  /**
   * Get output from an Aider session
   */
  async getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput> {
    const activityLogPath = await this.getActivityLogPath(session.aoSessionId);

    try {
      const content = await readFile(activityLogPath, "utf-8");
      const lines = content.split("\n");
      const linesToRead = options?.lines || 50;
      const tailLines = lines.slice(-linesToRead).join("\n");

      return {
        text: tailLines,
        capturedAt: new Date(),
        linesRead: tailLines.split("\n").length,
      };
    } catch {
      return {
        text: "",
        capturedAt: new Date(),
        linesRead: 0,
      };
    }
  }

  /**
   * Get the current status of an Aider session
   */
  async getStatus(session: AgentSession): Promise<AgentStatus> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return "exited";
    }

    switch (aoSession.status) {
      case "working":
        return "active";
      case "idle":
        return "idle";
      case "needs_input":
        return "waiting_input";
      case "stuck":
        return "blocked";
      case "done":
      case "terminated":
        return "exited";
      default:
        return "ready";
    }
  }

  /**
   * Stop an Aider session
   */
  async stop(session: AgentSession): Promise<void> {
    await this.sessionManager.kill(session.aoSessionId);
  }

  /**
   * Get session info
   */
  async getSessionInfo(session: AgentSession): Promise<AgentSessionInfo | null> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return null;
    }

    return {
      summary: aoSession.metadata?.summary as string | undefined,
      costUsd: undefined,
      tokensUsed: undefined,
      turnsCompleted: undefined,
    };
  }

  /**
   * Build role-specific prompt for Aider
   * Aider is optimized for git-aware coding and automated commits
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      builder: `You are a Builder agent using Aider. Your job is to implement features and fix bugs with git-aware assistance.

CORE RESPONSIBILITIES:
- Use Aider's git-aware capabilities for better context
- Leverage Aider's automatic commit suggestions
- Implement features according to specifications
- Fix bugs with proper root cause analysis
- Write clean, maintainable code
- Use Aider's commit message generation
- Run tests to verify your changes

TASK:
${task}

Aider will help you with git operations and commit messages. Use its git awareness effectively.`,

      qa: `You are a QA Engineer agent using Aider. Your job is to test code and validate quality with git-aware assistance.

CORE RESPONSIBILITIES:
- Use Aider's git context for comprehensive testing
- Leverage Aider's ability to see git history for better analysis
- Write comprehensive tests
- Run test suites and report results
- Validate edge cases and error handling
- Provide structured QA reports

TASK:
${task}

Please end your response with a structured QA report in this format:
\`\`\`json
{
  "verdict": "PASS" | "FAIL" | "BLOCKED",
  "summary": "Brief summary of findings",
  "findings": [
    {
      "severity": "critical" | "major" | "minor" | "info",
      "category": "category name",
      "message": "description of the issue",
      "file": "path/to/file.ts",
      "line": 123
    }
  ]
}
\`\``,

      planner: `You are a Planner agent using Aider. Your job is to plan and break down complex tasks with git-aware assistance.

CORE RESPONSIBILITIES:
- Use Aider's git history analysis for better planning
- Leverage Aider's codebase understanding through git
- Break down tasks into manageable steps
- Identify dependencies and risks
- Propose implementation approaches
- Estimate effort and complexity

TASK:
${task}

Use Aider's git awareness to understand the codebase history and context for more accurate planning.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} agent using Aider.

TASK:
${task}`
    );
  }

  /**
   * Format message for delivery to Aider
   */
  private formatMessage(message: AgentMessage): string {
    let text = message.body;

    if (message.attachments) {
      text += "\n\nAttachments:\n";
      for (const [key, value] of Object.entries(message.attachments)) {
        text += `${key}: ${value}\n`;
      }
    }

    return text;
  }

  /**
   * Get the activity log path for a session
   */
  private async getActivityLogPath(sessionId: SessionId): Promise<string> {
    const session = await this.sessionManager.get(sessionId);
    if (!session || !session.workspacePath) {
      throw new Error(`Session ${sessionId} not found or has no workspace path`);
    }
    return getActivityLogPath(session.workspacePath);
  }
}

interface OutputOptions {
  lines?: number;
}
