/**
 * Codex Agent Adapter
 *
 * Bridges AgentMesh coordination layer with AO's SessionManager for Codex.
 * Optimized for QA role with structured output parsing.
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

export class CodexAdapter implements AgentMeshAgentAdapter {
  name = "codex";
  displayName = "Codex";

  constructor(private sessionManager: SessionManager) {}

  /**
   * Check if Codex CLI is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      const shell = getShell();
      const command = isWindows() ? "codex.exe" : "codex";
      const commandArgs = shell.args(`${command} --version`);

      const { stdout } = await execFileAsync(shell.cmd, commandArgs, {
        timeout: 5000,
        shell: isWindows() ? true : false,
      });

      const versionMatch = stdout.match(/Codex (\d+\.\d+\.\d+)/);
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
   * Start a Codex session with role context
   */
  async start(config: AgentStartConfig): Promise<AgentSession> {
    const { taskId, role, prompt, branch } = config;

    // Build role-specific prompt (Codex is optimized for QA)
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
   * Send a message to a running Codex session
   */
  async sendMessage(session: AgentSession, message: AgentMessage): Promise<void> {
    const messageText = this.formatMessage(message);
    await this.sessionManager.send(session.aoSessionId, messageText);
  }

  /**
   * Get output from a Codex session with QA verdict parsing
   */
  async getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput> {
    const activityLogPath = await this.getActivityLogPath(session.aoSessionId);

    try {
      const content = await readFile(activityLogPath, "utf-8");
      const lines = content.split("\n");
      const linesToRead = options?.lines || 100;
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
   * Get the current status of a Codex session
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
   * Stop a Codex session
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
   * Build role-specific prompt for Codex (optimized for QA)
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      qa: `You are a QA Engineer agent using Codex. Your job is to test code and validate quality with structured output.

CORE RESPONSIBILITIES:
- Review code for bugs and issues
- Write comprehensive tests
- Run test suites and report results
- Validate edge cases and error handling
- Provide structured QA reports with PASS/FAIL/BLOCKED verdicts

TASK:
${task}

CRITICAL: You must end your response with a structured QA report in this exact JSON format:
\`\`\`json
{
  "verdict": "PASS" | "FAIL" | "BLOCKED",
  "summary": "Brief summary of your findings (1-2 sentences)",
  "findings": [
    {
      "severity": "critical" | "major" | "minor" | "info",
      "category": "category name (e.g., 'logic error', 'missing test', 'security')",
      "message": "detailed description of the issue",
      "file": "path/to/file.ts",
      "line": 123,
      "code": "relevant code snippet"
    }
  ],
  "score": 85
}
\`\`\`

Verdict guidelines:
- PASS: No critical or major issues, all tests pass
- FAIL: Critical or major issues found, tests failing
- BLOCKED: Cannot proceed due to missing dependencies or blocking issues

Severity guidelines:
- critical: Security vulnerabilities, data loss risk, crashes
- major: Functional bugs, missing core features
- minor: UI issues, edge cases, non-critical bugs
- info: Suggestions, optimizations, best practices`,

      builder: `You are a Builder agent using Codex. Your job is to implement features and fix bugs.

TASK:
${task}

Focus on clean, maintainable code and proper testing.`,

      planner: `You are a Planner agent using Codex. Your job is to plan and break down complex tasks.

TASK:
${task}

Provide a step-by-step implementation plan with dependencies and risks.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} agent using Codex.

TASK:
${task}`
    );
  }

  /**
   * Format message for delivery to Codex
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
