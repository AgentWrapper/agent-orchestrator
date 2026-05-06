# Agent Orchestrator Setup Guide

Comprehensive guide to installing, configuring, and troubleshooting Agent Orchestrator.

## Prerequisites

### Required

- **Node.js 20+** - Runtime for the orchestrator and CLI

  ```bash
  node --version  # Should be v20.0.0 or higher
  ```

- **Git 2.25+** - For repository management and worktrees

  ```bash
  git --version
  ```

- **tmux** (for tmux runtime) - Terminal multiplexer for session management

  ```bash
  tmux -V

  # Install on macOS
  brew install tmux

  # Install on Ubuntu/Debian
  sudo apt install tmux

  # Install on Fedora/RHEL
  sudo dnf install tmux
  ```

- **GitHub CLI** (for GitHub integration) - Required for PR creation, issue management

  ```bash
  gh --version

  # Install on macOS
  brew install gh

  # Install on Linux
  # See: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  ```

### Optional

- **Linear API Key** - If using Linear for issue tracking
  - Get it from: https://linear.app/settings/api
  - Set environment variable: `export LINEAR_API_KEY="lin_api_..."`

- **Slack Webhook** - If using Slack notifications
  - Create incoming webhook: https://api.slack.com/messaging/webhooks
  - Set environment variable: `export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."`

## Installation

### Install via npm (recommended)

```bash
npm install -g @aoagents/ao

# Verify
ao --version
```

This installs the `ao` CLI globally along with all default plugins and the web dashboard.

**Permission denied (EACCES)?** This is common on macOS. Three options:

```bash
# Option 1: Use sudo
sudo npm install -g @aoagents/ao

# Option 2: Use npx (no global install needed)
npx @aoagents/ao start

# Option 3: Fix npm permissions permanently (recommended)
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
npm install -g @aoagents/ao
```

### Build from Source (for contributors)

If you want to develop or contribute to Agent Orchestrator:

```bash
# Clone the repository
git clone https://github.com/ComposioHQ/agent-orchestrator
cd agent-orchestrator

# Run the setup script (installs deps, builds, links CLI)
bash scripts/setup.sh

# Verify
ao --version
```

The setup script handles pnpm installation, dependency resolution, building all packages, and linking the `ao` command globally (with automatic permission handling on macOS).

## First-Time Setup

### `ao start` — the only command you need

`ao start` handles everything: auto-detecting your project, generating config, and launching the dashboard + orchestrator. There are three ways to use it:

**From a URL (fastest for any repo):**

```bash
ao start https://github.com/your-org/your-repo
```

This clones the repo, auto-detects language/framework/branch, generates `agent-orchestrator.yaml`, and starts everything. Supports GitHub, GitLab, and Bitbucket (HTTPS and SSH):

```bash
ao start https://github.com/owner/repo
ao start https://gitlab.com/org/project
ao start git@github.com:owner/repo.git
```

**From a local repo (zero prompts):**

```bash
cd ~/your-project
ao start
```

Auto-detects git remote, default branch, language, and available agent runtimes. Generates config and starts.

**Adding more projects:**

```bash
ao start ~/path/to/another-repo
```

If a config already exists, the new project is appended. If not, one is created first.

### What `ao start` detects automatically

- **Git remote** — parses `owner/repo` from origin
- **Default branch** — checks symbolic-ref, GitHub API, then common names (main/master)
- **Project type** — language, framework, test runner, package manager
- **Agent runtime** — which AI agents are installed (Claude Code, Codex, Aider, OpenCode)
- **Free port** — if configured port is busy, auto-finds the next available
- **tmux** — warns if not installed
- **GitHub CLI** — checks `gh auth status`

### Manual Configuration

If you prefer to write the config by hand:

```bash
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
nano agent-orchestrator.yaml
```

Or start from an example:

```bash
cp examples/simple-github.yaml agent-orchestrator.yaml
nano agent-orchestrator.yaml
```

## Configuration Reference

### Minimal Configuration

The absolute minimum needed (everything else has sensible defaults):

```yaml
projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
```

`ao start` generates this automatically — you only need to write it manually if you want full control.

### Full Configuration Schema

See [agent-orchestrator.yaml.example](./agent-orchestrator.yaml.example) for a fully commented example with all options.

### Plugin Slots

Agent Orchestrator has 8 plugin slots. All are swappable:

| Slot          | Purpose              | Default       | Alternatives                                    |
| ------------- | -------------------- | ------------- | ----------------------------------------------- |
| **Runtime**   | How sessions run     | `tmux`        | `process`, `docker`, `kubernetes`, `ssh`, `e2b` |
| **Agent**     | AI coding assistant  | `claude-code` | `codex`, `aider`, `goose`, custom               |
| **Workspace** | Workspace isolation  | `worktree`    | `clone`, `copy`                                 |
| **Tracker**   | Issue tracking       | `github`      | `linear`, `jira`, custom                        |
| **SCM**       | Source control       | `github`      | GitLab, Bitbucket (future)                      |
| **Notifier**  | Notifications        | `desktop`     | `slack`, `discord`, `webhook`, `email`          |
| **Terminal**  | Terminal integration | `iterm2`      | `web`, custom                                   |
| **Lifecycle** | Session lifecycle    | (core)        | Non-pluggable                                   |

### Reactions

Reactions are auto-responses to events. Configure how the orchestrator handles common scenarios:

#### CI Failed

```yaml
reactions:
  ci-failed:
    auto: true # Enable auto-handling
    action: send-to-agent # Send failure logs to agent
    retries: 2 # Retry up to 2 times
    escalateAfter: 2 # Notify human after 2 failures
```

#### Changes Requested (Review Comments)

```yaml
reactions:
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m # Notify human if not resolved in 30 minutes
```

#### Approved and Green (Auto-merge)

```yaml
reactions:
  approved-and-green:
    auto: true # Enable auto-merge
    action: auto-merge # Merge when approved + CI passes
    priority: action # Notification priority
```

**Warning:** Only enable auto-merge if you trust your CI pipeline and agents!

#### Agent Stuck

```yaml
reactions:
  agent-stuck:
    threshold: 10m # Consider stuck after 10 minutes of inactivity
    action: notify
    priority: urgent
```

### Notification Routing

Route notifications by priority:

```yaml
notificationRouting:
  urgent: [desktop, slack] # Agent stuck, needs input, errored
  action: [desktop, slack] # PR ready to merge
  warning: [slack] # Auto-fix failed
  info: [slack] # Summary, all done
```

### Agent Rules

Inline rules included in every agent prompt:

```yaml
projects:
  my-app:
    agentRules: |
      Always run tests before pushing.
      Use conventional commits (feat:, fix:, chore:).
      Link issue numbers in commit messages.
```

Or reference an external file:

```yaml
projects:
  my-app:
    agentRulesFile: .agent-rules.md
```

### Per-Project Overrides

Override defaults per project:

```yaml
projects:
  frontend:
    runtime: tmux
    agent: claude-code
    workspace: worktree

  backend:
    runtime: docker # Use Docker for backend
    agent: codex # Use Codex instead of Claude
```

## Integration Guides

### GitHub Issues

**Authentication:**

```bash
gh auth login
```

**Required scopes:**

- `repo` - Full repository access
- `read:org` - Read organization membership (for team mentions)

**Verification:**

```bash
gh auth status
```

### Linear

**Setup:**

1. Get your API key: https://linear.app/settings/api
2. Add to environment:

   ```bash
   echo 'export LINEAR_API_KEY="lin_api_..."' >> ~/.zshrc
   source ~/.zshrc
   ```

3. Find your team ID:
   - Go to https://linear.app/settings/api
   - Click "Create new key" or use existing key
   - Team ID is visible in your Linear workspace URL or via API

4. Configure in `agent-orchestrator.yaml`:
   ```yaml
   projects:
     my-app:
       tracker:
         plugin: linear
         teamId: "your-team-id"
   ```

**Branch names:** On `ao spawn <issue>` with the Linear tracker, AO **prefers** Linear’s branch name (same as **Copy git branch name**, API field `branchName`). If that value is missing, it **falls back** to the previous convention: `feat/<ISSUE-ID>` (e.g. `feat/INT-123`). To change how Linear generates `branchName`, use **Linear → Settings → Integrations → GitHub → Branch format**.

**Verification:**

```bash
echo $LINEAR_API_KEY  # Should print your key
```

### Slack

**Setup:**

1. Create incoming webhook: https://api.slack.com/messaging/webhooks
2. Add to environment:

   ```bash
   echo 'export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."' >> ~/.zshrc
   source ~/.zshrc
   ```

3. Configure in `agent-orchestrator.yaml`:
   ```yaml
   notifiers:
     slack:
       plugin: slack
       webhook: ${SLACK_WEBHOOK_URL}
       channel: "#agent-updates"
   ```

**Verification:**

```bash
# Send test message
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Agent Orchestrator test"}' \
  $SLACK_WEBHOOK_URL
```

### Custom Trackers

To add a custom tracker (Jira, Asana, etc.), create a plugin:

1. See plugin examples in `packages/plugins/tracker-*/`
2. Implement the `Tracker` interface from `@aoagents/ao-core`
3. Register your plugin in the config

See [Development Guide](./docs/DEVELOPMENT.md) for plugin development guidelines.

## Troubleshooting

### Run `ao doctor`

Use the built-in doctor before debugging a broken install by hand:

```bash
ao doctor
ao doctor --fix
```

`ao doctor` reports deterministic PASS/WARN/FAIL checks for PATH and launcher resolution, required binaries, tmux and GitHub CLI health, stale AO temp files, config support directories, and core build/runtime sanity. `--fix` only applies safe fixes such as creating missing AO support directories, refreshing the local launcher link, and removing stale AO temp files.

### Run `ao update`

When you installed AO from this repository and want to refresh that local install:

```bash
git switch main
ao update
```

`ao update` is intentionally conservative: it requires a clean working tree on `main`, fast-forwards from `origin/main`, reinstalls dependencies, clean-rebuilds the critical core/CLI/web packages, refreshes the launcher with `npm link`, and runs CLI smoke tests. Use `ao update --skip-smoke` to stop after rebuild, or `ao update --smoke-only` to rerun just the smoke checks.

### "No agent-orchestrator.yaml found"

**Problem:** The orchestrator can't find your config file.

**Solution:**

```bash
# ao start auto-creates the config if none exists
ao start

# Or copy an example and edit manually
cp examples/simple-github.yaml agent-orchestrator.yaml
```

### "tmux not found"

**Problem:** tmux is not installed (required for tmux runtime).

**Solution:**

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Fedora/RHEL
sudo dnf install tmux
```

### "gh auth failed"

**Problem:** GitHub CLI is not authenticated.

**Solution:**

```bash
gh auth login

# Select:
# - GitHub.com (not Enterprise)
# - HTTPS (recommended)
# - Authenticate with browser
# - Include repo scope
```

**Verify:**

```bash
gh auth status
```

### "LINEAR_API_KEY not found"

**Problem:** Linear API key is not set in environment.

**Solution:**

```bash
# Get your key from: https://linear.app/settings/api

# Add to shell profile
echo 'export LINEAR_API_KEY="lin_api_..."' >> ~/.zshrc
source ~/.zshrc

# Verify
echo $LINEAR_API_KEY
```

### "Port already in use"

**Problem:** Another service is using the dashboard port (default 3000).

**Note:** `ao start` automatically finds the next free port if the configured port is busy. You'll see a message like "Port 3000 is busy — using 3001 instead." If you still need to fix it manually:

```bash
# Option 1: Change port in agent-orchestrator.yaml
port: 3001

# Option 2: Find and kill the process using the port
lsof -ti:3000 | xargs kill
```

### "Workspace creation failed"

**Problem:** Orchestrator can't create worktrees or clones.

**Solution:**

```bash
# AO stores runtime data under ~/.agent-orchestrator/
ls -la ~/.agent-orchestrator

# Create the base directory if missing
mkdir -p ~/.agent-orchestrator

# Check disk space
df -h
```

### "Session not found"

**Problem:** Session ID doesn't exist or was already destroyed.

**Solution:**

```bash
# List active sessions
ao session ls

# Check status dashboard
ao status
```

### "Agent not responding"

**Problem:** Agent session is stuck or frozen.

**Solution:**

```bash
# Check session status
ao status

# Attach to session to investigate
ao open <session-name>

# Send message to agent
ao send <session-name> "Please report your current status"

# Kill and respawn if necessary
ao session kill <session-name>
ao spawn <issue-id>
```

### "Permission denied" when spawning

**Problem:** Agent doesn't have permissions for git operations.

**Solution:**

```bash
# Check SSH keys are added
ssh -T git@github.com

# Add SSH key if needed
ssh-add ~/.ssh/id_ed25519

# Or use HTTPS and authenticate gh CLI
gh auth login
```

### "YAML parse error"

**Problem:** Syntax error in `agent-orchestrator.yaml`.

**Solution:**

```bash
# Validate YAML syntax online: https://www.yamllint.com/

# Common issues:
# - Incorrect indentation (use 2 spaces, not tabs)
# - Missing quotes around strings with special characters
# - Typo in field names
```

### "Node version too old"

**Problem:** Node.js version is below 20.

**Solution:**

```bash
# Check version
node --version

# Upgrade with nvm (recommended)
nvm install 20
nvm use 20
nvm alias default 20

# Or download from: https://nodejs.org/
```

## Advanced Configuration

### Multi-Project Setup

Manage multiple repositories:

```yaml
projects:
  frontend:
    repo: org/frontend
    path: ~/frontend
    sessionPrefix: fe

  backend:
    repo: org/backend
    path: ~/backend
    sessionPrefix: api

  docs:
    repo: org/docs
    path: ~/docs
    sessionPrefix: doc
```

See [examples/multi-project.yaml](./examples/multi-project.yaml) for full example.

### Custom Plugin Development

Create custom plugins for:

- Different runtimes (Docker, Kubernetes, SSH, cloud VMs)
- Different agents (custom AI assistants)
- Different trackers (Jira, Asana, custom systems)
- Different notifiers (email, webhooks, custom integrations)

See [Development Guide](./docs/DEVELOPMENT.md) for plugin development guidelines.

### Docker Runtime

Run agents in Docker containers:

```yaml
defaults:
  runtime: docker

# Plugin will use official images or build from Dockerfile
```

### Kubernetes Runtime

Run agents in Kubernetes pods:

```yaml
defaults:
  runtime: kubernetes

# Requires kubectl configured with cluster access
```

### Custom Notifiers

Send notifications to custom webhooks:

```yaml
notifiers:
  webhook:
    plugin: webhook
    url: https://your-service.com/webhook
    method: POST
    headers:
      Authorization: "Bearer ${WEBHOOK_TOKEN}"
```

## FAQ

### What's a session?

A session is an isolated workspace where an agent works on a single issue. Each session has:

- Its own git worktree or clone
- Its own tmux session (or Docker container, etc.)
- Its own metadata (branch, PR, status)
- Its own event log

Sessions are ephemeral — they're created for an issue and destroyed when merged.

### What's a worktree vs clone?

**Worktree** (default):

- Shares `.git` directory with main repo
- Fast to create (no cloning)
- Efficient disk usage
- Best for local development

**Clone**:

- Full independent repository clone
- Slower to create
- More disk space
- Better for isolation, remote work

### How do reactions work?

Reactions are event handlers that run automatically:

1. Event occurs (CI fails, review comment added, PR approved)
2. Orchestrator checks reaction config
3. If `auto: true`, performs the action automatically
4. If escalation threshold reached, notifies human

Actions can be:

- `send-to-agent` - Forward event to agent to handle
- `auto-merge` - Merge PR automatically
- `notify` - Send notification to human

### When should I enable auto-merge?

Enable auto-merge if:

- ✅ You have comprehensive CI/CD tests
- ✅ You require code review approval
- ✅ You trust your agents to write correct code
- ✅ You want maximum automation

Don't enable auto-merge if:

- ❌ You have incomplete test coverage
- ❌ You want manual review of every change
- ❌ You're still evaluating agent quality
- ❌ You work on critical systems (finance, healthcare, etc.)

Start with `auto: false` and enable after building confidence.

### How do I add custom agent rules?

**Inline:**

```yaml
projects:
  my-app:
    agentRules: |
      Always run tests before pushing.
      Use conventional commits.
```

**External file:**

```yaml
projects:
  my-app:
    agentRulesFile: .agent-rules.md
```

Rules are included in every agent prompt for that project.

### Can I use multiple trackers?

Yes! Different projects can use different trackers:

```yaml
projects:
  frontend:
    tracker:
      plugin: github

  backend:
    tracker:
      plugin: linear
      teamId: "..."
```

### How do I monitor agent progress?

Three ways:

1. **Dashboard** - `ao start` then visit http://localhost:3000 (or your configured `port:`)
2. **CLI status** - `ao status` (text-based dashboard)
3. **Attach to session** - `ao open <session-name>` (live terminal)

### What if an agent gets stuck?

```bash
# Check status
ao status

# Send message
ao send <session-name> "What's your current status?"

# Attach to investigate
ao open <session-name>

# Kill and respawn if necessary
ao session kill <session-name>
ao spawn <issue-id>
```

Agents also send "stuck" notifications automatically after inactivity threshold.

### How do I clean up old sessions?

```bash
# List all sessions
ao session ls

# Kill specific session
ao session kill <session-name>

# Cleanup script (example)
ao session ls --json --include-terminated | jq -r '.data[] | select(.status == "merged") | .id' | xargs -I{} ao session kill {}
```

> **Note:** `ao session ls --json` and `ao status --json` emit `{ data: [...], meta: { hiddenTerminatedCount } }`. By default terminated sessions (`killed`, `terminated`, `done`, `merged`, `errored`, `cleanup`) are hidden — pass `--include-terminated` to include them in `data`.

### Can I run multiple orchestrators?

Yes! Each orchestrator instance should have:

- Different dashboard port (`port`) — e.g., 3000 for project A, 3001 for project B
- Different config location or project paths

AO derives runtime directories from the config location, so separate config locations already produce separate hash-scoped runtime paths under `~/.agent-orchestrator/`. Terminal WebSocket ports are auto-detected by default, so you typically only need to set `port:` differently. If you need explicit control, you can also set `terminalPort:` and `directTerminalPort:` per config.

Useful for:

- Separating projects
- Different teams
- Testing new configs

## Next Steps

1. **Start the orchestrator** — `ao start` (auto-creates config on first run)
2. **Spawn an agent** — `ao spawn 123` (project auto-detected from cwd)
3. **Monitor progress** — `ao status` or dashboard at http://localhost:3000
4. **Read [Development Guide](./docs/DEVELOPMENT.md)** — Code conventions and architecture
5. **Explore examples** — See [examples/](./examples/) for more configs
6. **Join the community** — Report issues, share configs, contribute plugins

---

**Need help?** Open an issue at: https://github.com/ComposioHQ/agent-orchestrator/issues
