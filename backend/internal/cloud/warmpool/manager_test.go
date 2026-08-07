package warmpool

import (
	"context"
	"errors"
	"fmt"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type fakeStore struct {
	tasks             []cloudpostgres.ECSWarmTask
	claimBeforeRetire bool
}

type fakeLease struct{}

func (fakeLease) Valid(context.Context) bool { return true }
func (fakeLease) Release(context.Context)    {}

func (*fakeStore) TryAcquireECSWarmPoolLease(
	context.Context,
) (cloudpostgres.ECSWarmPoolLeaseHandle, bool, error) {
	return fakeLease{}, true, nil
}

func (f *fakeStore) ReserveECSWarmTask(
	_ context.Context,
	generation string,
	target int,
) (cloudpostgres.ECSWarmTask, string, bool, error) {
	available := 0
	for _, task := range f.tasks {
		if task.Generation == generation && (task.State == "launching" || task.State == "ready") {
			available++
		}
	}
	if available >= target {
		return cloudpostgres.ECSWarmTask{}, "", false, nil
	}
	task := cloudpostgres.ECSWarmTask{
		ID:         fmt.Sprintf("task-%d", len(f.tasks)+1),
		Generation: generation,
		State:      "launching",
	}
	f.tasks = append(f.tasks, task)
	return task, "secret-" + task.ID, true, nil
}

func (f *fakeStore) ListECSWarmTasks(
	context.Context,
	string,
) ([]cloudpostgres.ECSWarmTask, error) {
	return append([]cloudpostgres.ECSWarmTask(nil), f.tasks...), nil
}

func (f *fakeStore) ActivateECSWarmTask(_ context.Context, id, arn string) error {
	task := f.task(id)
	task.TaskARN = arn
	return nil
}

func (f *fakeStore) MarkECSWarmTaskReady(_ context.Context, id string) error {
	f.task(id).State = "ready"
	return nil
}

func (f *fakeStore) FailECSWarmTask(_ context.Context, id string, _ error) error {
	f.task(id).State = "failed"
	return nil
}

func (f *fakeStore) RetireECSWarmTask(
	_ context.Context,
	id string,
) (string, bool, error) {
	task := f.task(id)
	if f.claimBeforeRetire {
		task.State = "claimed"
		f.claimBeforeRetire = false
	}
	if task.State != "launching" && task.State != "ready" {
		return "", false, nil
	}
	task.State = "failed"
	return task.TaskARN, true, nil
}

func (f *fakeStore) CompleteECSWarmTaskStop(_ context.Context, id string) error {
	f.task(id).State = "stopped"
	return nil
}

func (f *fakeStore) task(id string) *cloudpostgres.ECSWarmTask {
	for index := range f.tasks {
		if f.tasks[index].ID == id {
			return &f.tasks[index]
		}
	}
	panic("unknown task " + id)
}

type fakeProvider struct {
	created   int
	deleted   []cloudsandbox.ID
	fail      error
	getErr    error
	deleteErr error
}

func (f *fakeProvider) CreateWarmTask(
	_ context.Context,
	id, _, _, _ string,
	_ clouddomain.ResourceProfile,
) (cloudsandbox.Environment, error) {
	f.created++
	if f.fail != nil {
		return cloudsandbox.Environment{}, f.fail
	}
	return cloudsandbox.Environment{
		ID:    cloudsandbox.ID("arn:" + id),
		State: "creating",
	}, nil
}

func (*fakeProvider) FindWarmTask(
	context.Context,
	string,
) (cloudsandbox.Environment, bool, error) {
	return cloudsandbox.Environment{}, false, nil
}

func (f *fakeProvider) Get(
	_ context.Context,
	id cloudsandbox.ID,
) (cloudsandbox.Environment, error) {
	if f.getErr != nil {
		return cloudsandbox.Environment{}, f.getErr
	}
	return cloudsandbox.Environment{ID: id, State: "running"}, nil
}

func (f *fakeProvider) Delete(_ context.Context, id cloudsandbox.ID) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, id)
	return nil
}

func TestManagerMaintainsReadyTargetAndReplenishesClaims(t *testing.T) {
	ctx := context.Background()
	store := &fakeStore{}
	provider := &fakeProvider{}
	manager := New(store, provider, "https://cloud.example", "release-one", 4, nil)

	for range 5 {
		if err := manager.reconcile(ctx); err != nil {
			t.Fatalf("reconcile launch: %v", err)
		}
	}
	if provider.created != 4 || len(store.tasks) != 4 {
		t.Fatalf("created = %d, tasks = %d", provider.created, len(store.tasks))
	}
	for _, task := range store.tasks {
		if task.State != "ready" {
			t.Fatalf("task %s state = %q", task.ID, task.State)
		}
	}
	store.tasks[0].State = "claimed"
	if err := manager.reconcile(ctx); err != nil {
		t.Fatalf("reconcile replacement: %v", err)
	}
	if provider.created != 5 {
		t.Fatalf("created after claim = %d, want 5", provider.created)
	}
}

func TestManagerBacksOffAfterQuotaFailure(t *testing.T) {
	store := &fakeStore{}
	provider := &fakeProvider{fail: errors.New("vCPU quota exceeded")}
	manager := New(store, provider, "https://cloud.example", "release-one", 4, nil)

	if err := manager.reconcile(context.Background()); err == nil {
		t.Fatal("reconcile error = nil, want quota failure")
	}
	if err := manager.reconcile(context.Background()); err != nil {
		t.Fatalf("backoff reconcile = %v", err)
	}
	if provider.created != 1 {
		t.Fatalf("created during backoff = %d, want 1", provider.created)
	}
}

func TestDisabledManagerDrainsOnlyUnassignedTasks(t *testing.T) {
	store := &fakeStore{tasks: []cloudpostgres.ECSWarmTask{
		{ID: "ready", State: "ready", TaskARN: "arn:ready"},
		{ID: "claimed", State: "claimed", TaskARN: "arn:claimed"},
	}}
	provider := &fakeProvider{}
	manager := New(store, provider, "https://cloud.example", "release-one", 0, nil)

	if err := manager.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.tasks[0].State != "stopped" || store.tasks[1].State != "claimed" {
		t.Fatalf("states = %q, %q", store.tasks[0].State, store.tasks[1].State)
	}
	if len(provider.deleted) != 1 || provider.deleted[0] != "arn:ready" {
		t.Fatalf("deleted = %#v", provider.deleted)
	}
}

func TestManagerDrainsOldGeneration(t *testing.T) {
	store := &fakeStore{tasks: []cloudpostgres.ECSWarmTask{{
		ID:         "old-ready",
		Generation: "release-old",
		State:      "ready",
		TaskARN:    "arn:old-ready",
	}}}
	provider := &fakeProvider{}
	manager := New(store, provider, "https://cloud.example", "release-new", 1, nil)

	if err := manager.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.tasks[0].State != "stopped" || len(provider.deleted) != 1 {
		t.Fatalf("old task = %#v, deleted = %#v", store.tasks[0], provider.deleted)
	}
	if provider.created != 1 {
		t.Fatalf("new generation launches = %d, want 1", provider.created)
	}
}

func TestDrainDoesNotStopTaskClaimedFromStaleSnapshot(t *testing.T) {
	store := &fakeStore{
		tasks: []cloudpostgres.ECSWarmTask{{
			ID:         "ready",
			Generation: "release-one",
			State:      "ready",
			TaskARN:    "arn:ready",
		}},
		claimBeforeRetire: true,
	}
	provider := &fakeProvider{}
	manager := New(store, provider, "https://cloud.example", "release-one", 0, nil)

	if err := manager.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.tasks[0].State != "claimed" || len(provider.deleted) != 0 {
		t.Fatalf("task = %#v, deleted = %#v", store.tasks[0], provider.deleted)
	}
}

func TestTransientDescribeErrorKeepsReadyTaskManaged(t *testing.T) {
	store := &fakeStore{tasks: []cloudpostgres.ECSWarmTask{{
		ID:         "ready",
		Generation: "release-one",
		State:      "ready",
		TaskARN:    "arn:ready",
	}}}
	provider := &fakeProvider{getErr: errors.New("temporary ECS timeout")}
	manager := New(store, provider, "https://cloud.example", "release-one", 1, nil)

	if err := manager.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.tasks[0].State != "ready" {
		t.Fatalf("task state = %q, want ready", store.tasks[0].State)
	}
}

func TestFailedDeleteRemainsManagedAndRetries(t *testing.T) {
	store := &fakeStore{tasks: []cloudpostgres.ECSWarmTask{{
		ID:         "ready",
		Generation: "release-one",
		State:      "ready",
		TaskARN:    "arn:ready",
	}}}
	provider := &fakeProvider{deleteErr: errors.New("temporary stop failure")}
	manager := New(store, provider, "https://cloud.example", "release-one", 0, nil)

	if err := manager.reconcile(context.Background()); err == nil {
		t.Fatal("reconcile error = nil, want stop failure")
	}
	if store.tasks[0].State != "failed" {
		t.Fatalf("task state = %q, want retryable failed", store.tasks[0].State)
	}
	provider.deleteErr = nil
	if err := manager.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.tasks[0].State != "stopped" {
		t.Fatalf("task state after retry = %q, want stopped", store.tasks[0].State)
	}
}
