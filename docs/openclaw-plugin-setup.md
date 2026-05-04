# OpenClaw Plugin Setup Guide

How to set up the Agent Orchestrator (AO) plugin for OpenClaw so the AI bot delegates all coding work to AO agents.

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- [Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) installed with `ao start` already run in your repo
- `ao`, `gh`, `tmux`, and `node` available in PATH
- GitHub CLI (`gh`) authenticated

## 1. Install the Plugin

```bash
# From the agent-orchestrator repo
cd openclaw-plugin
openclaw plugins install .
```

Or manually copy the plugin files:

```bash
mkdir -p ~/.openclaw/extensions/agent-orchestrator
cp openclaw-plugin/index.ts ~/.openclaw/extensions/agent-orchestrator/
cp openclaw-plugin/openclaw.plugin.json ~/.openclaw/extensions/agent-orchestrator/
cp openclaw-plugin/package.json ~/.openclaw/extensions/agent-orchestrator/
```

## 2. Install the Skill

```bash
mkdir -p ~/.openclaw/extensions/skills/agent-orchestrator
cp skills/agent-orchestrator/SKILL.md ~/.openclaw/extensions/skills/agent-orchestrator/
cp -r skills/agent-orchestrator/references ~/.openclaw/extensions/skills/agent-orchestrator/ 2>/dev/null
```

## 3. Configure OpenClaw

Run `/ao setup` in any OpenClaw channel to auto-configure, or run these commands manually:

### Required Settings

```bash
# 1. Plugin tools need "full" profile to be visible to the AI
#    The "coding" profile only includes built-in tools, NOT plugin tools
openclaw config set tools.profile "full"

# 2. Plugin tools are optional by default — explicitly allow them
openclaw config set tools.allow '["group:plugins"]'

# 3. Trust the plugin
openclaw config set plugins.allow '["agent-orchestrator"]'
```

### Required: Disable Conflicting Built-in Skills

**Without these, the bot may ignore AO and write code directly.** Run once after setup:

```bash
# Prevent the bot from writing code directly — it should delegate to AO instead
openclaw config set tools.deny '["exec", "write", "str_replace_based_edit_tool", "create_file", "str_replace_editor"]'

# Disable the built-in coding skill (it tells the bot to use Codex/Claude Code directly, overriding AO)
openclaw config set skills.entries.coding-agent.enabled false

# Disable the built-in GitHub issues skill (it spawns OpenClaw sub-agents, bypassing AO)
openclaw config set skills.entries.gh-issues.enabled false
```

### Optional Settings

```bash
# Discord: respond in server channels when @mentioned (default is DM-only)
openclaw config set channels.discord.groupPolicy "open"
# Read last 100 messages for context when @mentioned in a channel
openclaw config set messages.groupChat.historyLimit 100
```

### Plugin Config (if `ao` isn't in PATH or repo isn't in default location)

```bash
# Set the path to the ao binary
openclaw config set plugins.entries.agent-orchestrator.config.aoPath "/path/to/ao"

# Set the working directory (must contain agent-orchestrator.yaml)
openclaw config set plugins.entries.agent-orchestrator.config.aoCwd "/path/to/your/repo"

# Set the path to gh binary (if not in PATH)
openclaw config set plugins.entries.agent-orchestrator.config.ghPath "/path/to/gh"
```

## 4. Set Up Identity Files

Create these files in `~/.openclaw/workspace/` to give the bot its personality and instructions:

### IDENTITY.md

```markdown
# IDENTITY.md

- **Name:** AO
- **Creature:** AI Engineering Manager
- **Vibe:** Sharp, concise, proactive
- **Emoji:** ⚡

## Default Setup

- **GitHub account:** <your-github-username>
- **Primary repo:** <owner/repo>
- **AO project ID:** <project-id-from-agent-orchestrator.yaml>
- **Owner:** <your-name>

## How You Operate

You are a MANAGER. You never write code yourself. You delegate ALL coding work to Agent Orchestrator.

When asked about work → use `ao_issues` tool
When asked about status → use `ao_sessions` or `ao_status` tool
When asked to start work → use `ao_spawn` tool (always include project ID)
When asked to start multiple → use `ao_batch_spawn` tool
When talking to an agent → use `ao_send` tool
When stopping an agent → use `ao_kill` tool (confirm first)

If an AO tool fails, report the error. Do NOT fall back to coding directly.
```

### SOUL.md

```markdown
# SOUL.md

You are AO — an AI engineering manager. You manage coding agents through Agent Orchestrator.

You NEVER write code directly. You delegate ALL coding to AO agents via ao_spawn.
Even if spawning fails, you report the failure — you don't code directly.

Always include full PR URLs when reporting: https://github.com/<owner>/<repo>/pull/<number>
```

## 5. Restart and Verify

```bash
# Restart the gateway
pm2 restart openclaw-gateway
# Or however you run OpenClaw

# Verify the plugin loaded
openclaw plugins list | grep agent-orchestrator

# Verify tools are visible
openclaw agent --agent main -m "List your tools"
# Should show ao_sessions, ao_issues, ao_spawn, etc.

# Verify AO works
/ao doctor
```

## Why These Settings Matter

| Setting | Why |
|---------|-----|
| `tools.profile: "full"` | The `coding` profile only includes built-in tools. Plugin tools require `full`. |
| `tools.allow: ["group:plugins"]` | OpenClaw treats ALL plugin tools as optional. Without this, they're invisible to the AI. |
| `tools.deny: [exec, write, ...]` | Without this, the bot will write code directly instead of delegating to AO. |
| `skills.entries.coding-agent.enabled: false` | This built-in skill tells the bot to use Codex/Claude Code. It overrides AO. |
| `skills.entries.gh-issues.enabled: false` | This built-in skill spawns OpenClaw sub-agents. It bypasses AO. |
| `aoCwd` | `ao spawn` must run from the directory containing `agent-orchestrator.yaml`. |

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Bot says "no ao_* tools available" | `tools.profile` is not `full` or `tools.allow` missing `group:plugins` | Run `/ao setup` |
| Bot writes code directly | `coding-agent` skill is active or `exec`/`write` not denied | Run `/ao setup` |
| `ao spawn` returns "No config found" | `aoCwd` not set or wrong path | Set `plugins.entries.agent-orchestrator.config.aoCwd` |
| `ao: not found` | `ao` not in PATH | Create symlink or set `aoPath` in plugin config |
| Only 2-3 issues shown (not all) | Bot answering from stale session memory | Clear sessions: `rm ~/.openclaw/agents/main/sessions/sessions.json` |
| Bot only responds in DMs | `groupPolicy` is `allowlist` | Set `channels.discord.groupPolicy` to `open` |
| Bot responds to every message | `mentionPatterns` too broad | Remove patterns, rely on native @mentions |
| Sessions show "exited" immediately | Agent (Claude Code) won't run as root | Run AO as non-root user |

## Architecture

```
Discord message → OpenClaw Gateway → AI Model (with AO tools)
                                          ↓
                                    ao_spawn tool
                                          ↓
                              AO CLI (agent-orchestrator)
                                          ↓
                              Git worktree + Claude Code agent
                                          ↓
                              Branch → Commit → PR
```

The bot (OpenClaw) is the **manager**. AO is the **workforce**. The bot never codes — it uses AO tools to spawn agents that do the actual work.
