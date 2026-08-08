package daemon

import (
	"context"
	"time"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// prerequisiteInstallTimeout bounds a package-manager run. `brew install tmux`
// is seconds on a warm install and minutes on a cold one that has to update the
// formula index, so this is generous; it exists to stop a wedged install from
// pinning a request forever, not to police a slow network.
const prerequisiteInstallTimeout = 10 * time.Minute

// runPrerequisiteInstall runs an install command with no terminal attached. The
// controller only ever hands it commands that do not need root, so nothing here
// can block on a password prompt.
func runPrerequisiteInstall(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, prerequisiteInstallTimeout)
	defer cancel()
	return aoprocess.CommandContext(ctx, name, args...).CombinedOutput()
}
