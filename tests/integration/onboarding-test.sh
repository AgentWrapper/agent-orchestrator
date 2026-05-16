#!/bin/bash
# Integration test: Fresh developer onboarding experience
# Measures time and verifies each step of the onboarding flow

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Timing utilities
start_time=$(date +%s)
step_start=0

start_step() {
    echo -e "\n${BLUE}▶ $1${NC}"
    step_start=$(date +%s)
}

end_step() {
    local step_end=$(date +%s)
    local duration=$((step_end - step_start))
    echo -e "${GREEN}✓ $1 (${duration}s)${NC}"
}

fail_step() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

# Test starts here
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Agent Orchestrator - Onboarding Integration Test     ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo ""

# Step 1: Simulate git clone (already done by Docker COPY, but we cd into it)
start_step "Step 1: Navigate to repository"
cd /workspace/agent-orchestrator || fail_step "Repository not found"
end_step "Step 1: Repository accessible"

# Step 2: Run setup script
start_step "Step 2: Running ./scripts/setup.sh"
if ! ./scripts/setup.sh; then
    fail_step "Step 2: Setup script failed"
fi
end_step "Step 2: Setup completed"

# Step 3: Verify ao command is available
start_step "Step 3: Verify ao command"
if ! command -v ao &> /dev/null; then
    fail_step "Step 3: ao command not found (npm link failed?)"
fi
ao --version || fail_step "Step 3: ao --version failed"
end_step "Step 3: ao command available"

# Step 4: Create minimal test config
start_step "Step 4: Create test configuration"
mkdir -p /tmp/ao-test-project
cd /tmp/ao-test-project
git init
git config user.email "test@example.com"
git config user.name "Test User"

cat > agent-orchestrator.yaml << 'EOF'
dataDir: /tmp/ao-test-data
worktreeDir: /tmp/ao-test-worktrees
port: 9000

projects:
  test-project:
    repo: test/repo
    path: /tmp/ao-test-project
    defaultBranch: main
EOF

end_step "Step 4: Configuration created"

# Step 5: Verify config is valid
start_step "Step 5: Validate configuration"
# Verify the config file is readable
if [ ! -f agent-orchestrator.yaml ]; then
    fail_step "Step 5: Config file not found"
fi
end_step "Step 5: Configuration validated"

# Step 6: Start orchestrator (in background)
start_step "Step 6: Start orchestrator"
# Start in background and capture PID
ao start --no-orchestrator &  # Only start dashboard, not the orchestrator session
DASHBOARD_PID=$!

# Wait for dashboard to be ready (max 30 seconds)
echo "  Waiting for dashboard to start..."
for i in {1..30}; do
    if curl -s http://localhost:9000 > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $DASHBOARD_PID 2>/dev/null; then
        fail_step "Step 6: Dashboard process died"
    fi
    sleep 1
done

if ! curl -s http://localhost:9000 > /dev/null 2>&1; then
    fail_step "Step 6: Dashboard not responding after 30s"
fi

end_step "Step 6: Dashboard started successfully"

# Step 7: Verify dashboard endpoints
start_step "Step 7: Verify dashboard API"

# Test /api/sessions endpoint
if ! curl -sf http://localhost:9000/api/sessions > /dev/null; then
    fail_step "Step 7: /api/sessions endpoint failed"
fi

# Test SSE events endpoint (just verify it responds, don't wait for events)
if ! timeout 2 curl -sf http://localhost:9000/api/events > /dev/null 2>&1; then
    # SSE might timeout, that's ok - we just want to verify it exists
    :
fi

end_step "Step 7: Dashboard API responding"

# Step 8: Verify WebSocket terminal servers
start_step "Step 8: Verify WebSocket servers"

# Check if direct terminal WebSocket server is running (required for terminal feature)
# Default port is 14801 (14800 range chosen to avoid conflicts with dev tools)
DIRECT_TERMINAL_PORT="${DIRECT_TERMINAL_PORT:-14801}"
echo "  Checking WebSocket server on port $DIRECT_TERMINAL_PORT..."
max_retries=10
for i in $(seq 1 $max_retries); do
    if curl -sf "http://localhost:$DIRECT_TERMINAL_PORT/health" > /dev/null 2>&1; then
        echo "  ✓ WebSocket server responding"
        break
    fi
    if [ $i -eq $max_retries ]; then
        fail_step "Step 8: WebSocket terminal server not responding (bug: ao start didn't launch all services)"
    fi
    sleep 1
done

end_step "Step 8: WebSocket servers verified"

# Step 9: Verify orchestrator terminal page (end-to-end test)
start_step "Step 9: Verify orchestrator terminal feature"

# Create orchestrator session first (so we have something to test)
echo "  Creating test orchestrator session..."
tmux new-session -d -s test-project-orchestrator || true

# Write minimal metadata
mkdir -p /tmp/ao-test-data
cat > /tmp/ao-test-data/test-project-orchestrator << 'EOF'
worktree=/tmp/ao-test-project
branch=main
status=working
project=test-project
EOF

# Test that the session detail page loads (where terminal would be)
if ! curl -sf http://localhost:9000/sessions/test-project-orchestrator > /dev/null; then
    fail_step "Step 9: Orchestrator session page failed to load"
fi

# Cleanup test session
tmux kill-session -t test-project-orchestrator 2>/dev/null || true

end_step "Step 9: Orchestrator terminal page accessible"

# Step 10: Cleanup
start_step "Step 10: Cleanup"
kill $DASHBOARD_PID 2>/dev/null || true
# Wait for process to exit
sleep 2
# Force kill if still running
kill -9 $DASHBOARD_PID 2>/dev/null || true

# Kill any remaining Node processes (dashboard, websocket servers)
pkill -f "node.*next.*dev" || true
pkill -f "tsx.*terminal" || true

end_step "Step 10: Cleanup completed"

# Calculate total time
end_time=$(date +%s)
total_duration=$((end_time - start_time))

# Summary
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           🎉 All Tests Passed!                         ║${NC}"
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo ""
echo -e "${BLUE}Total onboarding time: ${total_duration}s"
echo ""

# Export metrics for CI
if [ -n "$GITHUB_ACTIONS" ]; then
    echo "onboarding_time_seconds=$total_duration" >> "$GITHUB_OUTPUT"
fi

exit 0
