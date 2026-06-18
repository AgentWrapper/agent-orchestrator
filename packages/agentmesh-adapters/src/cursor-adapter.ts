/**
 * Cursor Agent Adapter
 *
 * Adapter for Cursor IDE integration with AgentMesh.
 * Monitors .cursor/chat.md file for activity detection.
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
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export class CursorAdapter implements AgentMeshAgentAdapter {
  name = "cursor";
  displayName = "Cursor";

  constructor(private sessionManager: SessionManager) {}

  /**
   * Check if Cursor CLI is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      const shell = getShell();
      const command = isWindows() ? "cursor.exe" : "cursor";
      const commandArgs = shell.args(`${command} --version`);

      const { stdout } = await execFileAsync(shell.cmd, commandArgs, {
        timeout: 5000,
        shell: isWindows() ? true : false,
      });

      const versionMatch = stdout.match(/Cursor (\d+\.\d+\.\d+)/);
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
   * Start a Cursor session with role context
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
   * Send a message to a running Cursor session
   */
  async sendMessage(session: AgentSession, message: AgentMessage): Promise<void> {
    const messageText = this.formatMessage(message);
    await this.sessionManager.send(session.aoSessionId, messageText);
  }

  /**
   * Get output from a Cursor session
   * Uses Cursor-specific .cursor/chat.md file for activity detection
   */
  async getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession || !aoSession.workspacePath) {
      return {
        text: "",
        capturedAt: new Date(),
        linesRead: 0,
      };
    }

    // Try to read Cursor's chat.md file
    const cursorChatPath = join(aoSession.workspacePath, ".cursor", "chat.md");

    try {
      await stat(cursorChatPath);
      const fileContent = await readFile(cursorChatPath, "utf-8");

      // Get last N lines
      const lines = fileContent.split("\n");
      const startLine = Math.max(0, lines.length - (options?.lines || 50));
      const recentLines = lines.slice(startLine).join("\n");

      return {
        text: recentLines,
        capturedAt: new Date(),
        linesRead: lines.length - startLine,
      };
    } catch {
      // Fall back to standard activity log
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
  }

  /**
   * Get the current status of a Cursor session
   * Uses .cursor/chat.md modification time for activity detection
   */
  async getStatus(session: AgentSession): Promise<AgentStatus> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return "exited";
    }

    // Try Cursor-specific activity detection
    if (aoSession.workspacePath) {
      const cursorChatPath = join(aoSession.workspacePath, ".cursor", "chat.md");

      try {
        const fileStats = await stat(cursorChatPath);
        const now = new Date();
        const diffMs = now.getTime() - fileStats.mtime.getTime();

        // If modified within last 30 seconds, consider active
        if (diffMs < 30000) {
          return "active";
        }

        // If modified within last 5 minutes, consider idle
        if (diffMs < 300000) {
          return "idle";
        }
      } catch {
        // File doesn't exist, fall back to AO status
      }
    }

    // Fall back to AO session status
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
   * Stop a Cursor session
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
   * Build role-specific prompt for Cursor
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      builder: `You are a Builder agent using Cursor IDE. Your job is to implement features and fix bugs with Cursor's AI assistance.

CORE RESPONSIBILITIES:
- Use Cursor's AI capabilities for code generation
- Leverage Cursor's context awareness for better suggestions
- Implement features according to specifications
- Fix bugs with proper root cause analysis
- Write clean, maintainable code
- Run tests to verify your changes

TASK:
${task}

Remember you're working in Cursor IDE. Use its features effectively for better development experience.`,

      qa: `You are a QA Engineer agent using Cursor IDE. Your job is to test code and validate quality with Cursor's assistance.

CORE RESPONSIBILITIES:
- Use Cursor's AI to review code for bugs and issues
- Leverage Cursor's context for comprehensive testing
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

      planner: `You are a Planner agent using Cursor IDE. Your job is to plan and break down complex tasks with Cursor's assistance.

CORE RESPONSIBILITIES:
- Use Cursor's AI to analyze complex requirements
- Leverage Cursor's codebase understanding for better planning
- Break down tasks into manageable steps
- Identify dependencies and risks
- Propose implementation approaches
- Estimate effort and complexity

TASK:
${task}

Use Cursor's context awareness to understand the codebase better for more accurate planning.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} agent using Cursor IDE.

TASK:
${task}`
    );
  }

  /**
   * Format message for delivery to Cursor
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
