package daemon

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/agenthealth"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

// coreHealthHarnesses are always monitored, on top of whatever any project
// configures: they are the fleet defaults (the daemon default is claude-code)
// and the ones an operator is most likely to have logged in. Including them
// unconditionally means a project-less daemon still watches the harnesses ao
// almost always spawns — and a codex login expiring is alerted even before any
// project pins codex in its mix.
var coreHealthHarnesses = []string{
	string(domain.HarnessClaudeCode),
	string(domain.HarnessCodex),
	string(domain.HarnessCodexFugu),
}

// projectConfigLister is the slice of the project service the health monitor
// needs to discover which harnesses are configured across all projects.
type projectConfigLister interface {
	List(ctx context.Context) ([]projectsvc.Summary, error)
	Get(ctx context.Context, id domain.ProjectID) (projectsvc.GetResult, error)
}

// configuredHarnesses returns the set of harness ids to health-check: the
// daemon default agent, the core fleet, and every harness any registered
// project references (worker, worker-mix buckets, orchestrator, reviewers). It
// is recomputed each cycle so a newly-configured harness is picked up without a
// daemon restart. A project List/Get error degrades gracefully — the core set
// is still returned — rather than dropping the whole health loop.
func configuredHarnesses(ctx context.Context, projects projectConfigLister, defaultAgent string, log *slog.Logger) []string {
	set := map[string]struct{}{}
	add := func(h string) {
		if h = strings.TrimSpace(h); h != "" {
			set[h] = struct{}{}
		}
	}
	add(defaultAgent)
	for _, h := range coreHealthHarnesses {
		add(h)
	}
	if projects != nil {
		summaries, err := projects.List(ctx)
		if err != nil {
			if log != nil {
				log.Warn("agent-health: listing projects for harness set failed; using core set", "err", err)
			}
			return sortedKeys(set)
		}
		for _, s := range summaries {
			res, err := projects.Get(ctx, s.ID)
			if err != nil || res.Project == nil || res.Project.Config == nil {
				continue
			}
			cfg := res.Project.Config
			add(string(cfg.Worker.Harness))
			add(string(cfg.Orchestrator.Harness))
			add(string(cfg.Prime.Harness))
			for _, bucket := range cfg.WorkerMix {
				add(string(bucket.Harness))
			}
			for _, reviewer := range cfg.Reviewers {
				add(string(reviewer.Harness))
			}
		}
	}
	return sortedKeys(set)
}

func sortedKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// agentHealthProber adapts the agent catalog service to agenthealth.Prober.
type agentHealthProber struct {
	svc *agentsvc.Service
}

func (p agentHealthProber) HarnessHealth(ctx context.Context, ids []string) ([]agenthealth.Probe, error) {
	probes, err := p.svc.HarnessHealth(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]agenthealth.Probe, len(probes))
	for i, pr := range probes {
		out[i] = agenthealth.Probe{
			ID:         pr.ID,
			Label:      pr.Label,
			Installed:  pr.Installed,
			AuthStatus: pr.AuthStatus,
		}
	}
	return out, nil
}

// startAgentHealth builds the agent-health monitor and, when a positive
// interval is configured, starts its background poll loop. The monitor is
// always returned so the /agents/health endpoint reports a (possibly empty)
// snapshot even when the loop is disabled (AO_AGENT_HEALTH_INTERVAL=0). The
// returned channel closes when the loop goroutine exits; it is already closed
// when the loop is disabled so shutdown never blocks.
//
// The loop is intentionally async and bounded: observe.StartPollLoop runs the
// first probe inside the goroutine (never on the readiness path), and each
// harness probe carries the agent catalog's own install/auth timeouts, so a
// slow or hung agent CLI can never stall daemon startup or shutdown.
func startAgentHealth(ctx context.Context, cfg agentHealthConfig, svc *agentsvc.Service, projects projectConfigLister, log *slog.Logger) (*agenthealth.Monitor, <-chan struct{}) {
	monitor := agenthealth.New(agenthealth.Deps{
		Prober: agentHealthProber{svc: svc},
		Harnesses: func(ctx context.Context) []string {
			return configuredHarnesses(ctx, projects, cfg.DefaultAgent, log)
		},
		Logger: log,
	})
	if cfg.Interval <= 0 {
		if log != nil {
			log.Info("agent-health monitor disabled (AO_AGENT_HEALTH_INTERVAL=0)")
		}
		closed := make(chan struct{})
		close(closed)
		return monitor, closed
	}
	done := observe.StartPollLoop(ctx, cfg.Interval, monitor.Check, log, "agent health")
	return monitor, done
}

// agentHealthConfig is the subset of daemon config the health loop needs.
type agentHealthConfig struct {
	Interval     time.Duration
	DefaultAgent string
}
