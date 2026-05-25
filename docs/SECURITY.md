# Security Policy

## Reporting Security Issues

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to security@composio.dev.

You should receive a response within 48 hours. If for some reason you do not, please follow up via email to ensure we received your original message.

Please include the following information:

- Type of issue (e.g., secret leak, code injection, authentication bypass)
- Full paths of source file(s) related to the issue
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue

## Security Audit History

### Known Issues

#### OpenClaw Notifier Token (Resolved)

**Status**: Removed from codebase
**Severity**: Medium
**Date**: 2026-02-15
**Commit**: 0393ab70a83e090883895d2168aa39a76f997ec8

An OpenClaw notifier token (`1af5c4f...872` - redacted) was accidentally committed in `agent-orchestrator.yaml` and later removed. This token was:

- Used for local development/testing only
- Never used in production
- Removed in subsequent commits
- Still present in git history

**Action Required**: If this token is still in use, it should be rotated immediately.

**Lesson**: All tokens and API keys must use environment variables. The `agent-orchestrator.yaml` file is now in `.gitignore` to prevent future accidental commits.

## Security Measures

### Automated Secret Scanning

This repository uses [Gitleaks](https://github.com/gitleaks/gitleaks) to prevent accidental commits of secrets:

1. **Pre-commit Hook** — Scans staged files before every commit
2. **CI Pipeline** — Scans full git history on every push/PR
3. **Scheduled Scans** — Weekly scans to catch new vulnerability patterns

### Dependency Security

- **Dependency Review** — GitHub Action scans PRs for vulnerable dependencies
- **npm audit** — Runs in CI to detect known vulnerabilities in dependencies
- **Automated Updates** — Dependabot (or similar) for security patches

## Best Practices for Developers

### Never Commit Secrets

❌ **Bad** — Hardcoded secret:

```yaml
notifiers:
  slack:
    webhook: https://hooks.slack.com/services/T123/B456/abc123
```

✅ **Good** — Environment variable:

```yaml
notifiers:
  slack:
    webhook: ${SLACK_WEBHOOK_URL}
```

### Use Environment Variables

Store all secrets in environment variables:

```bash
# .env.local (ignored by git)
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Then reference in config:

```yaml
notifiers:
  slack:
    webhook: ${SLACK_WEBHOOK_URL}
```

### Naming Conventions

Use consistent environment variable names:

- `*_API_KEY` — API keys (e.g., `LINEAR_API_KEY`)
- `*_TOKEN` — Authentication tokens (e.g., `GITHUB_TOKEN`)
- `*_SECRET` — Secret keys (e.g., `JWT_SECRET`)
- `*_URL` — URLs that may contain credentials (e.g., `DATABASE_URL`)

### Example Config Files

When creating example config files:

1. Use placeholder values: `your-api-key-here`, `your-token-here`
2. Use environment variable references: `${ENV_VAR}`
3. Never copy real credentials, even "temporarily"
4. Document which environment variables are required

### Files to Never Commit

The `.gitignore` excludes these patterns:

- `.env`, `.env.local`, `.env.*.local`
- `*.key`, `*.pem`, `*.p12`, `*.pfx`
- `secrets.yaml`, `credentials.json`
- `agent-orchestrator.yaml` (local config)

### Checking for Secrets Locally

Before committing:

```bash
# Scan current files
gitleaks detect --no-git

# Scan staged files (automatic in pre-commit hook)
gitleaks protect --staged

# Scan full git history
gitleaks detect
```

### What to Do If You Commit a Secret

If you accidentally commit a secret:

1. **Rotate the secret immediately** — Assume it's compromised
2. **Remove from git history** — Use `git filter-repo` or similar (dangerous!)
3. **Update `.gitleaks.toml`** — Add pattern to prevent similar leaks
4. **Report internally** — Document in SECURITY.md

**Never** just delete the file and commit — the secret remains in git history!

### Code Review

When reviewing PRs:

- ✅ Check for hardcoded tokens, passwords, API keys
- ✅ Verify environment variables are documented but not hardcoded
- ✅ Ensure example configs use placeholders
- ✅ Confirm CI security check passed

## Best Practices for Users

### Secure Configuration

When setting up Agent Orchestrator:

1. **Copy example config**: `cp agent-orchestrator.yaml.example agent-orchestrator.yaml`
2. **Add real secrets**: Edit `agent-orchestrator.yaml` with your actual tokens
3. **Never commit local config**: It's in `.gitignore` — keep it there!
4. **Use secret management**: Consider 1Password, AWS Secrets Manager, etc.

### Required Secrets

Agent Orchestrator may require these secrets:

| Service   | Environment Variable | Where to Get                             |
| --------- | -------------------- | ---------------------------------------- |
| GitHub    | `GITHUB_TOKEN`       | https://github.com/settings/tokens       |
| Linear    | `LINEAR_API_KEY`     | https://linear.app/settings/api          |
| Slack     | `SLACK_WEBHOOK_URL`  | https://api.slack.com/messaging/webhooks |
| Anthropic | `ANTHROPIC_API_KEY`  | https://console.anthropic.com/           |

### Setting Environment Variables

**macOS/Linux**:

```bash
# In ~/.zshrc or ~/.bashrc
export GITHUB_TOKEN="ghp_xxxxx"
export LINEAR_API_KEY="lin_api_xxxxx"
```

**Or use `.env.local`**:

```bash
# In your project directory
echo 'GITHUB_TOKEN=ghp_xxxxx' >> .env.local
echo 'LINEAR_API_KEY=lin_api_xxxxx' >> .env.local
```

### Protecting Your Secrets

- ✅ Use strong, unique tokens for each service
- ✅ Rotate tokens regularly (every 90 days)
- ✅ Use minimal permissions (read-only when possible)
- ✅ Store in a password manager
- ❌ Never share tokens in chat, email, or screenshots
- ❌ Never commit to git (public or private repos)
- ❌ Never hardcode in shell scripts

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

Security updates are provided for the latest version only.

## Security Tools

This project uses:

- [Gitleaks](https://github.com/gitleaks/gitleaks) — Secret scanning
- [GitHub Dependency Review](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review) — Dependency vulnerability scanning
- [npm audit](https://docs.npmjs.com/cli/v8/commands/npm-audit) — Dependency vulnerability detection
- [Husky](https://typicode.github.io/husky/) — Git hooks for pre-commit validation

## License

This security policy is part of the Agent Orchestrator project and is licensed under the MIT License.
