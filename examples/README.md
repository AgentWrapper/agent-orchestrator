# Agent Orchestrator Config Examples

This directory contains example configurations for common use cases.

## Quick Start

Copy an example and customize:

```bash
cp examples/simple-github.yaml agent-orchestrator.yaml
nano agent-orchestrator.yaml  # edit as needed
ao spawn my-app ISSUE-123
```

## Examples

### [simple-github.yaml](./simple-github.yaml)

**Minimal setup with GitHub Issues**

Perfect for getting started. Just specify your repo and you're ready to spawn agents.

Use this if:

- You're working on a single GitHub repository
- You want to use GitHub Issues for task tracking
- You want the simplest possible setup

### [linear-team.yaml](./linear-team.yaml)

**Linear integration**

Integrates with Linear for issue tracking. Requires `LINEAR_API_KEY` environment variable.

Spawns prefer Linear’s **Copy git branch name** (API `branchName`); if absent, AO uses `feat/<issue-id>` as before. To change Linear’s pattern, use **Linear → Settings → Integrations → GitHub → Branch format**.

Use this if:

- Your team uses Linear for project management
- You want agents to update Linear ticket status
- You need custom agent rules per project

### [multi-project.yaml](./multi-project.yaml)

**Multiple repos with different trackers**

Shows how to manage multiple projects with different trackers and notification routing.

Use this if:

- You're managing multiple repositories
- Different projects use different trackers (GitHub Issues vs Linear)
- You want Slack notifications in addition to desktop
- You need different rules per project

### [auto-merge.yaml](./auto-merge.yaml)

**Aggressive automation with auto-merge**

Automatically merges approved PRs with passing CI. Auto-retries CI failures and review comments.

Use this if:

- You trust your agents and CI pipeline
- You want maximum automation
- You want agents to handle routine failures autonomously
- You want escalation only when agents get stuck

### [codex-integration.yaml](./codex-integration.yaml)

**Using Codex instead of Claude Code**

Shows how to use a different AI agent (Codex) instead of the default Claude Code.

Use this if:

- You prefer GPT-4/Codex over Claude
- You need agent-specific configuration
- You're evaluating different AI coding assistants

## Configuration Tips

1. **Start simple** - Use `simple-github.yaml` as a starting point
2. **Add complexity incrementally** - Enable features as you need them
3. **Test with one project first** - Get comfortable before adding multiple projects
4. **Review defaults** - Most sensible defaults are already configured
5. **Use environment variables** - Store API keys in env vars, not config files

## Environment Variables

These environment variables are commonly used:

```bash
# Linear integration
export LINEAR_API_KEY="lin_api_..."

# Slack notifications
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."

# GitHub (usually set by gh CLI)
# export GITHUB_TOKEN="ghp_..."
```

Add these to your shell profile (`~/.zshrc` or `~/.bashrc`) to persist them.

## Next Steps

After copying an example:

1. **Edit the config** - Update repo paths, team IDs, etc.
2. **Validate** - Run `ao start` to check for config errors
3. **Spawn an agent** - Try `ao spawn project-id ISSUE-123`
4. **Monitor** - Use `ao status` or open the dashboard (default http://localhost:3000, configurable via `port:` in config)

See [SETUP.md](../SETUP.md) for detailed configuration reference and troubleshooting.
