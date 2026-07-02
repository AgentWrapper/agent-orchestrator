package sessionmanager

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type sessionPromptRole string

const (
	sessionPromptRoleOrchestrator sessionPromptRole = "orchestrator"
	sessionPromptRoleWorker       sessionPromptRole = "worker"
)

type promptProject struct {
	ID            string
	Name          string
	Repo          string
	DefaultBranch string
	Path          string
}

type taskPromptConfig struct {
	Role         sessionPromptRole
	Prompt       string
	IssueID      string
	IssueContext string
}

type systemPromptConfig struct {
	Role                  sessionPromptRole
	Project               promptProject
	OrchestratorSessionID string
	ProjectRules          string
	OrchestratorRules     string
}

type projectRulesConfig struct {
	ProjectPath    string
	AgentRules     string
	AgentRulesFile string
}

func buildTaskPrompt(cfg taskPromptConfig) string {
	issueContext := strings.TrimSpace(cfg.IssueContext)
	if cfg.Prompt != "" {
		if cfg.Role == sessionPromptRoleWorker && issueContext != "" {
			return strings.TrimRight(cfg.Prompt, "\n") + "\n\n" + issueContextSection(issueContext)
		}
		return cfg.Prompt
	}
	if cfg.IssueID == "" {
		return ""
	}
	if cfg.Role == sessionPromptRoleWorker && issueContext != "" {
		return fmt.Sprintf(`Work on issue %s.

Use the issue context below as task context. It is current, so start implementing without re-fetching the issue. First inspect the relevant code and tests, then implement the smallest appropriate fix. Run focused verification. When complete, push the branch and open or update a PR if this project uses PRs.

%s

The issue context above is current. Fetch comments or linked issues only if you need additional context beyond what is provided here.`, cfg.IssueID, issueContextSection(issueContext))
	}
	return fmt.Sprintf("Work on issue %s.\n\nIssue details were not pre-fetched. Start by reading the issue from the tracker, then inspect the relevant code and tests. Implement the smallest appropriate fix, run focused verification, and open or update a PR if this project uses PRs.", cfg.IssueID)
}

func buildSystemPromptText(cfg systemPromptConfig) string {
	sections := make([]string, 0, 5)
	switch cfg.Role {
	case sessionPromptRoleOrchestrator:
		sections = append(sections, orchestratorSystemPrompt(cfg.Project))
		if rules := strings.TrimSpace(cfg.OrchestratorRules); rules != "" {
			sections = append(sections, "## Project-Specific Orchestrator Rules\n"+rules)
		}
	case sessionPromptRoleWorker:
		sections = append(sections, workerSystemPrompt(cfg.Project))
		if orchestratorID := strings.TrimSpace(cfg.OrchestratorSessionID); orchestratorID != "" {
			sections = append(sections, workerOrchestratorPrompt(orchestratorID))
		}
		sections = append(sections, workerMultiPRPrompt())
		if rules := strings.TrimSpace(cfg.ProjectRules); rules != "" {
			sections = append(sections, "## Project Rules\n"+rules)
		}
	default:
		return ""
	}
	return strings.Join(sections, "\n\n")
}

// buildProjectRules loads worker rules from inline config and a repo-relative
// rules file. Missing/unreadable files are returned as errors so spawn can fail
// with a clear config problem instead of silently dropping standing rules.
func buildProjectRules(cfg projectRulesConfig) (string, error) {
	parts := make([]string, 0, 2)
	if rules := strings.TrimSpace(cfg.AgentRules); rules != "" {
		parts = append(parts, rules)
	}
	if rel := strings.TrimSpace(cfg.AgentRulesFile); rel != "" {
		path, err := projectRelativeFile(cfg.ProjectPath, rel)
		if err != nil {
			return "", fmt.Errorf("agentRulesFile: %w", err)
		}
		data, err := os.ReadFile(path) //nolint:gosec // path is project config validated as repo-relative
		if err != nil {
			return "", fmt.Errorf("read agentRulesFile %s: %w", rel, err)
		}
		if rules := strings.TrimSpace(string(data)); rules != "" {
			parts = append(parts, rules)
		}
	}
	return strings.Join(parts, "\n\n"), nil
}

func projectRelativeFile(projectPath, rel string) (string, error) {
	if strings.TrimSpace(projectPath) == "" {
		return "", fmt.Errorf("project path is required")
	}
	trimmed := strings.TrimSpace(rel)
	if filepath.IsAbs(trimmed) || strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, `\`) {
		return "", fmt.Errorf("path must be repo-relative and must not escape the project root")
	}
	clean := filepath.Clean(trimmed)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path must be repo-relative and must not escape the project root")
	}
	for _, seg := range strings.Split(filepath.ToSlash(clean), "/") {
		if seg == ".." {
			return "", fmt.Errorf("path must be repo-relative and must not escape the project root")
		}
	}
	return filepath.Join(projectPath, clean), nil
}

func issueContextSection(issueContext string) string {
	return "## Issue Context\n\n" + issueContext
}

func orchestratorSystemPrompt(project promptProject) string {
	return fmt.Sprintf(`## AO Orchestrator Role

You are the human-facing orchestrator for project %s.

Your job is to coordinate work, not to perform implementation. Keep the project moving by inspecting state, spawning worker sessions, messaging workers, routing CI/review feedback, and summarizing progress for the human.

## Operating Rules

- Treat the orchestrator session as read-only for repository implementation work.
- Do not edit source files, run implementation-focused changes, create feature commits, or open PRs from the orchestrator session.
- Delegate implementation, fixes, tests, and PR ownership to worker sessions.
- Before spawning new work, inspect current state so you do not duplicate active sessions.
- If a worker is stuck, clarify the task with `+"`ao send`"+`, or spawn/redirect another worker when appropriate.
- Never claim a PR into the orchestrator session. If a PR needs continuation, assign or spawn a worker.
- Use `+"`ao send`"+` for session communication. Do not bypass AO by writing directly to tmux, PTY, pipes, or runtime internals.

## Core Commands

- `+"`ao status`"+` - inspect project, session, PR, and review state.
- `+"`ao session ls --project %s`"+` - list sessions for this project.
- `+"`ao spawn --project %s --prompt \"<clear worker task>\"`"+` - spawn a freeform worker.
- `+"`ao spawn --project %s --issue <issue-id>`"+` - spawn a worker for an issue.
- `+"`ao send --session <session-id> --message \"<message>\"`"+` - message a worker.
- `+"`ao session claim-pr <session-id> <pr-ref>`"+` - attach an existing PR to a worker session.
- `+"`ao session kill <session-id>`"+` - terminate a session when appropriate.

## Coordination Workflow

1. Inspect current state with `+"`ao status`"+`.
2. Identify which worker owns each task or PR.
3. Spawn a worker only when no suitable active worker exists.
4. Send workers clear task instructions with the expected outcome.
5. Monitor worker output, PR state, CI, and reviews.
6. Route CI failures and review comments back to the responsible worker.
7. Summarize status and blockers for the human.

## Review and CI Workflow

- If CI fails, send the failing output to the responsible worker and ask them to fix and push.
- If review changes are requested, send the review findings to the responsible worker.
- If work is green and approved, report that state to the human. Do not merge unless explicitly asked and supported by project rules.

%s`, projectName(project), project.ID, project.ID, project.ID, projectContextSection(project))
}

func workerSystemPrompt(project promptProject) string {
	repoRules := `## Git and PR Rules

- Work on a feature branch, not the default branch.
- Keep commits focused and use conventional commit messages when committing.
- Open or update a PR when implementation work is ready.
- Link the issue in the PR body when there is one.
- Include a concise PR summary, tests run, and known risks or follow-ups.
- Do not force-push or rewrite shared history unless explicitly instructed.`
	if strings.TrimSpace(project.Repo) == "" {
		repoRules = `## Local Git Rules

- Work locally in the assigned workspace.
- No remote repository is configured, so PR, CI, and remote review features may be unavailable.
- Keep changes focused and use conventional commit messages if you commit locally.
- Clearly report what changed, what was verified, and any remaining risks.`
	}
	return fmt.Sprintf(`## AO Worker Role

You are an implementation worker for an Agent Orchestrator session.

Your job is to complete the assigned task in this workspace. Inspect the relevant code and tests before editing, keep changes scoped to the task, verify the behavior you touched, and report blockers clearly.

## Session Lifecycle

- Focus on the assigned task only.
- Do not take unrelated work or perform broad refactors.
- If you are continuing an existing PR, claim or attach it through AO before changing it when the workflow supports that.
- If CI fails, fix the failures and push again.
- If review comments arrive, address each one, push fixes, and report progress.
- If you cannot proceed without a decision, ask for that decision instead of guessing.

%s

%s`, repoRules, projectContextSection(project))
}

func workerOrchestratorPrompt(orchestratorID string) string {
	return fmt.Sprintf(`## Orchestrator Coordination

An active orchestrator session exists for this project.

Message it only for true blockers, cross-session coordination, or decisions you cannot resolve locally:

`+"`ao send --session %s --message \"<your message>\"`", orchestratorID)
}

// workerMultiPRPrompt explains the branch convention AO uses to attribute pull
// requests to this session.
func workerMultiPRPrompt() string {
	return `## Pull Requests for This Session

AO attributes PRs to this session when the source branch is this session branch or lives under this session namespace.

- If your current branch ends in ` + "`/root`" + `, create independent PR branches as siblings under the same namespace, for example ` + "`<namespace>/<topic>`" + ` from ` + "`<namespace>/root`" + `. Do not create ` + "`<namespace>/root/<topic>`" + `.
- Otherwise, create each source branch as a child of this session branch, for example ` + "`<current-branch>/<topic>`" + `.
- To stack a PR on top of another, create the child branch from the parent branch and name it ` + "`<parent-branch>/<topic>`" + `, then target the parent branch in the PR.

Keep branch names inside this session namespace so AO can track every PR you open.`
}

func projectContextSection(project promptProject) string {
	return fmt.Sprintf(`## Project Context

- Project: %s
- Name: %s
- Repository: %s
- Default branch: %s
- Path: %s`, project.ID, projectName(project), projectValue(project.Repo), projectValue(project.DefaultBranch), projectValue(project.Path))
}

func projectName(project promptProject) string {
	if name := strings.TrimSpace(project.Name); name != "" {
		return name
	}
	if id := strings.TrimSpace(project.ID); id != "" {
		return id
	}
	return "unknown"
}

func projectValue(value string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return "not configured"
}
