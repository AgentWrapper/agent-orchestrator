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
	claimed []clouddomain.Sandbox
	state   string
	id      string
	events  []string
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

type fakeProvider struct {
	created cloudsandbox.Spec
}

func (f *fakeProvider) Create(_ context.Context, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	f.created = spec
	return cloudsandbox.Environment{ID: "provider-one", State: "creating"}, nil
}
func (*fakeProvider) Get(context.Context, cloudsandbox.ID) (cloudsandbox.Environment, error) {
	return cloudsandbox.Environment{}, nil
}
func (*fakeProvider) FindBySession(context.Context, clouddomain.SessionID) (cloudsandbox.Environment, bool, error) {
	return cloudsandbox.Environment{}, false, nil
}
func (*fakeProvider) Start(context.Context, cloudsandbox.ID) error  { return nil }
func (*fakeProvider) Stop(context.Context, cloudsandbox.ID) error   { return nil }
func (*fakeProvider) Pause(context.Context, cloudsandbox.ID) error  { return nil }
func (*fakeProvider) Resume(context.Context, cloudsandbox.ID) error { return nil }
func (*fakeProvider) Delete(context.Context, cloudsandbox.ID) error { return nil }

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
	if provider.created.Labels["ao.session_id"] != "session-one" {
		t.Fatalf("labels = %#v", provider.created.Labels)
	}
	if len(store.events) != 1 || store.events[0] != "sandbox.provisioning" {
		t.Fatalf("events = %#v", store.events)
	}
}
