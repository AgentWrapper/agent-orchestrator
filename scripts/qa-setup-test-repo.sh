#!/bin/bash
# One-time QA setup: create throwaway GitHub repo, seed issues, configure VM.
# Safe to re-run — skips creation if repo/issues already exist.
#
# Prerequisites:
#   - gh CLI authenticated locally (gh auth status)
#   - SSH key at ~/.ssh/qakeypair.pem for the VM
#
# Usage: bash scripts/qa-setup-test-repo.sh

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────

GITHUB_USER="Laraib-1629"
REPO_NAME="ao-qa-test"
REPO_FULL="$GITHUB_USER/$REPO_NAME"

VM_HOST="aoqa.centralindia.cloudapp.azure.com"
VM_USER="azureuser"
VM_KEY="$HOME/.ssh/qakeypair.pem"
VM_REPO_PATH="/srv/ao-preview/manual-qa/$REPO_NAME"
VM_AO_PATH="/srv/ao-preview/manual-qa/agent-orchestrator"
AO_BIN="$VM_AO_PATH/packages/ao/node_modules/.bin/ao"

# ── 1. Create GitHub repo (idempotent) ───────────────────────────────────────

echo ""
echo "==> Checking GitHub repo $REPO_FULL..."

if gh repo view "$REPO_FULL" &>/dev/null; then
  echo "    Repo already exists, skipping creation."
else
  echo "    Creating repo $REPO_FULL..."
  gh repo create "$REPO_FULL" \
    --public \
    --description "Throwaway repo for AO multi-PR QA testing" \
    --add-readme
  echo "    Repo created."
  # Give GitHub a moment to initialize
  sleep 3
fi

# ── 2. Seed test issues (idempotent) ─────────────────────────────────────────

echo ""
echo "==> Seeding test issues..."

seed_issue() {
  local title="$1"
  local body="$2"

  # Check if issue with this title already exists
  existing=$(gh issue list --repo "$REPO_FULL" --search "$title" --json number --jq '.[0].number' 2>/dev/null || echo "")
  if [[ -n "$existing" ]]; then
    echo "    Issue already exists: #$existing — $title"
  else
    url=$(gh issue create --repo "$REPO_FULL" --title "$title" --body "$body")
    number=$(echo "$url" | grep -o '[0-9]*$')
    echo "    Created issue #$number — $title"
  fi
}

seed_issue \
  "Add README.md with project description" \
  "Create a \`README.md\` at the repo root with:
- A project title: **AO QA Test Repo**
- One-line description: *Throwaway repo for Agent Orchestrator QA testing*

Open a single pull request."

seed_issue \
  "Add .gitignore for Node.js" \
  "Create a standard \`.gitignore\` file for Node.js projects (node_modules, dist, .env, etc.).

Open a single pull request."

seed_issue \
  "Add greeting utilities — deliver as two separate PRs" \
  "This task must be completed as **two separate pull requests** opened on the same session:

**PR 1:** Create \`src/greet.js\`:
\`\`\`js
export function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`
Open a pull request for this file. Do NOT wait for it to be merged.

**PR 2:** While PR 1 is still open, create a new branch from \`main\` and add \`src/farewell.js\`:
\`\`\`js
export function farewell(name) {
  return \`Goodbye, \${name}!\`;
}
\`\`\`
Open a second pull request.

Both PRs should be open at the same time. This tests multi-PR tracking per session."

seed_issue \
  "Add package.json" \
  "Create a \`package.json\` at the repo root with:
- \`name\`: \`ao-qa-test\`
- \`version\`: \`1.0.0\`
- \`type\`: \`module\`

Open a single pull request."

echo ""
echo "==> Issues:"
gh issue list --repo "$REPO_FULL" | awk '{print "    #"$1, $2, $3, $4, $5}'

# ── 3. Clone repo on VM and update agent-orchestrator.yaml ───────────────────

echo ""
echo "==> Configuring VM..."

ssh -i "$VM_KEY" "$VM_USER@$VM_HOST" bash -s -- \
  "$VM_REPO_PATH" "$VM_AO_PATH" "$REPO_FULL" "$AO_BIN" << 'REMOTE'
set -euo pipefail

VM_REPO_PATH="$1"
VM_AO_PATH="$2"
REPO_FULL="$3"
AO_BIN="$4"

echo "==> Cloning/updating throwaway repo on VM..."
if [[ -d "$VM_REPO_PATH/.git" ]]; then
  cd "$VM_REPO_PATH"
  git pull origin main
  echo "    Pulled latest."
else
  git clone "https://github.com/$REPO_FULL.git" "$VM_REPO_PATH"
  echo "    Cloned."
fi

echo "==> Updating agent-orchestrator.yaml..."
cat > "$VM_AO_PATH/agent-orchestrator.yaml" << YAML
\$schema: https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json

port: 3000
terminalPort: 14800
directTerminalPort: 14801

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree

projects:
  ao-qa-test:
    name: AO Multi-PR QA Test
    repo: $REPO_FULL
    path: $VM_REPO_PATH
    defaultBranch: main
    sessionPrefix: test
    agentRules: |
      Keep changes minimal and focused.
      Use conventional commits (feat:, fix:, chore:).
      When the task asks for multiple PRs, create them as separate branches from main.
      Do not wait for a PR to be merged before opening a second PR.
YAML

echo "==> Stopping AO..."
"$AO_BIN" stop 2>/dev/null || pkill -f 'start-all.js' 2>/dev/null || true
sleep 3

echo "==> Restarting AO..."
tmux has-session -t ao-qa 2>/dev/null || tmux new-session -d -s ao-qa
tmux send-keys -t ao-qa:0 "" Enter
tmux send-keys -t ao-qa:0 "cd $VM_AO_PATH && $AO_BIN start" Enter

echo ""
echo "Done. VM is configured."
REMOTE

echo ""
echo "================================================================"
echo "Setup complete."
echo ""
echo "Throwaway repo : https://github.com/$REPO_FULL"
echo "Dashboard      : http://aoqa.centralindia.cloudapp.azure.com"
echo ""
echo "Next steps:"
echo "  1. Wait ~15s for AO to start"
echo "  2. Open the dashboard and go to the 'AO Multi-PR QA Test' project"
echo "  3. Spawn sessions:"
echo "     ssh -i ~/.ssh/qakeypair.pem $VM_USER@$VM_HOST"
echo "     cd $VM_AO_PATH && $AO_BIN batch-spawn 1 2 3 4"
echo "================================================================"
