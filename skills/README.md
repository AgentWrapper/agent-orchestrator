# Skills

Reusable skill documents for AI coding agents working on this repository. Each skill is a self-contained `SKILL.md` that teaches an agent how to perform a specific task.

## Available Skills

| Skill | Description |
|-------|-------------|
| [`bug-triage/`](bug-triage/SKILL.md) | Triage bugs reported in chat/issues — investigate, search duplicates, file GitHub issues, push fix PRs |
| [`agent-orchestrator/`](agent-orchestrator/SKILL.md) | Architecture and conventions for working on the agent-orchestrator codebase |
| [`release-notes/`](release-notes/ao-weekly-release/SKILL.md) | Generate weekly release notes from git history |
| [`social-media/`](social-media/SKILL.md) | Social media post generation |

## How to Use

Copy the skill into your coding agent's skill directory. The destination depends on which agent you're using:

### Claude Code

```bash
cp -r skills/bug-triage .claude/skills/bug-triage
```

Or add the full path to your `CLAUDE.md`:

```markdown
See skills/bug-triage/SKILL.md for bug triage workflow.
```

### OpenAI Codex CLI

```bash
cp -r skills/bug-triage .codex/skills/bug-triage
```

Or reference in `AGENTS.md`:

```markdown
See skills/bug-triage/SKILL.md for bug triage workflow.
```

### Cursor

Add to `.cursor/rules/` as a rule file:

```bash
cp skills/bug-triage/SKILL.md .cursor/rules/bug-triage.mdc
```

### Windsurf / Other Codeium-based agents

Add to `.windsurf/rules/`:

```bash
cp skills/bug-triage/SKILL.md .windsurf/rules/bug-triage.md
```

### GitHub Copilot

Add to `.github/copilot-instructions.md` or reference in `.github/`:

```bash
cp skills/bug-triage/SKILL.md .github/skills/bug-triage.md
```

### Gemini CLI

```bash
cp -r skills/bug-triage .gemini/skills/bug-triage
```

### Agent Orchestrator (this project)

Skills in this `skills/` directory are automatically available to agents spawned via `ao spawn`. Reference them in `AGENTS.md` or `CLAUDE.md` so agents load them at the start of a session.

## Writing a New Skill

1. Create a directory under `skills/<name>/`
2. Add a `SKILL.md` with YAML frontmatter:

```yaml
---
name: my-skill
description: One-line description of what the skill does.
trigger: When to activate this skill.
---
```

3. Write the skill body in markdown — numbered steps, code blocks, tables
4. Keep it agent-agnostic: use `gh` CLI, `git`, and standard Unix tools. Avoid tying to a specific agent framework
5. Reference it in `AGENTS.md` so spawned agents discover it
