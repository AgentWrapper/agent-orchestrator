/**
 * Devin Agent Adapter
 *
 * Special adapter for Devin - not a local terminal agent.
 * Works via GitHub issues/PRs/comments instead of spawning processes.
 *
 * Devin roles in AgentMesh: external_reviewer, async_builder, pr_fixer, regression_checker
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
import type { SessionManager } from "@aoagents/ao-core";

export class DevinAdapter implements AgentMeshAgentAdapter {
  name = "devin";
  displayName = "Devin";

  constructor(
    private sessionManager: SessionManager,
    private githubToken?: string,
  ) {}

  /**
   * Check if GitHub API is accessible and Devin is available
   */
  async preflight(_context: PreflightContext): Promise<PreflightResult> {
    try {
      // Check if GitHub token is available
      if (!this.githubToken) {
        // Try to get from environment
        this.githubToken = process.env.GITHUB_TOKEN;
      }

      if (!this.githubToken) {
        return {
          ok: false,
          warnings: ["GitHub token not found. Set GITHUB_TOKEN environment variable."],
        };
      }

      // Test GitHub API access
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!response.ok) {
        return {
          ok: false,
          warnings: ["GitHub API access failed. Check token permissions."],
        };
      }

      await response.json();

      return {
        ok: true,
        version: "github-api",
        warnings: [],
      };
    } catch (error) {
      return {
        ok: false,
        warnings: [`GitHub API check failed: ${String(error)}`],
      };
    }
  }

  /**
   * Start a Devin session by creating a GitHub issue
   * Devin does NOT use SessionManager.spawn() - it's external
   */
  async start(config: AgentStartConfig): Promise<AgentSession> {
    const { taskId, role, prompt, branch } = config;

    // Build role-specific prompt for Devin
    const rolePrompt = this.buildRolePrompt(role, prompt);

    // Create GitHub issue for Devin
    const issue = await this.createGitHubIssue({
      title: `[${role.toUpperCase()}] ${taskId}: ${prompt.substring(0, 50)}...`,
      body: rolePrompt,
      labels: [role, "devin", "agentmesh"],
      assignee: "devin", // Would need to know Devin's GitHub username
    });

    // Create a virtual session in AO for tracking (no actual process)
    const session = await this.sessionManager.spawn({
      projectId: "agentmesh",
      issueId: `GH-${issue.number}`,
      branch,
    });

    return {
      aoSessionId: session.id,
      taskId,
      role,
      startedAt: new Date(),
    };
  }

  /**
   * Send a message to Devin by posting a comment on the GitHub issue
   */
  async sendMessage(_session: AgentSession, _message: AgentMessage): Promise<void> {
    // TODO: Store issue number in session when metadata is supported
  }

  /**
   * Get output from Devin by reading GitHub issue comments and PR description
   */
  async getOutput(_session: AgentSession, _options?: OutputOptions): Promise<AgentOutput> {
    // TODO: Get issue number from session when metadata is supported
    return {
      text: "",
      capturedAt: new Date(),
      linesRead: 0,
    };
  }

  /**
   * Get the current status of a Devin session
   */
  async getStatus(session: AgentSession): Promise<AgentStatus> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return "exited";
    }

    // Use AO session status for now
    if (aoSession.status === "working") {
      return "active";
    } else if (aoSession.status === "idle") {
      return "idle";
    } else if (aoSession.status === "done" || aoSession.status === "terminated") {
      return "exited";
    } else {
      return "ready";
    }
  }

  /**
   * Stop Devin by closing the GitHub issue or unassigning
   */
  async stop(session: AgentSession): Promise<void> {
    await this.sessionManager.kill(session.aoSessionId);
  }

  /**
   * Get session info from GitHub
   */
  async getSessionInfo(session: AgentSession): Promise<AgentSessionInfo | null> {
    const aoSession = await this.sessionManager.get(session.aoSessionId);

    if (!aoSession) {
      return null;
    }

    return {
      summary: `GitHub Issue ${aoSession.issueId}`,
      costUsd: undefined,
      tokensUsed: undefined,
      turnsCompleted: undefined,
    };
  }

  /**
   * Build role-specific prompt for Devin
   */
  private buildRolePrompt(role: string, task: string): string {
    const rolePrompts: Record<string, string> = {
      external_reviewer: `You are an External Reviewer using Devin. Your job is to review code from outside the organization.

CORE RESPONSIBILITIES:
- Review code for quality, security, and best practices
- Provide detailed feedback on PRs
- Suggest improvements and catch edge cases
- Maintain objective, constructive feedback

TASK:
${task}

Please provide your review as a structured response with:
- Overall assessment
- Critical issues (if any)
- Suggestions for improvement
- Approval decision`,

      async_builder: `You are an Async Builder using Devin. Your job is to implement features asynchronously via GitHub.

CORE RESPONSIBILITIES:
- Implement features according to specifications
- Create PRs for review
- Address review comments
- Maintain high code quality

TASK:
${task}

Work asynchronously and update this issue with your progress.`,

      pr_fixer: `You are a PR Fixer using Devin. Your job is to fix issues identified in PR reviews.

CORE RESPONSIBILITIES:
- Address review comments
- Fix failing CI
- Update PR with fixes
- Ensure all checks pass

TASK:
${task}

Focus on the specific issues mentioned in the review.`,

      regression_checker: `You are a Regression Checker using Devin. Your job is to verify that changes don't break existing functionality.

CORE RESPONSIBILITIES:
- Run regression tests
- Check for breaking changes
- Verify backward compatibility
- Report any regressions found

TASK:
${task}

Provide a detailed regression report with any issues found.`,
    };

    return (
      rolePrompts[role] ||
      `You are a ${role} using Devin.

TASK:
${task}`
    );
  }

  /**
   * Format message for GitHub comment
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

  // GitHub API helper methods

  private async createGitHubIssue(data: {
    title: string;
    body: string;
    labels: string[];
    assignee?: string;
  }): Promise<{ number: number }> {
    const repo = this.getRepoFromConfig();
    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`Failed to create GitHub issue: ${response.statusText}`);
    }

    return (await response.json()) as { number: number };
  }

  private async createGitHubComment(issueNumber: number, body: string): Promise<void> {
    const repo = this.getRepoFromConfig();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to create GitHub comment: ${response.statusText}`);
    }
  }

  private async getGitHubIssue(issueNumber: number): Promise<Record<string, unknown>> {
    const repo = this.getRepoFromConfig();
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      headers: {
        Authorization: `Bearer ${this.githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get GitHub issue: ${response.statusText}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  private async getGitHubComments(issueNumber: number): Promise<Record<string, unknown>[]> {
    const repo = this.getRepoFromConfig();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      {
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get GitHub comments: ${response.statusText}`);
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  private async closeGitHubIssue(issueNumber: number): Promise<void> {
    const repo = this.getRepoFromConfig();
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: "closed" }),
    });

    if (!response.ok) {
      throw new Error(`Failed to close GitHub issue: ${response.statusText}`);
    }
  }

  private async getDevinPR(_taskId: string): Promise<Record<string, unknown> | null> {
    // This would search for PRs created by Devin for this task
    return null;
  }

  private getRepoFromConfig(): string {
    // This would get the repo from AO config
    // For now, return placeholder
    return "owner/repo";
  }
}

interface OutputOptions {
  lines?: number;
}
