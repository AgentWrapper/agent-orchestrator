// Package warmpool maintains clean, unassigned ECS tasks for fast session claims.
package warmpool

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/smithy-go"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type store interface {
	TryAcquireECSWarmPoolLease(context.Context) (cloudpostgres.ECSWarmPoolLeaseHandle, bool, error)
	ReserveECSWarmTask(context.Context, string, int) (cloudpostgres.ECSWarmTask, string, bool, error)
	ListECSWarmTasks(context.Context, string) ([]cloudpostgres.ECSWarmTask, error)
	ActivateECSWarmTask(context.Context, string, string) error
	MarkECSWarmTaskReady(context.Context, string) error
	FailECSWarmTask(context.Context, string, error) error
	RetireECSWarmTask(context.Context, string) (string, bool, error)
	CompleteECSWarmTaskStop(context.Context, string) error
}

type provider interface {
	CreateWarmTask(context.Context, string, string, string, string, clouddomain.ResourceProfile) (cloudsandbox.Environment, error)
	FindWarmTask(context.Context, string) (cloudsandbox.Environment, bool, error)
	Get(context.Context, cloudsandbox.ID) (cloudsandbox.Environment, error)
	Delete(context.Context, cloudsandbox.ID) error
}

// Manager maintains a target number of clean ready tasks for one release generation.
type Manager struct {
	store      store
	provider   provider
	publicURL  string
	generation string
	target     int
	interval   time.Duration
	readyWait  time.Duration
	nextLaunch time.Time
	backoff    time.Duration
	log        *slog.Logger
}

// New creates an ECS warm-pool manager.
func New(
	store store,
	provider provider,
	publicURL, generation string,
	target int,
	log *slog.Logger,
) *Manager {
	if log == nil {
		log = slog.Default()
	}
	if target < 0 {
		target = 0
	}
	return &Manager{
		store:      store,
		provider:   provider,
		publicURL:  strings.TrimRight(publicURL, "/"),
		generation: strings.TrimSpace(generation),
		target:     target,
		interval:   2 * time.Second,
		readyWait:  2 * time.Minute,
		backoff:    5 * time.Second,
		log:        log,
	}
}

// Run reconciles warm capacity until the process stops.
func (m *Manager) Run(ctx context.Context) error {
	lease, err := m.acquireLease(ctx)
	if err != nil {
		return err
	}
	defer lease.Release(context.Background())
	if err := m.reconcile(ctx); err != nil && !errors.Is(err, context.Canceled) {
		m.log.Warn("initial ECS warm-pool reconciliation failed", "err", err)
	}
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if !lease.Valid(ctx) {
				return errors.New("ECS warm-pool leadership lease was lost")
			}
			if err := m.reconcile(ctx); err != nil && !errors.Is(err, context.Canceled) {
				m.log.Warn("ECS warm-pool reconciliation failed", "err", err)
			}
		}
	}
}

func (m *Manager) acquireLease(
	ctx context.Context,
) (cloudpostgres.ECSWarmPoolLeaseHandle, error) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		lease, acquired, err := m.store.TryAcquireECSWarmPoolLease(ctx)
		if err != nil {
			return nil, err
		}
		if acquired {
			m.log.Info("acquired ECS warm-pool leadership")
			return lease, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (m *Manager) reconcile(ctx context.Context) error {
	tasks, err := m.store.ListECSWarmTasks(ctx, m.generation)
	if err != nil {
		return err
	}
	available := 0
	for _, task := range tasks {
		if task.State == "failed" {
			if task.TaskARN != "" && task.StoppedAt == nil {
				if err := m.finishRetiredTask(ctx, task); err != nil {
					return err
				}
			}
			continue
		}
		if task.Generation != m.generation {
			if task.State == "launching" && task.TaskARN == "" {
				if err := m.reconcileLaunching(ctx, task); err != nil {
					m.log.Warn("old-generation ECS warm launch recovery failed", "task_id", task.ID, "err", err)
				}
				continue
			}
			if err := m.stopUnassigned(ctx, task); err != nil {
				return err
			}
			continue
		}
		switch task.State {
		case "launching":
			if m.target == 0 {
				if task.TaskARN == "" {
					if err := m.reconcileLaunching(ctx, task); err != nil {
						m.log.Warn("disabled ECS warm launch recovery failed", "task_id", task.ID, "err", err)
					}
					continue
				}
				if err := m.stopUnassigned(ctx, task); err != nil {
					return err
				}
				continue
			}
			available++
			if err := m.reconcileLaunching(ctx, task); err != nil {
				m.log.Warn("ECS warm task has not become ready", "task_id", task.ID, "err", err)
			}
		case "ready":
			if m.target == 0 || available >= m.target {
				if err := m.stopUnassigned(ctx, task); err != nil {
					return err
				}
				continue
			}
			available++
			if err := m.checkReady(ctx, task); err != nil {
				m.log.Warn("ECS warm task is no longer healthy", "task_id", task.ID, "err", err)
			}
		}
	}
	if m.target == 0 || available >= m.target || time.Now().Before(m.nextLaunch) {
		return nil
	}
	if err := m.launchOne(ctx); err != nil {
		m.nextLaunch = time.Now().Add(m.backoff)
		m.backoff *= 2
		if m.backoff > 30*time.Second {
			m.backoff = 30 * time.Second
		}
		return err
	}
	m.backoff = 5 * time.Second
	m.nextLaunch = time.Time{}
	return nil
}

func (m *Manager) launchOne(ctx context.Context) error {
	task, token, reserved, err := m.store.ReserveECSWarmTask(
		ctx,
		m.generation,
		m.target,
	)
	if err != nil {
		return err
	}
	if !reserved {
		return nil
	}
	environment, err := m.provider.CreateWarmTask(
		ctx,
		task.ID,
		m.generation,
		m.publicURL,
		token,
		clouddomain.DefaultResourceProfile(),
	)
	token = ""
	if err != nil {
		var apiError smithy.APIError
		if errors.As(err, &apiError) {
			_ = m.store.FailECSWarmTask(ctx, task.ID, err)
		}
		return err
	}
	if err := m.store.ActivateECSWarmTask(ctx, task.ID, string(environment.ID)); err != nil {
		_ = m.provider.Delete(ctx, environment.ID)
		_ = m.store.FailECSWarmTask(ctx, task.ID, err)
		return err
	}
	m.log.Info(
		"ECS warm task launched",
		"task_id", task.ID,
		"provider_id", environment.ID,
		"generation", m.generation,
	)
	return nil
}

func (m *Manager) reconcileLaunching(
	ctx context.Context,
	task cloudpostgres.ECSWarmTask,
) error {
	if task.TaskARN == "" {
		environment, found, err := m.provider.FindWarmTask(ctx, task.ID)
		if err != nil {
			return err
		}
		if found {
			return m.store.ActivateECSWarmTask(ctx, task.ID, string(environment.ID))
		}
		if time.Since(task.CreatedAt) >= m.readyWait {
			err := errors.New("ECS warm task launch was not recovered")
			_ = m.store.FailECSWarmTask(ctx, task.ID, err)
			return err
		}
		return nil
	}
	environment, err := m.provider.Get(ctx, cloudsandbox.ID(task.TaskARN))
	if errors.Is(err, cloudsandbox.ErrNotFound) {
		_ = m.store.FailECSWarmTask(ctx, task.ID, err)
		return err
	}
	if err != nil {
		return err
	}
	switch environment.State {
	case "running", "ready", "started":
		if err := m.store.MarkECSWarmTaskReady(ctx, task.ID); err != nil {
			return err
		}
		m.log.Info("ECS warm task ready", "task_id", task.ID, "provider_id", task.TaskARN)
		return nil
	case "stopped", "deleted":
		err := errors.New("ECS warm task stopped before assignment")
		_ = m.store.FailECSWarmTask(ctx, task.ID, err)
		return err
	default:
		if time.Since(task.CreatedAt) >= m.readyWait {
			err := errors.New("ECS warm task readiness timed out")
			_ = m.stopUnassigned(ctx, task)
			return err
		}
		return nil
	}
}

func (m *Manager) checkReady(ctx context.Context, task cloudpostgres.ECSWarmTask) error {
	environment, err := m.provider.Get(ctx, cloudsandbox.ID(task.TaskARN))
	if err != nil && !errors.Is(err, cloudsandbox.ErrNotFound) {
		return err
	}
	if err == nil && environment.State == "running" {
		return nil
	}
	if err == nil && environment.State != "stopped" && environment.State != "deleted" {
		return errors.New("ECS warm task is temporarily not running")
	}
	if err == nil {
		err = errors.New("ECS warm task is not running")
	}
	_ = m.store.FailECSWarmTask(ctx, task.ID, err)
	return err
}

func (m *Manager) stopUnassigned(
	ctx context.Context,
	task cloudpostgres.ECSWarmTask,
) error {
	taskARN, retired, err := m.store.RetireECSWarmTask(ctx, task.ID)
	if err != nil || !retired {
		return err
	}
	if taskARN != "" {
		if err := m.provider.Delete(ctx, cloudsandbox.ID(taskARN)); err != nil &&
			!errors.Is(err, cloudsandbox.ErrNotFound) {
			return err
		}
	}
	return m.store.CompleteECSWarmTaskStop(ctx, task.ID)
}

func (m *Manager) finishRetiredTask(
	ctx context.Context,
	task cloudpostgres.ECSWarmTask,
) error {
	if err := m.provider.Delete(ctx, cloudsandbox.ID(task.TaskARN)); err != nil &&
		!errors.Is(err, cloudsandbox.ErrNotFound) {
		return err
	}
	return m.store.CompleteECSWarmTaskStop(ctx, task.ID)
}
