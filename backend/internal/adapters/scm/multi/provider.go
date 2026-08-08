// Package multi provides a composite SCM provider that dispatches to
// per-host sub-providers based on the SCMRepo.Provider key set by
// ParseRepository. This allows the SCM observer to poll both GitHub and
// GitLab (and future providers) through a single Provider instance.
package multi

import (
	"context"
	"fmt"
	"time"

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

// ListPRsByRepo delegates to the sub-provider matching repo.Provider.
func (m *Provider) ListPRsByRepo(ctx context.Context, repo ports.SCMRepo, updatedAfter time.Time) ([]ports.SCMPRObservation, error) {
	p, err := m.resolve(repo.Provider)
	if err != nil {
		return nil, err
	}
	return p.ListPRsByRepo(ctx, repo, updatedAfter)
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
//
// Provider failures are scoped to their own refs: a GitLab timeout must not
// suppress successful GitHub observations. A failing provider leaves
// Fetched=false placeholders for its refs; healthy-provider results continue
// through persistence. An error is returned only when ALL groups fail, so the
// observer can mark repos as failed without discarding healthy results
func (m *Provider) FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	// Partition refs by provider key.
	groups := make(map[string][]indexedRef)
	for i, r := range refs {
		groups[r.Repo.Provider] = append(groups[r.Repo.Provider], indexedRef{idx: i, ref: r})
	}

	results := make([]ports.SCMObservation, len(refs))
	groupErrs := make(map[string]error)

	for key, irefs := range groups {
		p, err := m.resolve(key)
		if err != nil {
			groupErrs[key] = err
			for _, ir := range irefs {
				results[ir.idx] = ports.SCMObservation{
					Fetched:  false,
					Provider: key,
					PR:       ports.SCMPRObservation{Number: ir.ref.Number, URL: ir.ref.URL},
				}
			}
			continue
		}
		batch := make([]ports.SCMPRRef, len(irefs))
		for j, ir := range irefs {
			batch[j] = ir.ref
		}
		obs, err := p.FetchPullRequests(ctx, batch)
		if err != nil {
			groupErrs[key] = err
		}
		for j, ir := range irefs {
			if j < len(obs) {
				results[ir.idx] = obs[j]
			} else {
				// Provider returned fewer observations than refs — leave a
				// Fetched=false placeholder so the observer rejects it.
				results[ir.idx] = ports.SCMObservation{
					Fetched:  false,
					Provider: key,
					PR:       ports.SCMPRObservation{Number: ir.ref.Number, URL: ir.ref.URL},
				}
			}
			// Attach the failed provider's error as transient per-observation
			// metadata so the observer can route rate-limit errors to
			// per-provider cooldown and non-rate-limit errors to
			// refresh-incomplete, without discarding the classification
			// (review Item 7). The observer nils this out before persistence.
			if err != nil {
				results[ir.idx].Error = err
			}
		}
	}

	// Return an error only if ALL groups failed; otherwise healthy-provider
	// results are returned with a nil error so the observer can persist them.
	if len(groupErrs) > 0 && len(groupErrs) == len(groups) {
		// All groups failed — return the first group's error.
		for _, err := range groupErrs {
			return results, err
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
// When no provider reports usable credentials, the first real error (if any)
// is returned so CheckCredentialsOnce retries on the next poll rather than
// definitively disabling SCM observation until daemon restart (review Item 8).
// A healthy provider's success always wins and suppresses transient errors
// from other providers.
func (m *Provider) SCMCredentialsAvailable(ctx context.Context) (bool, error) {
	var firstErr error
	for _, np := range m.ordered {
		cc, ok := np.Provider.(credentialChecker)
		if !ok {
			continue
		}
		avail, err := cc.SCMCredentialsAvailable(ctx)
		if avail {
			return true, nil
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return false, firstErr
}

type indexedRef struct {
	idx int
	ref ports.SCMPRRef
}
