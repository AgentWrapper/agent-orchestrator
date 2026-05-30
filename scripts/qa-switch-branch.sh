#!/bin/bash
# Switch the AO QA VM to a specific branch for testing.
# Usage: bash scripts/qa-switch-branch.sh
#
# Target VM : aoqa.centralindia.cloudapp.azure.com
# SSH user  : azureuser
# Repo path : /srv/ao-preview/manual-qa/agent-orchestrator
# Tmux      : ao-qa

set -euo pipefail

VM_HOST="aoqa.centralindia.cloudapp.azure.com"
VM_USER="azureuser"
VM_KEY="$HOME/.ssh/qakeypair.pem"
REPO_PATH="/srv/ao-preview/manual-qa/agent-orchestrator"
TMUX_SESSION="ao-qa"

UPSTREAM_REMOTE="https://github.com/ComposioHQ/agent-orchestrator.git"

BRANCH_CORE="feat/multi-pr-per-session"
BRANCH_UI="feat/multi-pr-card-ui"

# ── Repo selection ───────────────────────────────────────────────────────────

echo ""
echo "Which repository?"
echo ""
echo "  1) Upstream — ComposioHQ/agent-orchestrator (default)"
echo "  2) Fork     — enter your GitHub fork URL"
echo ""
read -rp "Enter 1 or 2 [default: 1]: " repo_choice
repo_choice="${repo_choice:-1}"

case "$repo_choice" in
  1)
    TARGET_REMOTE="$UPSTREAM_REMOTE"
    REMOTE_NAME="origin"
    ;;
  2)
    read -rp "Enter your fork URL (e.g. https://github.com/yourname/agent-orchestrator.git): " fork_url
    if [[ -z "$fork_url" ]]; then
      echo "No URL provided. Exiting."
      exit 1
    fi
    TARGET_REMOTE="$fork_url"
    REMOTE_NAME="fork"
    ;;
  *)
    echo "Invalid choice. Exiting."
    exit 1
    ;;
esac

# ── Branch selection ─────────────────────────────────────────────────────────

echo ""
echo "Which branch?"
echo ""
echo "  1) feat/multi-pr-per-session  — core multi-PR support (base PR)"
echo "  2) feat/multi-pr-card-ui      — per-PR rows, colored chips, click-to-switch (stacked PR, includes base)"
echo ""
read -rp "Enter 1 or 2: " branch_choice

case "$branch_choice" in
  1) TARGET_BRANCH="$BRANCH_CORE" ;;
  2) TARGET_BRANCH="$BRANCH_UI" ;;
  *)
    echo "Invalid choice. Exiting."
    exit 1
    ;;
esac

# ── Confirm ──────────────────────────────────────────────────────────────────

echo ""
echo "  Repo   : $TARGET_REMOTE"
echo "  Branch : $TARGET_BRANCH"
echo "  Target : $VM_USER@$VM_HOST:$REPO_PATH"
echo ""
read -rp "Proceed? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── Remote commands ──────────────────────────────────────────────────────────

ssh -i "$VM_KEY" "$VM_USER@$VM_HOST" bash -s -- "$REPO_PATH" "$TMUX_SESSION" "$TARGET_BRANCH" "$REMOTE_NAME" "$TARGET_REMOTE" << 'REMOTE'
set -euo pipefail

REPO_PATH="$1"
TMUX_SESSION="$2"
BRANCH="$3"
REMOTE_NAME="$4"
REMOTE_URL="$5"

echo ""
echo "==> Stopping AO..."
cd "$REPO_PATH"
ao stop 2>/dev/null || true

echo "==> Waiting for AO to fully stop..."
sleep 3

echo "==> Setting up remote '$REMOTE_NAME'..."
if git remote get-url "$REMOTE_NAME" &>/dev/null; then
  git remote set-url "$REMOTE_NAME" "$REMOTE_URL"
else
  git remote add "$REMOTE_NAME" "$REMOTE_URL"
fi

echo "==> Fetching $BRANCH from $REMOTE_NAME..."
git fetch "$REMOTE_NAME" "$BRANCH"
git checkout -B "$BRANCH" "$REMOTE_NAME/$BRANCH"

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building..."
pnpm build

echo "==> Restarting AO in tmux session '$TMUX_SESSION'..."
AO_BIN="$REPO_PATH/packages/ao/node_modules/.bin/ao"
tmux send-keys -t "$TMUX_SESSION:0" "" Enter
tmux send-keys -t "$TMUX_SESSION:0" "cd $REPO_PATH && $AO_BIN start" Enter

echo ""
echo "Done. AO is starting on branch: $BRANCH"
echo "Dashboard: http://aoqa.centralindia.cloudapp.azure.com:3000"
REMOTE
