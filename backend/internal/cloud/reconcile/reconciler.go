// Package reconcile converges durable AO Cloud sandbox intent with provider
// reality. HTTP handlers record intent; this loop performs slow provider work.
package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type store interface {
	ClaimSandboxes(context.Context, string, int, time.Duration) ([]clouddomain.Sandbox, error)
	IssueAccessTicket(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, []string, time.Duration) (string, error)
	UpdateSandboxObservation(context.Context, string, clouddomain.SessionID, string, string, string, time.Time) error
	ReleaseSandboxClaim(context.Context, string, clouddomain.SessionID, time.Time) error
	AppendEvent(context.Context, clouddomain.AccountID, clouddomain.SessionID, string, json.RawMessage) (clouddomain.Event, error)
	DeleteSession(context.Context, clouddomain.AccountID, clouddomain.SessionID) error
}

// Reconciler converges durable sandbox intent with provider state.
type Reconciler struct {
	store          store
	providers      providerResolver
	publicURL      string
	workerSnapshot string
	workerImage    string
	owner          string
	interval       time.Duration
	log            *slog.Logger
	workerBinary   []byte
}

type providerResolver interface {
	Resolve(context.Context, clouddomain.Sandbox) (cloudsandbox.Provider, error)
}

// New creates a sandbox reconciler.
func New(
	store store,
	providers providerResolver,
	publicURL string,
	workerSnapshot string,
	workerImage string,
	interval time.Duration,
	workerBinary []byte,
	log *slog.Logger,
) *Reconciler {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	return &Reconciler{
		store:          store,
		providers:      providers,
		publicURL:      strings.TrimRight(publicURL, "/"),
		workerSnapshot: workerSnapshot,
		workerImage:    workerImage,
		owner:          uuid.NewString(),
		interval:       interval,
		workerBinary:   append([]byte(nil), workerBinary...),
		log:            log,
	}
}

// Run reconciles sandboxes until ctx is canceled.
func (r *Reconciler) Run(ctx context.Context) error {
	if err := r.reconcileOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		r.log.Error("initial cloud sandbox reconciliation failed", "err", err)
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.reconcileOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				r.log.Error("cloud sandbox reconciliation failed", "err", err)
			}
		}
	}
}

func (r *Reconciler) reconcileOnce(ctx context.Context) error {
	sandboxes, err := r.store.ClaimSandboxes(ctx, r.owner, 20, 30*time.Second)
	if err != nil {
		return err
	}
	for _, sandbox := range sandboxes {
		if err := r.reconcileSandbox(ctx, sandbox); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			r.log.Warn("sandbox reconciliation attempt failed",
				"session_id", sandbox.SessionID,
				"provider_id", sandbox.ProviderEnvironmentID,
				"err", err,
			)
		}
	}
	return nil
}

func (r *Reconciler) reconcileSandbox(ctx context.Context, sandbox clouddomain.Sandbox) error {
	provider, err := r.providers.Resolve(ctx, sandbox)
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	if sandbox.DesiredState == "deleted" {
		if sandbox.ProviderEnvironmentID == "" {
			r.log.Info("removing deleted cloud session without provider environment",
				"session_id", sandbox.SessionID,
				"provider", sandbox.Provider,
			)
			return r.deleteSession(ctx, sandbox)
		}
		r.log.Info("deleting cloud sandbox",
			"session_id", sandbox.SessionID,
			"provider", sandbox.Provider,
			"provider_id", sandbox.ProviderEnvironmentID,
		)
		err := provider.Delete(ctx, cloudsandbox.ID(sandbox.ProviderEnvironmentID))
		if err != nil && !errors.Is(err, cloudsandbox.ErrNotFound) {
			return r.fail(ctx, sandbox, err)
		}
		return r.deleteSession(ctx, sandbox)
	}
	if sandbox.ProviderEnvironmentID == "" {
		return r.provision(ctx, sandbox, provider)
	}

	environment, err := provider.Get(ctx, cloudsandbox.ID(sandbox.ProviderEnvironmentID))
	if errors.Is(err, cloudsandbox.ErrNotFound) {
		if sandbox.DesiredState == "running" {
			return r.observe(ctx, sandbox, "", "requested", "provider environment disappeared", 2*time.Second)
		}
		return r.observe(ctx, sandbox, "", "deleted", "", 24*time.Hour)
	}
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	if sandbox.DesiredState == "paused" {
		if environment.State != "stopped" && environment.State != "paused" && environment.State != "archived" {
			if err := provider.Stop(ctx, environment.ID); err != nil {
				return r.fail(ctx, sandbox, err)
			}
		}
		return r.observe(ctx, sandbox, string(environment.ID), "paused", "", 30*time.Second)
	}
	if sandbox.DesiredState == "running" {
		switch environment.State {
		case "deleted":
			return r.observe(ctx, sandbox, "", "requested", "provider environment was destroyed", 2*time.Second)
		case "deleting":
			return r.observe(ctx, sandbox, string(environment.ID), "deleting", "", 2*time.Second)
		case "stopped", "archived":
			if recreator, ok := provider.(cloudsandbox.Recreator); ok {
				return r.recreate(ctx, sandbox, environment, recreator)
			}
			r.log.Info("starting cloud sandbox",
				"session_id", sandbox.SessionID,
				"provider", sandbox.Provider,
				"provider_id", environment.ID,
			)
			if err := provider.Start(ctx, environment.ID); err != nil {
				return r.fail(ctx, sandbox, err)
			}
			return r.observe(ctx, sandbox, string(environment.ID), "bootstrapping", "", 2*time.Second)
		case "paused":
			if recreator, ok := provider.(cloudsandbox.Recreator); ok {
				return r.recreate(ctx, sandbox, environment, recreator)
			}
			r.log.Info("resuming cloud sandbox",
				"session_id", sandbox.SessionID,
				"provider", sandbox.Provider,
				"provider_id", environment.ID,
			)
			if err := provider.Resume(ctx, environment.ID); err != nil {
				return r.fail(ctx, sandbox, err)
			}
			return r.observe(ctx, sandbox, string(environment.ID), "bootstrapping", "", 2*time.Second)
		case "started", "running", "ready":
			startupExpired := (sandbox.ObservedState == "provisioning" ||
				sandbox.ObservedState == "bootstrapping") &&
				sandbox.WorkerLastSeenAt == nil &&
				time.Since(sandbox.UpdatedAt) >= 30*time.Second
			heartbeatExpired := sandbox.WorkerLastSeenAt != nil &&
				time.Since(*sandbox.WorkerLastSeenAt) >= time.Minute
			if sandbox.ObservedState == "failed" || startupExpired || heartbeatExpired {
				if recreator, ok := provider.(cloudsandbox.Recreator); ok {
					return r.recreate(ctx, sandbox, environment, recreator)
				}
				if len(r.workerBinary) > 0 {
					bootstrapper, ok := provider.(cloudsandbox.Bootstrapper)
					if ok {
						spec, err := r.workerSpec(ctx, sandbox)
						if err != nil {
							return r.fail(ctx, sandbox, err)
						}
						if err := bootstrapper.BootstrapWorker(
							ctx,
							environment.ID,
							cloudsandbox.WorkerBootstrap{
								Binary:      r.workerBinary,
								Destination: "/home/ao/.local/bin/ao-worker",
								Environment: spec.Environment,
							},
						); err != nil {
							return r.fail(ctx, sandbox, err)
						}
						return r.observe(ctx, sandbox, string(environment.ID), "bootstrapping", "", 30*time.Second)
					}
				}
			}
			state := sandbox.ObservedState
			if state != "running" {
				state = "bootstrapping"
			}
			return r.observe(ctx, sandbox, string(environment.ID), state, "", 5*time.Second)
		case "creating", "starting", "restoring":
			return r.observe(ctx, sandbox, string(environment.ID), "provisioning", "", 2*time.Second)
		default:
			return r.observe(ctx, sandbox, string(environment.ID), "provisioning", "", 5*time.Second)
		}
	}
	return r.store.ReleaseSandboxClaim(ctx, r.owner, sandbox.SessionID, time.Now().Add(30*time.Second))
}

func (r *Reconciler) deleteSession(ctx context.Context, sandbox clouddomain.Sandbox) error {
	if err := r.store.DeleteSession(ctx, sandbox.AccountID, sandbox.SessionID); err != nil &&
		!errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		return err
	}
	return nil
}

func (r *Reconciler) recreate(
	ctx context.Context,
	sandbox clouddomain.Sandbox,
	environment cloudsandbox.Environment,
	recreator cloudsandbox.Recreator,
) error {
	spec, err := r.workerSpec(ctx, sandbox)
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	r.log.Info("recreating cloud sandbox with fresh worker credentials",
		"session_id", sandbox.SessionID,
		"provider", sandbox.Provider,
		"provider_id", environment.ID,
	)
	recreated, err := recreator.Recreate(ctx, environment.ID, spec)
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	return r.observe(ctx, sandbox, string(recreated.ID), "bootstrapping", "", 2*time.Second)
}

func (r *Reconciler) provision(
	ctx context.Context,
	sandbox clouddomain.Sandbox,
	provider cloudsandbox.Provider,
) error {
	existing, found, err := provider.FindBySession(ctx, sandbox.SessionID)
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	if found {
		return r.observe(ctx, sandbox, string(existing.ID), "provisioning", "", time.Second)
	}
	spec, err := r.workerSpec(ctx, sandbox)
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	provisioningPayload, _ := json.Marshal(map[string]string{"provider": sandbox.Provider})
	_, _ = r.store.AppendEvent(
		ctx,
		sandbox.AccountID,
		sandbox.SessionID,
		"sandbox.provisioning",
		provisioningPayload,
	)

	// Cloud V1 currently caps provider resources at 4 vCPU, 8 GiB RAM, and
	// 10 GiB persistent disk.
	r.log.Info("provisioning cloud sandbox",
		"session_id", sandbox.SessionID,
		"provider", sandbox.Provider,
	)
	startedAt := time.Now()
	environment, err := provider.Create(ctx, spec)
	if err != nil {
		return r.fail(ctx, sandbox, err)
	}
	r.log.Info("cloud sandbox provisioned",
		"session_id", sandbox.SessionID,
		"provider", sandbox.Provider,
		"provider_id", environment.ID,
		"duration_ms", time.Since(startedAt).Milliseconds(),
	)
	return r.observe(ctx, sandbox, string(environment.ID), "provisioning", "", 2*time.Second)
}

func (r *Reconciler) workerSpec(
	ctx context.Context,
	sandbox clouddomain.Sandbox,
) (cloudsandbox.Spec, error) {
	ticket, err := r.store.IssueAccessTicket(
		ctx,
		sandbox.AccountID,
		sandbox.SessionID,
		"worker_bootstrap",
		[]string{"worker:connect", "worker:event", "worker:terminal", "worker:git", "worker:orchestrate"},
		10*time.Minute,
	)
	if err != nil {
		return cloudsandbox.Spec{}, err
	}
	return cloudsandbox.Spec{
		Name:            "ao-" + string(sandbox.SessionID),
		SessionID:       sandbox.SessionID,
		Snapshot:        r.workerSnapshot,
		Image:           r.workerImage,
		ResourceProfile: clouddomain.ResourceProfile{CPU: 4, Memory: 8, Disk: 10},
		Environment: map[string]string{
			"AO_CLOUD_PUBLIC_URL":       r.publicURL,
			"AO_CLOUD_SESSION_ID":       string(sandbox.SessionID),
			"AO_WORKER_BOOTSTRAP_TOKEN": ticket,
			"AO_WORKSPACE_DIR":          "/workspace/repository",
			"AO_DATA_DIR":               "/workspace/.ao/worker",
			"HOME":                      "/workspace/.ao/home",
			"CLAUDE_CONFIG_DIR":         "/workspace/.ao/home/.claude",
			"CODEX_HOME":                "/workspace/.ao/home/.codex",
		},
		Labels: map[string]string{
			"ao.session_id": string(sandbox.SessionID),
			"ao.account_id": string(sandbox.AccountID),
			"ao.managed":    "true",
		},
		AutoStopMinutes:   30,
		AutoDeleteMinutes: 7 * 24 * 60,
	}, nil
}

func (r *Reconciler) fail(ctx context.Context, sandbox clouddomain.Sandbox, cause error) error {
	updateErr := r.observe(ctx, sandbox, sandbox.ProviderEnvironmentID, "failed", cause.Error(), 15*time.Second)
	if updateErr != nil && !errors.Is(updateErr, cloudpostgres.ErrSandboxLeaseLost) {
		return errors.Join(cause, updateErr)
	}
	return cause
}

func (r *Reconciler) observe(
	ctx context.Context,
	sandbox clouddomain.Sandbox,
	providerID, state, lastError string,
	after time.Duration,
) error {
	return r.store.UpdateSandboxObservation(
		ctx,
		r.owner,
		sandbox.SessionID,
		providerID,
		state,
		lastError,
		time.Now().Add(after),
	)
}
