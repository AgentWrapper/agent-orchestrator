package daemon

// This file wires the provider-neutral SCM observer into daemon startup using
// the resolver's virtual GitHub default bundle. Mixed-provider batching remains
// a later observer change.

import (
	"context"
	"log/slog"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/scmregistry"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func newProjectProviderResolver(store scmregistry.ConnectionStore, credentials ports.CredentialStore, logger *slog.Logger) *scmregistry.Resolver {
	return scmregistry.New(scmregistry.Deps{
		Connections: store,
		Credentials: credentials,
		Factories: map[domain.SCMProvider]scmregistry.ProviderFactory{
			domain.SCMProviderGitHub: scmregistry.NewGitHubFactory(scmregistry.GitHubFactoryOptions{Logger: logger}),
		},
		GitHubFallback:          &scmgithub.GHTokenSource{},
		SkipCredentialPreflight: true,
	})
}

func legacyGitHubProject() domain.ProjectRecord { return domain.ProjectRecord{} }

// startSCMObserver wires the provider-neutral SCM observer with the GitHub
// provider used by v1. Missing credentials do not fail daemon startup; the
// observer performs a lazy credential check in its background goroutine, logs
// one warning, and disables itself before any provider API calls.
func startSCMObserver(ctx context.Context, store *sqlite.Store, lcm *lifecycle.Manager, providers scmregistry.ProjectProviderResolver, logger *slog.Logger) <-chan struct{} {
	bundle, err := providers.Resolve(ctx, legacyGitHubProject())
	if err != nil {
		logSCMProviderDisabled(logger, err)
		return closedDone()
	}
	observer := scmobserve.New(bundle.SCM, store, lcm, scmobserve.Config{Logger: logger})
	return observer.Start(ctx)
}

func logSCMProviderDisabled(logger *slog.Logger, err error) {
	logger.Warn("scm observer disabled: GitHub provider setup failed", "err", err)
}

func closedDone() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}
