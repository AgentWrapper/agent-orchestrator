package daemon

import (
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// restoreMobileOnBoot re-arms the Connect Mobile LAN listener across daemon
// restarts. If the persisted state says the bridge was enabled, it reuses the
// existing password (no rotation — the paired phone keeps working), deriving the
// auth hash in memory, and restarts the listener on its last bound port. A
// non-nil return means the listener failed to (re)bind; the caller logs it as a
// warning and continues booting regardless — Connect Mobile is best-effort, not
// load-bearing.
func restoreMobileOnBoot(path string, lan controllers.LANController) error {
	state, err := mobilebridge.Load(path)
	if err != nil {
		return fmt.Errorf("load mobile bridge state: %w", err)
	}
	if !state.Enabled {
		return nil
	}
	lan.SetPasswordHash(mobilebridge.HashPassword(state.Password))
	if _, err := lan.Start(state.LastPort); err != nil {
		return fmt.Errorf("restart mobile LAN listener: %w", err)
	}
	return nil
}
