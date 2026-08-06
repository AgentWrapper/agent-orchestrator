package omp

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"

	_ "modernc.org/sqlite" // register sqlite driver for the OMP agent.db credential probe
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// ompAPIKeyEnvVars mirrors the provider API-key env vars OMP itself resolves
// credentials from (see environment-variables.md); any one present is a fast,
// definite "authorized" signal without touching agent.db.
var ompAPIKeyEnvVars = []string{
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"CEREBRAS_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
}

// AuthStatus checks whether OMP has at least one enabled credential, without
// making a model call. It checks provider API-key env vars first, then the
// local agent.db credential store (multi-provider, multi-credential; see
// session.md/porting-from-pi-mono.md), falling back to a generic CLI probe.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.ompBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}

	for _, name := range ompAPIKeyEnvVars {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return ports.AgentAuthStatusAuthorized, nil
		}
	}

	if status, ok, err := ompDBAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}

	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return authprobe.CLIStatus(probeCtx, binary, [][]string{{"auth-broker", "status"}})
}

// ompConfigDir returns OMP's agent directory: PI_CODING_AGENT_DIR verbatim
// when set (full override, default profile only), else
// $HOME/<PI_CONFIG_DIR or .omp>/agent.
func ompConfigDir() (string, bool) {
	if dir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR")); dir != "" {
		return dir, true
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", false
	}
	root := strings.TrimSpace(os.Getenv("PI_CONFIG_DIR"))
	if root == "" {
		root = ".omp"
	}
	return filepath.Join(home, root, "agent"), true
}

// ompDBAuthStatus opens agent.db read-only and reports whether at least one
// credential row has no disabled_cause. A missing file/table (older or
// relocated OMP install) is reported as "not determined" (ok=false) rather
// than unauthorized, so callers fall back to the generic CLI probe instead of
// asserting a negative from an absent database.
func ompDBAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	configDir, ok := ompConfigDir()
	if !ok {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	dbPath := filepath.Join(configDir, "agent.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	} else if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?mode=ro&_pragma=busy_timeout(1000)")
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	defer func() {
		_ = db.Close()
	}()

	var enabledCount int
	err = db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_credentials WHERE disabled_cause IS NULL`,
	).Scan(&enabledCount)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return ports.AgentAuthStatusUnknown, false, nil
		}
		return ports.AgentAuthStatusUnknown, false, err
	}
	if enabledCount > 0 {
		return ports.AgentAuthStatusAuthorized, true, nil
	}

	var totalCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM auth_credentials`).Scan(&totalCount); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if totalCount > 0 {
		// Rows exist but every one is disabled (all disabled_cause set).
		return ports.AgentAuthStatusUnauthorized, true, nil
	}
	return ports.AgentAuthStatusUnauthorized, true, nil
}
