#!/bin/bash
# try-pr.sh — switch the global 'ao' command to a PR worktree for manual testing
#
# Usage:
#   bash scripts/try-pr.sh <session-id>            # CLI/core/plugins only (~15s)
#   bash scripts/try-pr.sh <session-id> --with-web # also builds + starts dashboard (~60s)
#   bash scripts/try-pr.sh --restore               # switch back to main

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

RESTORE_FILE="$HOME/.ao-try-pr-restore"
MAIN_REPO="$(cd "$(dirname "$0")/.." && pwd)"

# ── restore ────────────────────────────────────────────────────────────────────
if [ "$1" = "--restore" ]; then
  if [ ! -f "$RESTORE_FILE" ]; then
    echo -e "${RED}Nothing to restore — no active try-pr session found.${RESET}"
    exit 1
  fi
  AO_SHIM=$(which ao)
  # Restore original shim
  if [ -f "$RESTORE_FILE.shim" ]; then
    cp "$RESTORE_FILE.shim" "$AO_SHIM"
    chmod +x "$AO_SHIM"
    rm "$RESTORE_FILE.shim"
  fi
  rm "$RESTORE_FILE"
  echo -e "${GREEN}✔ Done. ao now points to main.${RESET}"
  exit 0
fi

# ── parse args ─────────────────────────────────────────────────────────────────
SESSION="${1:?Usage: bash scripts/try-pr.sh <session-id> [--with-web]}"
WITH_WEB=false
if [ "$2" = "--with-web" ]; then
  WITH_WEB=true
fi

WORKTREES_DIR="${AO_WORKTREES_DIR:-$HOME/.worktrees/ao}"
WORKTREE="$WORKTREES_DIR/$SESSION"

if [ ! -d "$WORKTREE" ]; then
  echo -e "${RED}Worktree not found: $WORKTREE${RESET}"
  echo "Available sessions:"
  ls "$WORKTREES_DIR" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
  exit 1
fi

BRANCH=$(git -C "$WORKTREE" branch --show-current 2>/dev/null || echo "unknown")

cd "$WORKTREE"

# ── build CLI/core/plugins ─────────────────────────────────────────────────────
echo -e "\n${BOLD}Building $SESSION${RESET} (branch: ${CYAN}$BRANCH${RESET})\n"

pnpm --filter @composio/ao-core \
     --filter @composio/ao-cli \
     --filter '@composio/ao-plugin-*' \
     build

# ── build web if requested ─────────────────────────────────────────────────────
if [ "$WITH_WEB" = true ]; then
  echo -e "\n${BOLD}Building dashboard...${RESET}\n"
  pnpm --filter @composio/ao-web build
fi

# ── link ao ───────────────────────────────────────────────────────────────────
# Directly update the pnpm shim to point at the worktree's dist/index.js
AO_SHIM=$(which ao)
AO_TARGET="$WORKTREE/packages/cli/dist/index.js"

echo -e "\n${BOLD}Linking ao${RESET} → $AO_TARGET\n"

# Save the original shim so we can restore it
cp "$AO_SHIM" "$RESTORE_FILE.shim"
echo "$MAIN_REPO" > "$RESTORE_FILE"

# Rewrite the shim to point at the worktree
cat > "$AO_SHIM" <<EOF
#!/bin/sh
exec node "$AO_TARGET" "\$@"
EOF
chmod +x "$AO_SHIM"

echo -e "${GREEN}✔ ao now points to: ${BOLD}$SESSION${RESET}${GREEN} ($BRANCH)${RESET}"
echo ""
echo -e "  Test your changes, then restore with:"
echo -e "  ${CYAN}bash scripts/try-pr.sh --restore${RESET}"

# ── start dashboard if --with-web ──────────────────────────────────────────────
if [ "$WITH_WEB" = true ]; then
  # Find a free port starting from 3001 (3000 may be used by the main ao start)
  PORT=3001
  while lsof -ti ":$PORT" &>/dev/null; do
    PORT=$((PORT + 1))
  done

  # Use the real config so the PR dashboard shows actual sessions
  REAL_CONFIG="$MAIN_REPO/agent-orchestrator.yaml"
  if [ ! -f "$REAL_CONFIG" ]; then
    REAL_CONFIG="${AO_CONFIG_PATH:-}"
  fi

  echo ""
  echo -e "  ${BOLD}Starting dashboard on port $PORT...${RESET}"
  echo -e "  ${CYAN}http://localhost:$PORT${RESET}  (Ctrl+C to stop)\n"
  cd packages/web && AO_CONFIG_PATH="$REAL_CONFIG" PORT=$PORT pnpm dev
else
  # Hint if this PR has web changes but --with-web wasn't passed
  if git -C "$WORKTREE" diff --name-only "origin/main...HEAD" 2>/dev/null | grep -q "packages/web/"; then
    echo ""
    echo -e "  ${CYAN}Tip:${RESET} this PR has dashboard changes. Re-run with:"
    echo -e "  ${CYAN}bash scripts/try-pr.sh $SESSION --with-web${RESET}"
  fi
  echo ""
fi
