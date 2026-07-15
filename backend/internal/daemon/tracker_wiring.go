package daemon

import (
	"errors"
	"log/slog"

	trackergithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func newGitHubTracker() (ports.Tracker, error) {
	return trackergithub.New(trackergithub.Options{Token: trackergithub.EnvTokenSource{EnvVars: []string{"AO_GITHUB_TOKEN"}}})
}

func logTrackerDisabled(logger *slog.Logger, err error) {
	if errors.Is(err, trackergithub.ErrNoToken) {
		logger.Warn("tracker issue prompt enrichment disabled: no usable GitHub token", "err", err)
	} else {
		logger.Warn("tracker issue prompt enrichment disabled: GitHub tracker setup failed", "err", err)
	}
}
