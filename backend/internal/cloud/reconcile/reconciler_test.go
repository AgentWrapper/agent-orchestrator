package reconcile

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type fakeStore struct {
	claimed        []clouddomain.Sandbox
	state          string
	id             string
	events         []string
	deletedSession clouddomain.SessionID
}

func (f *fakeStore) ClaimSandboxes(context.Context, string, int, time.Duration) ([]clouddomain.Sandbox, error) {
	claimed := f.claimed
	f.claimed = nil
	return claimed, nil
}
func (f *fakeStore) IssueAccessTicket(
	context.Context,
	clouddomain.AccountID,
	clouddomain.SessionID,
	string,
	[]string,
	time.Duration,
) (string, error) {
	return "one-use-ticket", nil
}
func (f *fakeStore) UpdateSandboxObservation(
	_ context.Context,
	_ string,
	_ clouddomain.SessionID,
	providerID, state, _ string,
	_ time.Time,
) error {
	f.id = providerID
	f.state = state
	return nil
}
func (*fakeStore) ReleaseSandboxClaim(context.Context, string, clouddomain.SessionID, time.Time) error {
	return nil
}
func (f *fakeStore) AppendEvent(
	_ context.Context,
	_ clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	eventType string,
	payload json.RawMessage,
) (clouddomain.Event, error) {
	f.events = append(f.events, eventType)
	return clouddomain.Event{SessionID: sessionID, Type: eventType, Payload: payload}, nil
}
func (f *fakeStore) DeleteSession(_ context.Context, _ clouddomain.AccountID, sessionID clouddomain.SessionID) error {
	f.deletedSession = sessionID
	return nil
}

type fakeProvider struct {
	created cloudsandbox.Spec
	current cloudsandbox.Environment
	deleted cloudsandbox.ID
}

func (f *fakeProvider) Create(_ context.Context, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	f.created = spec
	return cloudsandbox.Environment{ID: "provider-one", State: "creating"}, nil
}
func (f *fakeProvider) Get(context.Context, cloudsandbox.ID) (cloudsandbox.Environment, error) {
	return f.current, nil
}
func (*fakeProvider) FindBySession(context.Context, clouddomain.SessionID) (cloudsandbox.Environment, bool, error) {
	return cloudsandbox.Environment{}, false, nil
}
func (*fakeProvider) Start(context.Context, cloudsandbox.ID) error  { return nil }
func (*fakeProvider) Stop(context.Context, cloudsandbox.ID) error   { return nil }
func (*fakeProvider) Pause(context.Context, cloudsandbox.ID) error  { return nil }
func (*fakeProvider) Resume(context.Context, cloudsandbox.ID) error { return nil }
func (f *fakeProvider) Delete(_ context.Context, id cloudsandbox.ID) error {
	f.deleted = id
	return nil
}

type fakeBootstrapProvider struct {
	fakeProvider
	bootstrap cloudsandbox.WorkerBootstrap
}

type fakeBakedWorkerProvider struct {
	fakeProvider
}

type fakeRecreatingProvider struct {
	fakeProvider
	recreatedID   cloudsandbox.ID
	recreatedSpec cloudsandbox.Spec
}

func (f *fakeRecreatingProvider) Recreate(
	_ context.Context,
	id cloudsandbox.ID,
	spec cloudsandbox.Spec,
) (cloudsandbox.Environment, error) {
	f.recreatedID = id
	f.recreatedSpec = spec
	return cloudsandbox.Environment{ID: "provider-two", State: "running"}, nil
}

func (*fakeBakedWorkerProvider) Get(
	context.Context,
	cloudsandbox.ID,
) (cloudsandbox.Environment, error) {
	return cloudsandbox.Environment{ID: "provider-one", State: "started"}, nil
}

func (*fakeBootstrapProvider) Get(
	context.Context,
	cloudsandbox.ID,
) (cloudsandbox.Environment, error) {
	return cloudsandbox.Environment{ID: "provider-one", State: "started"}, nil
}

func (f *fakeBootstrapProvider) BootstrapWorker(
	_ context.Context,
	_ cloudsandbox.ID,
	spec cloudsandbox.WorkerBootstrap,
) error {
	f.bootstrap = spec
	return nil
}

type fakeResolver struct {
	provider cloudsandbox.Provider
}

func (f fakeResolver) Resolve(context.Context, clouddomain.Sandbox) (cloudsandbox.Provider, error) {
	return f.provider, nil
}

func TestProvisionIssuesScopedBootstrapAndLabelsSandbox(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:       "session-one",
		AccountID:       "account-one",
		Provider:        "daytona",
		DesiredState:    "running",
		ObservedState:   "requested",
		ResourceProfile: clouddomain.DefaultResourceProfile(),
	}}}
	provider := &fakeProvider{}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"daytona-large",
		"",
		time.Second,
		nil,
		nil,
	)
	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if store.state != "provisioning" || store.id != "provider-one" {
		t.Fatalf("observation = %q %q", store.state, store.id)
	}
	if provider.created.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "one-use-ticket" {
		t.Fatalf("worker environment = %#v", provider.created.Environment)
	}
	if provider.created.Environment["AO_WORKSPACE_DIR"] != "/workspace/repository" {
		t.Fatalf("workspace environment = %#v", provider.created.Environment)
	}
	if provider.created.Environment["HOME"] != "/workspace/.ao/home" ||
		provider.created.Environment["AO_DATA_DIR"] != "/workspace/.ao/worker" ||
		provider.created.Environment["CLAUDE_CONFIG_DIR"] != "/workspace/.ao/home/.claude" ||
		provider.created.Environment["CODEX_HOME"] != "/workspace/.ao/home/.codex" {
		t.Fatalf("persistent agent environment = %#v", provider.created.Environment)
	}
	if provider.created.Labels["ao.session_id"] != "session-one" {
		t.Fatalf("labels = %#v", provider.created.Labels)
	}
	if len(store.events) != 1 || store.events[0] != "sandbox.provisioning" {
		t.Fatalf("events = %#v", store.events)
	}
}

func TestStaleBootstrapWithoutHeartbeatRetriesWorker(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "daytona",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "running",
		ObservedState:         "bootstrapping",
		CreatedAt:             time.Now().Add(-time.Minute),
	}}}
	provider := &fakeBootstrapProvider{}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"ao-worker-v1",
		"",
		time.Second,
		[]byte("worker"),
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if string(provider.bootstrap.Binary) != "worker" {
		t.Fatalf("bootstrap = %#v", provider.bootstrap)
	}
	if provider.bootstrap.Environment["AO_WORKSPACE_DIR"] != "/workspace/repository" {
		t.Fatalf("bootstrap environment = %#v", provider.bootstrap.Environment)
	}
	if provider.bootstrap.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "one-use-ticket" {
		t.Fatalf("bootstrap environment = %#v", provider.bootstrap.Environment)
	}
	if store.state != "bootstrapping" || store.id != "provider-one" {
		t.Fatalf("observation = %q %q", store.state, store.id)
	}
}

func TestFreshBootstrapWaitsForWorkerReadiness(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "daytona",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "running",
		ObservedState:         "bootstrapping",
		UpdatedAt:             time.Now(),
	}}}
	provider := &fakeBootstrapProvider{}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"ao-worker-v1",
		"",
		time.Second,
		[]byte("worker"),
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if len(provider.bootstrap.Binary) != 0 {
		t.Fatalf("fresh worker was repaired prematurely: %#v", provider.bootstrap)
	}
}

func TestBakedWorkerProviderDoesNotRequireBootstrapCapability(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "daytona",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "running",
		ObservedState:         "provisioning",
		CreatedAt:             time.Now(),
	}}}
	provider := &fakeBakedWorkerProvider{}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"",
		"",
		time.Second,
		[]byte("unused-for-baked-provider"),
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if store.state != "bootstrapping" || store.id != "provider-one" {
		t.Fatalf("observation = %q %q", store.state, store.id)
	}
}

func TestDestroyedProviderEnvironmentIsClearedForReprovisioning(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "docker",
		ProviderEnvironmentID: "destroyed-machine",
		DesiredState:          "running",
		ObservedState:         "provisioning",
	}}}
	provider := &fakeProvider{current: cloudsandbox.Environment{
		ID:    "destroyed-machine",
		State: "deleted",
	}}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"stable",
		"",
		time.Second,
		nil,
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if store.state != "requested" || store.id != "" {
		t.Fatalf("observation = %q %q, want requested with cleared provider ID", store.state, store.id)
	}
}

func TestDeletedSandboxRemovesProviderEnvironmentAndSession(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "docker",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "deleted",
		ObservedState:         "running",
	}}}
	provider := &fakeProvider{}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"stable",
		"",
		time.Second,
		nil,
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if store.deletedSession != "session-one" {
		t.Fatalf("deleted session = %q, want session-one", store.deletedSession)
	}
	if provider.deleted != "provider-one" {
		t.Fatalf("deleted provider ID = %q, want provider-one", provider.deleted)
	}
	if store.state != "" {
		t.Fatalf("deleted session should not leave sandbox observation state %q", store.state)
	}
}

func TestRegressionStoppedWorkerVMIsRecreatedWithFreshBootstrapCredentials(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "docker",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "running",
		ObservedState:         "paused",
	}}}
	provider := &fakeRecreatingProvider{fakeProvider: fakeProvider{
		current: cloudsandbox.Environment{ID: "provider-one", State: "stopped"},
	}}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"",
		"ao-cloud-worker:local",
		time.Second,
		nil,
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if provider.recreatedID != "provider-one" {
		t.Fatalf("recreated ID = %q, want provider-one", provider.recreatedID)
	}
	if provider.recreatedSpec.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "one-use-ticket" {
		t.Fatalf("worker environment = %#v", provider.recreatedSpec.Environment)
	}
	if store.state != "bootstrapping" || store.id != "provider-two" {
		t.Fatalf("observation = %q %q, want bootstrapping provider-two", store.state, store.id)
	}
}

func TestRegressionPausedWorkerIsRecreatedWithFreshBootstrapCredentials(t *testing.T) {
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "docker",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "running",
		ObservedState:         "paused",
	}}}
	provider := &fakeRecreatingProvider{fakeProvider: fakeProvider{
		current: cloudsandbox.Environment{ID: "provider-one", State: "paused"},
	}}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"",
		"",
		time.Second,
		nil,
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if provider.recreatedSpec.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "one-use-ticket" {
		t.Fatalf("worker environment = %#v", provider.recreatedSpec.Environment)
	}
}

func TestRegressionStaleWorkerHeartbeatRecreatesRuntime(t *testing.T) {
	lastSeen := time.Now().Add(-2 * time.Minute)
	store := &fakeStore{claimed: []clouddomain.Sandbox{{
		SessionID:             "session-one",
		AccountID:             "account-one",
		Provider:              "docker",
		ProviderEnvironmentID: "provider-one",
		DesiredState:          "running",
		ObservedState:         "running",
		WorkerLastSeenAt:      &lastSeen,
	}}}
	provider := &fakeRecreatingProvider{fakeProvider: fakeProvider{
		current: cloudsandbox.Environment{ID: "provider-one", State: "running"},
	}}
	reconciler := New(
		store,
		fakeResolver{provider: provider},
		"https://cloud.example",
		"",
		"ao-cloud-worker:local",
		time.Second,
		nil,
		nil,
	)

	if err := reconciler.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce() error = %v", err)
	}
	if provider.recreatedID != "provider-one" ||
		provider.recreatedSpec.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] != "one-use-ticket" {
		t.Fatalf("recreated worker = %q %#v", provider.recreatedID, provider.recreatedSpec)
	}
}
