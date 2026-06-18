/**
 * OpenCode Agent Adapter
 *
 * Adapter for OpenCode - open-source AI coding assistant.
 * Optimized for open-source project workflows and community-driven development.
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

export class OpenCodeAdapter implements AgentMeshAgentAdapter {
  name = "opencode";
  displayName = "OpenCode";

  constructor(private sessionManager: SessionManager) {}

  /**
   * Check if OpenCode CLI is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      const { stdout } = await execFileAsync("opencode", ["--version"], {
        timeout: 5000,
      });

      const versionMatch = stdout.match(/OpenCode (\d+\.\d+\.\d+)/);
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
   * Start an OpenCode session with role context
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
   * Send a message to a running OpenCode session
   */
  async sendMessage(session: AgentSession, message: AgentMessage): Promise<void> {
    const messageText = this.formatMessage(message);
    await this.sessionManager.send(session.aoSessionId, messageText);
  }

  /**
   * Get output from an OpenCode session
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
   * Get the current status of an OpenCode session
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
   * Stop an OpenCode session
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
   * Build role-specific prompt for OpenCode
   * OpenCode is optimized for open-source workflows
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      builder: `You are a Builder agent using OpenCode. Your job is to implement features and fix bugs with open-source best practices.

CORE RESPONSIBILITIES:
- Follow open-source contribution guidelines
- Write clean, well-documented code
- Implement features according to specifications
- Fix bugs with proper root cause analysis
- Ensure code is accessible to community contributors
- Run tests to verify your changes
- Follow project-specific coding standards

TASK:
${task}

Remember you're working in an open-source context. Follow community standards and best practices.`,

      qa: `You are a QA Engineer agent using OpenCode. Your job is to test code and validate quality with open-source standards.

CORE RESPONSIBILITIES:
- Review code for open-source best practices
- Write comprehensive tests
- Run test suites and report results
- Validate edge cases and error handling
- Ensure code is accessible and maintainable
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

Focus on open-source quality standards and community maintainability.`,

      planner: `You are a Planner agent using OpenCode. Your job is to plan and break down complex tasks with open-source considerations.

CORE RESPONSIBILITIES:
- Consider open-source contribution guidelines
- Plan for community review and feedback
- Break down tasks into manageable steps
- Identify dependencies and risks
- Propose implementation approaches
- Estimate effort and complexity

TASK:
${task}

Consider open-source workflows, community contribution patterns, and maintainability in your planning.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} agent using OpenCode.

TASK:
${task}`
    );
  }

  /**
   * Format message for delivery to OpenCode
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
    return `/tmp/opencode-activity-${sessionId}.log`;
  }
}

interface OutputOptions {
  lines?: number;
}
