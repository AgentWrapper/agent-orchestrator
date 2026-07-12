package project

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/candidatehealth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/agenthealth"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/modelhealth"
)

// WorkerCapacityStore is the read surface needed to assemble the worker mix
// capacity dashboard without coupling it to the session manager.
type WorkerCapacityStore interface {
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error)
}

// HealthSnapshotter returns the daemon's last periodic harness-health snapshot.
type HealthSnapshotter interface {
	Snapshot() agenthealth.Snapshot
}

// ModelHealthSnapshotter returns exact configured-model reachability verdicts.
type ModelHealthSnapshotter interface {
	Snapshot() []modelhealth.Verdict
}

// CandidateHealthSnapshotter returns reactive launch-failure state for exact
// worker-mix buckets.
type CandidateHealthSnapshotter interface {
	WorkerMixHealthSnapshot() []candidatehealth.Status
}

// WorkerCapacityOption wires optional health projections.
type WorkerCapacityOption func(*WorkerCapacityService)

// WithModelHealth includes exact model reachability in bucket health.
func WithModelHealth(snapshotter ModelHealthSnapshotter) WorkerCapacityOption {
	return func(s *WorkerCapacityService) { s.modelHealth = snapshotter }
}

// WithCandidateHealth includes reactive launch-failure state in bucket health.
func WithCandidateHealth(snapshotter CandidateHealthSnapshotter) WorkerCapacityOption {
	return func(s *WorkerCapacityService) { s.candidateHealth = snapshotter }
}

// WorkerCapacityService builds the project-scoped worker mix/capacity read model.
type WorkerCapacityService struct {
	store           WorkerCapacityStore
	health          HealthSnapshotter
	modelHealth     ModelHealthSnapshotter
	candidateHealth CandidateHealthSnapshotter
}

// NewWorkerCapacity returns a dashboard read service.
func NewWorkerCapacity(store WorkerCapacityStore, health HealthSnapshotter, opts ...WorkerCapacityOption) *WorkerCapacityService {
	s := &WorkerCapacityService{store: store, health: health}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// WorkerCapacity is the project-scoped worker-capacity dashboard read model.
type WorkerCapacity struct {
	ProjectID             domain.ProjectID        `json:"projectId"`
	Cap                   *int                    `json:"cap,omitempty"`
	ActiveWorkers         int                     `json:"activeWorkers"`
	DownBucketShare       *float64                `json:"downBucketShare,omitempty"`
	AvailableCapacity     *float64                `json:"availableCapacity,omitempty"`
	FreeAvailableCapacity *float64                `json:"freeAvailableCapacity,omitempty"`
	State                 string                  `json:"state" enum:"healthy,degraded,uncapped,unconfigured"`
	Buckets               []WorkerCapacityBucket  `json:"buckets"`
	Harnesses             []WorkerCapacityHarness `json:"harnesses"`
	CheckedAt             time.Time               `json:"checkedAt,omitempty"`
}

// WorkerCapacityBucket is one configured or realized worker mix bucket.
type WorkerCapacityBucket struct {
	Agent             domain.AgentHarness `json:"agent"`
	Model             string              `json:"model,omitempty"`
	TargetPercent     int                 `json:"targetPercent"`
	TargetCapacity    *float64            `json:"targetCapacity,omitempty"`
	ActiveWorkers     int                 `json:"activeWorkers"`
	RealizedPercent   float64             `json:"realizedPercent"`
	Health            agenthealth.Health  `json:"health"`
	Down              bool                `json:"down"`
	BlockedBy         string              `json:"blockedBy,omitempty" enum:"harness_auth,model,launch_failure"`
	DownCapacityShare *float64            `json:"downCapacityShare,omitempty"`
	Reason            string              `json:"reason,omitempty"`
	Remedy            string              `json:"remedy,omitempty"`
}

// WorkerCapacityHarness is the per-harness health shape shown alongside buckets.
type WorkerCapacityHarness struct {
	ID        string             `json:"id"`
	Label     string             `json:"label"`
	Health    agenthealth.Health `json:"health"`
	Reason    string             `json:"reason,omitempty"`
	Remedy    string             `json:"remedy,omitempty"`
	CheckedAt time.Time          `json:"checkedAt,omitempty"`
	ChangedAt time.Time          `json:"changedAt,omitempty"`
}

// WorkerCapacity returns the latest capacity view for one project.
func (s *WorkerCapacityService) WorkerCapacity(ctx context.Context, id domain.ProjectID) (WorkerCapacity, error) {
	if s == nil || s.store == nil || s.health == nil {
		return WorkerCapacity{}, apierr.Internal("WORKER_CAPACITY_UNAVAILABLE", "Worker capacity is unavailable")
	}
	if err := validateProjectID(id); err != nil {
		return WorkerCapacity{}, err
	}
	project, ok, err := s.store.GetProject(ctx, string(id))
	if err != nil {
		return WorkerCapacity{}, apierr.Internal("PROJECT_LOAD_FAILED", "Failed to load project")
	}
	if !ok || !project.ArchivedAt.IsZero() {
		return WorkerCapacity{}, apierr.NotFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	sessions, err := s.store.ListSessions(ctx, id)
	if err != nil {
		return WorkerCapacity{}, fmt.Errorf("list project sessions: %w", err)
	}

	snapshot := s.health.Snapshot()
	healthByID := make(map[string]agenthealth.HarnessHealth, len(snapshot.Harnesses))
	for _, h := range snapshot.Harnesses {
		healthByID[h.ID] = h
	}
	modelByBucket := s.modelHealthByBucket(id)
	candidateByBucket := s.candidateHealthByBucket()

	capacity := WorkerCapacity{
		ProjectID: id,
		CheckedAt: snapshot.CheckedAt,
	}
	intakeCfg := project.Config.TrackerIntake.WithDefaults()
	if intakeCfg.MaxConcurrent > 0 {
		workerCap := intakeCfg.MaxConcurrent
		capacity.Cap = &workerCap
	}

	mix := targetMix(project.Config)
	targets := make(map[domain.BucketKey]int, len(mix))
	for _, entry := range mix {
		targets[entry.BucketKey()] = entry.Weight
	}
	running := runningWorkerBuckets(sessions)
	for _, count := range running {
		capacity.ActiveWorkers += count
	}
	capConsumingWorkers := capConsumingWorkerCount(sessions)

	keys := capacityKeys(targets, running)
	for _, key := range keys {
		target := targets[key]
		active := running[key]
		bucket := WorkerCapacityBucket{
			Agent:           key.Harness,
			Model:           key.Model,
			TargetPercent:   target,
			ActiveWorkers:   active,
			RealizedPercent: percent(active, capacity.ActiveWorkers),
		}
		if capacity.Cap != nil {
			targetCapacity := float64(*capacity.Cap) * float64(target) / 100
			bucket.TargetCapacity = &targetCapacity
		}
		s.applyBucketHealth(&bucket, key, healthByID, modelByBucket, candidateByBucket)
		if bucket.Down && capacity.Cap != nil {
			share := float64(*capacity.Cap) * float64(target) / 100
			bucket.DownCapacityShare = &share
			capacity.DownBucketShare = addPtr(capacity.DownBucketShare, share)
		}
		capacity.Buckets = append(capacity.Buckets, bucket)
	}

	if capacity.DownBucketShare == nil && capacity.Cap != nil {
		zero := 0.0
		capacity.DownBucketShare = &zero
	}
	if capacity.Cap != nil {
		usable := float64(*capacity.Cap)
		if capacity.DownBucketShare != nil {
			usable -= *capacity.DownBucketShare
		}
		if usable < 0 {
			usable = 0
		}
		capacity.AvailableCapacity = &usable
		free := usable - float64(capConsumingWorkers)
		if free < 0 {
			free = 0
		}
		capacity.FreeAvailableCapacity = &free
	}
	capacity.Harnesses = capacityHarnesses(mix, healthByID)
	capacity.State = capacityState(capacity)
	return capacity, nil
}

func (s *WorkerCapacityService) modelHealthByBucket(projectID domain.ProjectID) map[domain.BucketKey]modelhealth.Verdict {
	out := map[domain.BucketKey]modelhealth.Verdict{}
	if s == nil || s.modelHealth == nil {
		return out
	}
	for _, verdict := range s.modelHealth.Snapshot() {
		if verdict.Pin.ProjectID != projectID || verdict.Status != agentsvc.ModelStatusUnreachable {
			continue
		}
		key := domain.BucketKey{Harness: verdict.Pin.Harness, Model: strings.TrimSpace(verdict.Pin.Model)}
		out[key] = verdict
	}
	return out
}

func (s *WorkerCapacityService) candidateHealthByBucket() map[domain.BucketKey]candidatehealth.Status {
	out := map[domain.BucketKey]candidatehealth.Status{}
	if s == nil || s.candidateHealth == nil {
		return out
	}
	for _, status := range s.candidateHealth.WorkerMixHealthSnapshot() {
		c := status.Candidate.Normalized()
		if !status.Down || c.Surface != "worker_mix" {
			continue
		}
		out[domain.BucketKey{Harness: domain.AgentHarness(c.Harness), Model: strings.TrimSpace(c.Model)}] = status
	}
	return out
}

func (s *WorkerCapacityService) applyBucketHealth(bucket *WorkerCapacityBucket, key domain.BucketKey, healthByID map[string]agenthealth.HarnessHealth, modelByBucket map[domain.BucketKey]modelhealth.Verdict, candidateByBucket map[domain.BucketKey]candidatehealth.Status) {
	if h, ok := healthByID[string(key.Harness)]; ok {
		bucket.Health = h.Health
		bucket.Reason = h.Reason
		bucket.Remedy = h.Remedy
	} else {
		bucket.Health = agenthealth.HealthUnknown
		bucket.Reason = "no health snapshot for this harness"
	}
	if bucket.Health.Actionable() {
		bucket.Down = true
		bucket.BlockedBy = "harness_auth"
		return
	}
	if verdict, ok := modelByBucket[key]; ok {
		bucket.Down = true
		bucket.BlockedBy = "model"
		bucket.Reason = strings.TrimSpace(verdict.Reason)
		if bucket.Reason == "" {
			bucket.Reason = "configured model is unreachable"
		}
		return
	}
	if status, ok := candidateByBucket[key]; ok {
		bucket.Down = true
		bucket.BlockedBy = "launch_failure"
		bucket.Reason = strings.TrimSpace(status.Reason)
		if bucket.Reason == "" {
			bucket.Reason = "last exact candidate launch failed"
		}
		return
	}
	bucket.Down = false
}

func targetMix(cfg domain.ProjectConfig) domain.WorkerMix {
	if len(cfg.WorkerMix) > 0 {
		return cfg.WorkerMix
	}
	if cfg.Worker.Harness != "" {
		return domain.WorkerMix{{Harness: cfg.Worker.Harness, Weight: 100}}
	}
	return nil
}

func runningWorkerBuckets(sessions []domain.SessionRecord) map[domain.BucketKey]int {
	out := map[domain.BucketKey]int{}
	for _, rec := range sessions {
		if rec.Kind != domain.KindWorker || rec.IsTerminated {
			continue
		}
		key := domain.BucketKey{Harness: rec.Harness, Model: strings.TrimSpace(rec.Metadata.Model)}
		out[key]++
	}
	return out
}

func capConsumingWorkerCount(sessions []domain.SessionRecord) int {
	count := 0
	for _, rec := range sessions {
		if rec.Kind != domain.KindWorker || rec.IsTerminated || rec.Metadata.IntakePoolBypass {
			continue
		}
		count++
	}
	return count
}

func capacityKeys(targets, running map[domain.BucketKey]int) []domain.BucketKey {
	seen := make(map[domain.BucketKey]struct{}, len(targets)+len(running))
	keys := make([]domain.BucketKey, 0, len(targets)+len(running))
	for key := range targets {
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	for key := range running {
		if _, ok := seen[key]; ok {
			continue
		}
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if targets[keys[i]] != targets[keys[j]] {
			return targets[keys[i]] > targets[keys[j]]
		}
		if keys[i].Harness != keys[j].Harness {
			return keys[i].Harness < keys[j].Harness
		}
		return keys[i].Model < keys[j].Model
	})
	return keys
}

func capacityHarnesses(mix domain.WorkerMix, healthByID map[string]agenthealth.HarnessHealth) []WorkerCapacityHarness {
	ids := map[string]struct{}{}
	for _, entry := range mix {
		if entry.Harness != "" {
			ids[string(entry.Harness)] = struct{}{}
		}
	}
	for id := range healthByID {
		ids[id] = struct{}{}
	}
	keys := make([]string, 0, len(ids))
	for id := range ids {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	out := make([]WorkerCapacityHarness, 0, len(keys))
	for _, id := range keys {
		h, ok := healthByID[id]
		if !ok {
			out = append(out, WorkerCapacityHarness{ID: id, Label: id, Health: agenthealth.HealthUnknown, Reason: "no health snapshot for this harness"})
			continue
		}
		out = append(out, WorkerCapacityHarness{
			ID:        h.ID,
			Label:     h.Label,
			Health:    h.Health,
			Reason:    h.Reason,
			Remedy:    h.Remedy,
			CheckedAt: h.CheckedAt,
			ChangedAt: h.ChangedAt,
		})
	}
	return out
}

func capacityState(c WorkerCapacity) string {
	if len(c.Buckets) == 0 {
		return "unconfigured"
	}
	for _, bucket := range c.Buckets {
		if bucket.Down {
			return "degraded"
		}
	}
	if c.Cap == nil {
		return "uncapped"
	}
	return "healthy"
}

func percent(part, total int) float64 {
	if total <= 0 {
		return 0
	}
	return math.Round((float64(part)/float64(total))*1000) / 10
}

func addPtr(current *float64, delta float64) *float64 {
	if current == nil {
		next := delta
		return &next
	}
	*current += delta
	return current
}
