package daemon

// This file wires the provider-neutral SCM observer into daemon startup through
// the shared project provider resolver.

import (
	"context"
	"fmt"
	"log/slog"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/scmregistry"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func newProjectProviderResolver(store scmregistry.ConnectionStore, credentials ports.CredentialStore, logger *slog.Logger) *scmregistry.Resolver {
	return scmregistry.New(scmregistry.Deps{
		Connections: store,
		Credentials: credentials,
		Factories: map[domain.SCMProvider]scmregistry.ProviderFactory{
			domain.SCMProviderGitHub: scmregistry.NewGitHubFactory(scmregistry.GitHubFactoryOptions{Logger: logger}),
			domain.SCMProviderGitLab: scmregistry.NewGitLabFactory(scmregistry.GitLabFactoryOptions{Logger: logger}),
		},
		GitHubFallback:          &scmgithub.GHTokenSource{},
		SkipCredentialPreflight: true,
	})
}

type sessionProjectProviderResolver struct {
	providers scmregistry.ProjectProviderResolver
}

func (r sessionProjectProviderResolver) ResolveProjectProvider(ctx context.Context, project domain.ProjectRecord) (sessionsvc.ProjectProviderBundle, error) {
	bundle, err := r.providers.Resolve(ctx, project)
	if err != nil {
		return sessionsvc.ProjectProviderBundle{}, err
	}
	return sessionsvc.ProjectProviderBundle{SCM: bundle.SCM, Tracker: bundle.Tracker}, nil
}

type projectSCMResolver struct {
	providers scmregistry.ProjectProviderResolver
}

func (r projectSCMResolver) ResolveSCM(ctx context.Context, project domain.ProjectRecord) (scmobserve.ResolvedProvider, error) {
	bundle, err := r.providers.Resolve(ctx, project)
	if err != nil {
		return scmobserve.ResolvedProvider{}, err
	}
	return scmobserve.ResolvedProvider{
		Provider:     bundle.SCM,
		ConnectionID: project.Config.SCM.WithDefaults().ConnectionID,
	}, nil
}

type sessionReviewPublisherResolver struct {
	store     *sqlite.Store
	providers scmregistry.ProjectProviderResolver
}

func (r sessionReviewPublisherResolver) ResolveReviewPublisher(ctx context.Context, workerID domain.SessionID) (ports.SCMReviewPublisher, error) {
	worker, ok, err := r.store.GetSession(ctx, workerID)
	if err != nil {
		return nil, fmt.Errorf("load review worker: %w", err)
	}
	if !ok {
		return nil, fmt.Errorf("review worker %s not found", workerID)
	}
	project, ok, err := r.store.GetProject(ctx, string(worker.ProjectID))
	if err != nil {
		return nil, fmt.Errorf("load review project: %w", err)
	}
	if !ok {
		return nil, fmt.Errorf("review project %s not found", worker.ProjectID)
	}
	bundle, err := r.providers.Resolve(ctx, project)
	if err != nil {
		return nil, err
	}
	if bundle.ReviewPublisher == nil {
		return nil, fmt.Errorf("review publisher is unavailable for project %s", project.ID)
	}
	return bundle.ReviewPublisher, nil
}

// startSCMObserver resolves each active project's provider during discovery so
// GitHub and GitLab connections can be polled by the same daemon.
func startSCMObserver(ctx context.Context, store *sqlite.Store, lcm *lifecycle.Manager, providers scmregistry.ProjectProviderResolver, logger *slog.Logger) <-chan struct{} {
	observer := scmobserve.NewWithResolver(projectSCMResolver{providers: providers}, store, lcm, scmobserve.Config{Logger: logger})
	return observer.Start(ctx)
}
