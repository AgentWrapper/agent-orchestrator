package shellterm

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ShellTerminalRecord is one persisted shell terminal row. It carries only what
// is needed to re-attach after a daemon restart and to decide, at boot, whether
// the row belongs to the running app or to a previous one.
type ShellTerminalRecord struct {
	HandleID   string
	ProjectID  domain.ProjectID
	WorkingDir string
	Title      string
	AppRunID   string
	CreatedAt  time.Time
}

// Store is the shell terminal service's persistence surface. The SQLite store
// satisfies it; the interface lives next to its only consumer so this service
// does not depend on storage internals.
type Store interface {
	InsertShellTerminal(ctx context.Context, rec ShellTerminalRecord) error
	SelectShellTerminalsByAppRunID(ctx context.Context, appRunID string) ([]ShellTerminalRecord, error)
	SelectShellTerminalsFromPreviousAppRuns(ctx context.Context, appRunID string) ([]ShellTerminalRecord, error)
	DeleteShellTerminalByHandleID(ctx context.Context, handleID string) (bool, error)
	DeleteShellTerminalsFromPreviousAppRuns(ctx context.Context, appRunID string) (int64, error)
}
