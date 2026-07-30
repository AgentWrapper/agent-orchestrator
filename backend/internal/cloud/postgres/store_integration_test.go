package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func integrationStore(t *testing.T) *Store {
	t.Helper()
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func TestCreateSessionIsIdempotentAndEventsAreOrdered(t *testing.T) {
	store := integrationStore(t)
	ctx := context.Background()
	userID := uuid.NewString()
	account, err := store.EnsureAccount(ctx, userID, "Cloud Tester")
	if err != nil {
		t.Fatalf("EnsureAccount() error = %v", err)
	}
	project, err := store.CreateProject(ctx, account.ID, CreateProjectInput{
		DisplayName:   "AO",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
		Config:        json.RawMessage(`{"worker":{"agent":"fake"}}`),
	})
	if err != nil {
		t.Fatalf("CreateProject() error = %v", err)
	}
	input := CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      project.ID,
		Kind:           "worker",
		Harness:        "fake",
		DisplayName:    "cloud-check",
		Prompt:         "Verify cloud",
		Resource:       clouddomain.DefaultResourceProfile(),
	}
	first, err := store.CreateSession(ctx, account.ID, input)
	if err != nil {
		t.Fatalf("CreateSession(first) error = %v", err)
	}
	if !first.Created {
		t.Fatal("CreateSession(first).Created = false")
	}
	second, err := store.CreateSession(ctx, account.ID, input)
	if err != nil {
		t.Fatalf("CreateSession(second) error = %v", err)
	}
	if second.Created {
		t.Fatal("CreateSession(second).Created = true")
	}
	if second.Session.ID != first.Session.ID {
		t.Fatalf("idempotent session ID = %q, want %q", second.Session.ID, first.Session.ID)
	}

	if _, err := store.AppendEvent(
		ctx,
		account.ID,
		first.Session.ID,
		"agent.started",
		json.RawMessage(`{"launchId":"one"}`),
	); err != nil {
		t.Fatalf("AppendEvent() error = %v", err)
	}
	events, err := store.EventsAfter(ctx, account.ID, first.Session.ID, 0, 10)
	if err != nil {
		t.Fatalf("EventsAfter() error = %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("len(events) = %d, want 3", len(events))
	}
	if events[0].Sequence != 1 || events[1].Sequence != 2 || events[2].Sequence != 3 {
		t.Fatalf(
			"event sequences = %d,%d,%d, want 1,2,3",
			events[0].Sequence,
			events[1].Sequence,
			events[2].Sequence,
		)
	}

	messageKey := uuid.NewString()
	message, messageCreated, err := store.AppendUserMessage(
		ctx,
		account.ID,
		first.Session.ID,
		messageKey,
		"continue the task",
	)
	if err != nil {
		t.Fatalf("AppendUserMessage(first) error = %v", err)
	}
	if !messageCreated || message.Type != "chat.user_message" {
		t.Fatalf("AppendUserMessage(first) = %#v created=%v", message, messageCreated)
	}
	retriedMessage, messageCreated, err := store.AppendUserMessage(
		ctx,
		account.ID,
		first.Session.ID,
		messageKey,
		"continue the task",
	)
	if err != nil {
		t.Fatalf("AppendUserMessage(retry) error = %v", err)
	}
	if messageCreated || retriedMessage.Sequence != message.Sequence {
		t.Fatalf("AppendUserMessage(retry) = %#v created=%v", retriedMessage, messageCreated)
	}
	if _, _, err := store.AppendUserMessage(
		ctx,
		account.ID,
		first.Session.ID,
		messageKey,
		"different task",
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("AppendUserMessage(conflict) error = %v, want ErrIdempotencyConflict", err)
	}
	chatEvents, err := store.ChatEventsAfter(ctx, account.ID, first.Session.ID, 0, 500)
	if err != nil {
		t.Fatalf("ChatEventsAfter() error = %v", err)
	}
	if len(chatEvents) != 2 ||
		chatEvents[0].Type != "chat.user_message" ||
		chatEvents[1].Sequence != message.Sequence {
		t.Fatalf("ChatEventsAfter() = %#v", chatEvents)
	}
	acknowledgement, err := json.Marshal(map[string]int64{"sequence": message.Sequence})
	if err != nil {
		t.Fatalf("Marshal(acknowledgement) error = %v", err)
	}
	if _, err := store.AppendEvent(
		ctx,
		account.ID,
		first.Session.ID,
		"worker.prompt_accepted",
		acknowledgement,
	); err != nil {
		t.Fatalf("AppendEvent(prompt accepted) error = %v", err)
	}
	accepted, err := store.LatestPromptAcceptedSequence(ctx, account.ID, first.Session.ID)
	if err != nil {
		t.Fatalf("LatestPromptAcceptedSequence() error = %v", err)
	}
	if accepted != message.Sequence {
		t.Fatalf("LatestPromptAcceptedSequence() = %d, want %d", accepted, message.Sequence)
	}
	if err := store.SetAgentSessionID(
		ctx,
		account.ID,
		first.Session.ID,
		"provider-session-one",
	); err != nil {
		t.Fatalf("SetAgentSessionID() error = %v", err)
	}
	resumable, err := store.GetSession(ctx, account.ID, first.Session.ID)
	if err != nil {
		t.Fatalf("GetSession(resumable) error = %v", err)
	}
	if resumable.AgentSessionID != "provider-session-one" {
		t.Fatalf("AgentSessionID = %q", resumable.AgentSessionID)
	}

	ticket, err := store.IssueAccessTicket(
		ctx,
		account.ID,
		first.Session.ID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	)
	if err != nil {
		t.Fatalf("IssueAccessTicket() error = %v", err)
	}
	consumed, err := store.ConsumeAccessTicket(ctx, ticket, "worker_bootstrap")
	if err != nil {
		t.Fatalf("ConsumeAccessTicket() error = %v", err)
	}
	if consumed.SessionID != first.Session.ID {
		t.Fatalf("ticket session = %q, want %q", consumed.SessionID, first.Session.ID)
	}
	if _, err := store.ConsumeAccessTicket(ctx, ticket, "worker_bootstrap"); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("second ConsumeAccessTicket() error = %v, want ErrInvalidTicket", err)
	}
}
