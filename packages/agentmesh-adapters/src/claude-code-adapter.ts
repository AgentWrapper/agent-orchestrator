/**
 * Claude Code Agent Adapter
 *
 * Bridges AgentMesh coordination layer with AO's SessionManager for Claude Code.
 * Handles role-based prompt assembly, message delivery, and output capture.
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

export class ClaudeCodeAdapter implements AgentMeshAgentAdapter {
  name = "claude-code";
  displayName = "Claude Code";

  constructor(private sessionManager: SessionManager) {}

  /**
   * Check if Claude Code CLI is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      const shell = getShell();
      const command = isWindows() ? "claude.exe" : "claude";
      const commandArgs = shell.args(`${command} --version`);

      const { stdout } = await execFileAsync(shell.cmd, commandArgs, {
        timeout: 5000,
        shell: isWindows() ? true : false,
      });

      const versionMatch = stdout.match(/Claude Code (\d+\.\d+\.\d+)/);
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
   * Start a Claude Code session with role context
   */
  async start(config: AgentStartConfig): Promise<AgentSession> {
    const { taskId, role, prompt, branch } = config;

    // Build role-specific prompt
    const rolePrompt = this.buildRolePrompt(role, prompt);

    // Spawn session through AO's SessionManager
    const session = await this.sessionManager.spawn({
      projectId: "agentmesh", // AgentMesh uses a virtual project
      issueId: taskId, // Use taskId as issueId for tracking
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
   * Send a message to a running Claude Code session
   */
  async sendMessage(session: AgentSession, message: AgentMessage): Promise<void> {
    const messageText = this.formatMessage(message);
    await this.sessionManager.send(session.aoSessionId, messageText);
  }

  /**
   * Get output from a Claude Code session
   */
  async getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput> {
    // Read the session's activity log
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
   * Get the current status of a Claude Code session
   */
  async getStatus(session: AgentSession): Promise<AgentStatus> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return "exited";
    }

    // Map AO session status to AgentMesh agent status
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
   * Stop a Claude Code session
   */
  async stop(session: AgentSession): Promise<void> {
    await this.sessionManager.kill(session.aoSessionId);
  }

  /**
   * Get session info (cost, tokens, etc.)
   */
  async getSessionInfo(session: AgentSession): Promise<AgentSessionInfo | null> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return null;
    }

    // Claude Code doesn't provide cost/token info by default
    // This would need to be parsed from session output if available
    return {
      summary: aoSession.metadata?.summary as string | undefined,
      costUsd: undefined,
      tokensUsed: undefined,
      turnsCompleted: undefined,
    };
  }

  /**
   * Build role-specific prompt for Claude Code
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      builder: `You are a Builder agent. Your job is to implement features and fix bugs.

CORE RESPONSIBILITIES:
- Read and understand the codebase
- Implement features according to specifications
- Fix bugs with proper root cause analysis
- Write clean, maintainable code
- Run tests to verify your changes
- Create pull requests with clear descriptions

TASK:
${task}

Remember your role as Builder. Focus on your core capabilities: feature implementation, bug fixing, refactoring.`,

      qa: `You are a QA Engineer agent. Your job is to test code and validate quality.

CORE RESPONSIBILITIES:
- Review code for bugs and issues
- Write comprehensive tests
- Run test suites and report results
- Validate edge cases and error handling
- Provide structured QA reports

TASK:
${task}

Remember your role as QA. Focus on your core capabilities: testing, code review, quality validation.

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
\`\`\``,

      planner: `You are a Planner agent. Your job is to plan and break down complex tasks.

CORE RESPONSIBILITIES:
- Analyze complex requirements
- Break down tasks into manageable steps
- Identify dependencies and risks
- Propose implementation approaches
- Estimate effort and complexity

TASK:
${task}

Remember your role as Planner. Focus on your core capabilities: task planning, architecture analysis.`,

      security_reviewer: `You are a Security Reviewer agent. Your job is to review code for security vulnerabilities.

CORE RESPONSIBILITIES:
- Identify security vulnerabilities
- Check for common security issues
- Validate input handling and sanitization
- Review authentication and authorization
- Check for sensitive data exposure

TASK:
${task}

Remember your role as Security Reviewer. Focus on your core capabilities: security analysis, vulnerability detection.`,

      docs_writer: `You are a Documentation Writer agent. Your job is to write and maintain documentation.

CORE RESPONSIBILITIES:
- Write clear, accurate documentation
- Keep documentation in sync with code changes
- Explain complex concepts simply
- Provide examples and usage guides
- Maintain consistency across documentation

TASK:
${task}

Remember your role as Documentation Writer. Focus on your core capabilities: documentation, technical writing.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} agent.

TASK:
${task}`
    );
  }

  /**
   * Format message for delivery to Claude Code
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
