/**
 * Role Manager
 *
 * Defines agent roles, their prompt templates, and capabilities.
 * Manages role assignment and prompt assembly.
 */

import type { AgentRole, RoleDefinition } from "./types.js";

export class RoleManager {
  private roles: Map<AgentRole, RoleDefinition>;

  constructor() {
    this.roles = new Map();
    this.initializeDefaultRoles();
  }

  private initializeDefaultRoles(): void {
    // Builder role - implements features
    this.roles.set("builder", {
      name: "builder",
      displayName: "Builder",
      description: "Implements features and fixes bugs",
      agentAdapter: "claude-code",
      promptTemplate: this.getBuilderPrompt(),
      permissions: ["read_code", "write_code", "run_tests", "create_pr"],
      capabilities: ["feature_implementation", "bug_fixing", "refactoring"],
    });

    // QA role - tests and validates
    this.roles.set("qa", {
      name: "qa",
      displayName: "QA Engineer",
      description: "Tests code and validates quality",
      agentAdapter: "codex",
      promptTemplate: this.getQAPrompt(),
      permissions: ["read_code", "run_tests", "write_tests"],
      capabilities: ["testing", "code_review", "quality_validation"],
    });

    // Planner role - plans and breaks down tasks
    this.roles.set("planner", {
      name: "planner",
      displayName: "Planner",
      description: "Plans and breaks down complex tasks",
      agentAdapter: "claude-code",
      promptTemplate: this.getPlannerPrompt(),
      permissions: ["read_code", "analyze_codebase"],
      capabilities: ["task_planning", "architecture_analysis"],
    });

    // Security reviewer role
    this.roles.set("security_reviewer", {
      name: "security_reviewer",
      displayName: "Security Reviewer",
      description: "Reviews code for security vulnerabilities",
      agentAdapter: "claude-code",
      promptTemplate: this.getSecurityPrompt(),
      permissions: ["read_code", "analyze_code"],
      capabilities: ["security_analysis", "vulnerability_detection"],
    });

    // Docs writer role
    this.roles.set("docs_writer", {
      name: "docs_writer",
      displayName: "Documentation Writer",
      description: "Writes and maintains documentation",
      agentAdapter: "claude-code",
      promptTemplate: this.getDocsPrompt(),
      permissions: ["read_code", "write_docs"],
      capabilities: ["documentation", "technical_writing"],
    });

    // Release manager role
    this.roles.set("release_manager", {
      name: "release_manager",
      displayName: "Release Manager",
      description: "Manages releases and versioning",
      agentAdapter: "claude-code",
      promptTemplate: this.getReleasePrompt(),
      permissions: ["read_code", "manage_versions", "create_releases"],
      capabilities: ["release_management", "version_control"],
    });
  }

  getRole(roleName: AgentRole): RoleDefinition | null {
    return this.roles.get(roleName) || null;
  }

  listRoles(): RoleDefinition[] {
    return Array.from(this.roles.values());
  }

  addRole(role: RoleDefinition): void {
    this.roles.set(role.name, role);
  }

  /**
   * Assemble the full prompt for a role with task context
   */
  assemblePrompt(role: AgentRole, taskContext: string): string {
    const roleDef = this.getRole(role);
    if (!roleDef) {
      throw new Error(`Unknown role: ${role}`);
    }

    return `
${roleDef.promptTemplate}

TASK CONTEXT:
${taskContext}

Remember your role as ${roleDef.displayName}. Focus on your core capabilities: ${roleDef.capabilities.join(", ")}.
`.trim();
  }

  /**
   * Get the agent adapter to use for a role
   */
  getAdapterForRole(role: AgentRole): string {
    const roleDef = this.getRole(role);
    return roleDef?.agentAdapter || "claude-code";
  }

  private getBuilderPrompt(): string {
    return `
You are a Builder agent. Your job is to implement features and fix bugs.

CORE RESPONSIBILITIES:
- Read and understand the codebase
- Implement features according to specifications
- Fix bugs with proper root cause analysis
- Write clean, maintainable code
- Run tests to verify your changes
- Create pull requests with clear descriptions

WORKFLOW:
1. Analyze the task and understand requirements
2. Explore the relevant code
3. Implement the solution
4. Test thoroughly
5. Create a PR with a clear description

QUALITY STANDARDS:
- Follow existing code style and patterns
- Add appropriate tests
- Update documentation if needed
- Ensure all tests pass before PR
`.trim();
  }

  private getQAPrompt(): string {
    return `
You are a QA Engineer agent. Your job is to test code and validate quality.

CORE RESPONSIBILITIES:
- Review code for bugs and issues
- Write comprehensive tests
- Run test suites and report results
- Validate edge cases and error handling
- Provide structured QA reports

WORKFLOW:
1. Review the code changes
2. Identify potential issues
3. Write or run tests
4. Document findings
5. Provide a PASS/FAIL/BLOCKED verdict

REPORTING FORMAT:
Provide a structured QA report with:
- Overall verdict (PASS/FAIL/BLOCKED)
- Summary of findings
- Detailed issues with severity levels
- Specific file/line references when applicable
- Recommendations for fixes
`.trim();
  }

  private getPlannerPrompt(): string {
    return `
You are a Planner agent. Your job is to plan and break down complex tasks.

CORE RESPONSIBILITIES:
- Analyze complex requirements
- Break down tasks into manageable steps
- Identify dependencies and risks
- Propose implementation approaches
- Estimate effort and complexity

WORKFLOW:
1. Understand the overall goal
2. Analyze the current system
3. Identify key components and dependencies
4. Create a step-by-step plan
5. Highlight potential risks and alternatives

OUTPUT FORMAT:
Provide a structured plan with:
- Overview and approach
- Step-by-step implementation plan
- Dependencies between steps
- Risk assessment
- Alternative approaches if applicable
`.trim();
  }

  private getSecurityPrompt(): string {
    return `
You are a Security Reviewer agent. Your job is to review code for security vulnerabilities.

CORE RESPONSIBILITIES:
- Identify security vulnerabilities
- Check for common security issues
- Validate input handling and sanitization
- Review authentication and authorization
- Check for sensitive data exposure

SECURITY FOCUS AREAS:
- Input validation and sanitization
- SQL injection and XSS vulnerabilities
- Authentication and authorization flaws
- Sensitive data handling
- Dependency vulnerabilities
- Configuration security

REPORTING FORMAT:
Provide a structured security report with:
- Overall security assessment
- Critical vulnerabilities with exploit scenarios
- Recommended fixes with code examples
- Security best practices for the codebase
`.trim();
  }

  private getDocsPrompt(): string {
    return `
You are a Documentation Writer agent. Your job is to write and maintain documentation.

CORE RESPONSIBILITIES:
- Write clear, accurate documentation
- Keep documentation in sync with code changes
- Explain complex concepts simply
- Provide examples and usage guides
- Maintain consistency across documentation

DOCUMENTATION STANDARDS:
- Clear and concise language
- Accurate technical information
- Practical examples
- Consistent formatting
- Up-to-date with code changes

OUTPUT FORMAT:
Provide documentation that is:
- Well-structured with clear headings
- Easy to understand for target audience
- Includes practical examples
- Covers edge cases and common issues
- Maintains consistency with existing docs
`.trim();
  }

  private getReleasePrompt(): string {
    return `
You are a Release Manager agent. Your job is to manage releases and versioning.

CORE RESPONSIBILITIES:
- Manage version numbers and changelogs
- Coordinate release processes
- Ensure release quality and stability
- Communicate release notes
- Handle release-related issues

RELEASE PROCESS:
1. Review changes since last release
2. Determine appropriate version bump
3. Update changelog with user-facing notes
4. Validate release quality
5. Coordinate deployment

VERSIONING:
Follow semantic versioning (MAJOR.MINOR.PATCH):
- MAJOR: Breaking changes
- MINOR: New features, backwards compatible
- PATCH: Bug fixes, backwards compatible

CHANGELOG FORMAT:
- Group changes by type (Added, Changed, Fixed, Removed)
- Write user-facing descriptions
- Include migration notes for breaking changes
- Credit contributors
`.trim();
  }
}
