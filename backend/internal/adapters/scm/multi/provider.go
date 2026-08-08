// Package multi provides a composite SCM provider that dispatches to
// per-host sub-providers based on the SCMRepo.Provider key set by
// ParseRepository. This allows the SCM observer to poll both GitHub and
// GitLab (and future providers) through a single Provider instance.
package multi

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"

	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
)

// NamedProvider pairs a routing key with a provider. The Key must match the
// string that the provider's ParseRepository sets in SCMRepo.Provider (e.g.
// "github", "gitlab").
type NamedProvider struct {
	Key      string
	Provider scmobserve.Provider
}

// Provider routes calls to the correct sub-provider based on
// SCMRepo.Provider. Registration order determines ParseRepository priority.
type Provider struct {
	ordered []NamedProvider
	byName  map[string]scmobserve.Provider
}

// New creates a Provider from one or more named sub-providers.
func New(providers ...NamedProvider) *Provider {
	m := &Provider{
		ordered: providers,
		byName:  make(map[string]scmobserve.Provider, len(providers)),
	}
	for _, p := range providers {
		m.byName[p.Key] = p.Provider
	}
	return m
}

func (m *Provider) resolve(key string) (scmobserve.Provider, error) {
	if p, ok := m.byName[key]; ok {
		return p, nil
	}
	return nil, fmt.Errorf("scm multi: unknown provider %q", key)
}

// ParseRepository tries each sub-provider in registration order. The first
// match wins; each sub-provider returns false for hosts it doesn't own.
func (m *Provider) ParseRepository(remote string) (ports.SCMRepo, bool) {
	for _, np := range m.ordered {
		if repo, ok := np.Provider.ParseRepository(remote); ok {
			return repo, true
		}
	}
	return ports.SCMRepo{}, false
}

// RepoPRListGuard delegates to the sub-provider matching repo.Provider.
func (m *Provider) RepoPRListGuard(ctx context.Context, repo ports.SCMRepo, etag string) (ports.SCMGuardResult, error) {
	p, err := m.resolve(repo.Provider)
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	return p.RepoPRListGuard(ctx, repo, etag)
}

// ListOpenPRsByRepo delegates to the sub-provider matching repo.Provider.
func (m *Provider) ListOpenPRsByRepo(ctx context.Context, repo ports.SCMRepo) ([]ports.SCMPRObservation, error) {
	p, err := m.resolve(repo.Provider)
	if err != nil {
		return nil, err
	}
	return p.ListOpenPRsByRepo(ctx, repo)
}

// CommitChecksGuard delegates to the sub-provider matching repo.Provider.
func (m *Provider) CommitChecksGuard(ctx context.Context, repo ports.SCMRepo, headSHA, etag string) (ports.SCMGuardResult, error) {
	p, err := m.resolve(repo.Provider)
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	return p.CommitChecksGuard(ctx, repo, headSHA, etag)
}

// FetchPullRequests partitions refs by provider key, batches each group to
// the corresponding sub-provider, and merges the results back in order.
func (m *Provider) FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	// Partition refs by provider key.
	groups := make(map[string][]indexedRef)
	for i, r := range refs {
		groups[r.Repo.Provider] = append(groups[r.Repo.Provider], indexedRef{idx: i, ref: r})
	}

	results := make([]ports.SCMObservation, len(refs))

	for key, irefs := range groups {
		p, err := m.resolve(key)
		if err != nil {
			return nil, err
		}
		batch := make([]ports.SCMPRRef, len(irefs))
		for j, ir := range irefs {
			batch[j] = ir.ref
		}
		obs, err := p.FetchPullRequests(ctx, batch)
		if err != nil {
			return nil, err
		}
		for j, ir := range irefs {
			if j < len(obs) {
				results[ir.idx] = obs[j]
			}
		}
	}
	return results, nil
}

// FetchFailedCheckLogTail delegates to the sub-provider matching repo.Provider.
func (m *Provider) FetchFailedCheckLogTail(ctx context.Context, repo ports.SCMRepo, check ports.SCMCheckObservation) (string, error) {
	p, err := m.resolve(repo.Provider)
	if err != nil {
		return "", err
	}
	return p.FetchFailedCheckLogTail(ctx, repo, check)
}

// FetchReviewThreads delegates to the sub-provider matching ref.Repo.Provider.
func (m *Provider) FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	p, err := m.resolve(ref.Repo.Provider)
	if err != nil {
		return ports.SCMReviewObservation{}, err
	}
	return p.FetchReviewThreads(ctx, ref)
}

type credentialChecker interface {
	SCMCredentialsAvailable(ctx context.Context) (bool, error)
}

// SCMCredentialsAvailable returns true if ANY sub-provider has usable credentials.
func (m *Provider) SCMCredentialsAvailable(ctx context.Context) (bool, error) {
	for _, np := range m.ordered {
		if cc, ok := np.Provider.(credentialChecker); ok {
			avail, err := cc.SCMCredentialsAvailable(ctx)
			if avail {
				return true, nil
			}
			_ = err
		}
	}
	return false, nil
}

type indexedRef struct {
	idx int
	ref ports.SCMPRRef
}
