/**
 * Gemini CLI Agent Adapter
 *
 * Adapter for Google's Gemini CLI (gemini-cli).
 * Optimized for Google's Gemini models with multi-modal capabilities.
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
import type { SessionManager, SessionId } from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GeminiAdapter implements AgentMeshAgentAdapter {
  name = "gemini";
  displayName = "Gemini CLI";

  constructor(private sessionManager: SessionManager) {}

  /**
   * Check if Gemini CLI is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      const { stdout } = await execFileAsync("gemini", ["--version"], {
        timeout: 5000,
      });

      const versionMatch = stdout.match(/Gemini CLI (\d+\.\d+\.\d+)/);
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
   * Start a Gemini session with role context
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
   * Send a message to a running Gemini session
   */
  async sendMessage(session: AgentSession, message: AgentMessage): Promise<void> {
    const messageText = this.formatMessage(message);
    await this.sessionManager.send(session.aoSessionId, messageText);
  }

  /**
   * Get output from a Gemini session
   */
  async getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput> {
    const activityLogPath = this.getActivityLogPath(session.aoSessionId);

    try {
      const { stdout } = await execFileAsync("tail", [
        "-n",
        options?.lines?.toString() || "50",
        activityLogPath,
      ]);

      return {
        text: stdout,
        capturedAt: new Date(),
        linesRead: stdout.split("\n").length,
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
   * Get the current status of a Gemini session
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
   * Stop a Gemini session
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
   * Build role-specific prompt for Gemini
   * Gemini has multi-modal capabilities (text, images, code)
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      builder: `You are a Builder agent using Gemini CLI. Your job is to implement features and fix bugs with Google's multi-modal AI capabilities.

CORE RESPONSIBILITIES:
- Use Gemini's multi-modal understanding for better code analysis
- Leverage Gemini's large context window for comprehensive understanding
- Implement features according to specifications
- Fix bugs with proper root cause analysis
- Write clean, maintainable code
- Run tests to verify your changes
- Use Gemini's code generation capabilities effectively

TASK:
${task}

Remember you're using Gemini CLI. Leverage its multi-modal capabilities and large context window for better development experience.`,

      qa: `You are a QA Engineer agent using Gemini CLI. Your job is to test code and validate quality with Google's multi-modal AI.

CORE RESPONSIBILITIES:
- Use Gemini's multi-modal understanding for comprehensive testing
- Leverage Gemini's large context for better code review
- Write comprehensive tests
- Run test suites and report results
- Validate edge cases and error handling
- Provide structured QA reports

TASK:
${task}

Please end your response with a structured QA report in this format:
{"verdict": "PASS" | "FAIL" | "BLOCKED",
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

Use Gemini's comprehensive understanding to catch subtle issues that other agents might miss.`,

      planner: `You are a Planner agent using Gemini CLI. Your job is to plan and break down complex tasks with Google's large context window.

CORE RESPONSIBILITIES:
- Use Gemini's large context window for comprehensive codebase analysis
- Leverage Gemini's multi-modal understanding for better planning
- Break down tasks into manageable steps
- Identify dependencies and risks
- Propose implementation approaches
- Estimate effort and complexity

TASK:
${task}

Use Gemini's large context to understand the entire codebase context for more accurate planning.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} agent using Gemini CLI.

TASK:
${task}`
    );
  }

  /**
   * Format message for delivery to Gemini
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
  private getActivityLogPath(sessionId: SessionId): string {
    return `/tmp/gemini-activity-${sessionId}.log`;
  }
}

interface OutputOptions {
  lines?: number;
}
