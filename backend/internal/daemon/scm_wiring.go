package daemon

// This file wires the provider-neutral SCM observer into daemon startup using
// the GitHub provider for v1. It keeps provider setup non-blocking for readiness
// by resolving tokens lazily inside the background observer path.

import (
	"context"
	"errors"
	"log/slog"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startSCMObserver wires the provider-neutral SCM observer with the GitHub
// provider used by v1. Missing credentials do not fail daemon startup; the
// observer performs a lazy credential check in its background goroutine, logs
// one warning, and disables itself before any provider API calls.
func startSCMObserver(ctx context.Context, store *sqlite.Store, lcm *lifecycle.Manager, provider *scmgithub.Provider, logger *slog.Logger) <-chan struct{} {
	if provider == nil {
		return closedDone()
	}
	observer := scmobserve.New(provider, store, lcm, scmobserve.Config{Logger: logger})
	return observer.Start(ctx)
}

// buildSCMProvider constructs the GitHub SCM provider used by both the observer
// (reads) and lifecycle's duplicate-PR auto-comment (writes). A setup failure
// (e.g. no token) logs one warning and returns nil, which disables both the
// observer and the auto-comment without failing daemon startup.
func buildSCMProvider(logger *slog.Logger) *scmgithub.Provider {
	provider, err := newGitHubSCMProvider(logger)
	if err != nil {
		logSCMProviderDisabled(logger, err)
		return nil
	}
	return provider
}

// scmCommenter adapts the optional SCM provider to the lifecycle commenter
// surface, returning nil (not a typed-nil interface) when no provider is
// available so lifecycle's nil check works.
func scmCommenter(provider *scmgithub.Provider) ports.SCMCommenter {
	if provider == nil {
		return nil
	}
	return provider
}

func newGitHubSCMProvider(logger *slog.Logger) (*scmgithub.Provider, error) {
	tokens := scmgithub.FallbackTokenSource{
		scmgithub.EnvTokenSource{EnvVars: []string{"AO_GITHUB_TOKEN"}},
		&scmgithub.GHTokenSource{},
	}
	// Avoid token preflight on daemon startup and session service construction.
	// GHTokenSource may shell out to `gh`, which is too slow/flaky for the startup
	// readiness path. Provider calls resolve credentials lazily when claim-pr or
	// the background observer actually needs GitHub.
	return scmgithub.NewProvider(scmgithub.ProviderOptions{Token: tokens, SkipTokenPreflight: true, Logger: logger})
}

func logSCMProviderDisabled(logger *slog.Logger, err error) {
	if errors.Is(err, scmgithub.ErrNoToken) || errors.Is(err, scmgithub.ErrAuthFailed) {
		logger.Warn("scm observer disabled: no usable GitHub token", "err", err)
	} else {
		logger.Warn("scm observer disabled: GitHub provider setup failed", "err", err)
	}
}

func closedDone() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}
