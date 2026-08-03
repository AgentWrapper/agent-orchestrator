package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func integrationStore(t *testing.T) *Store {
	t.Helper()
	t.Skip("cloud Postgres integration tests are disabled until hosted DB test infrastructure is restored")
	return nil
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
	changedInput := input
	changedInput.Prompt = "A different request"
	if _, err := store.CreateSession(
		ctx,
		account.ID,
		changedInput,
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf(
			"CreateSession(changed payload) error = %v, want ErrIdempotencyConflict",
			err,
		)
	}
	initialTurn, err := store.GetActiveTurn(ctx, account.ID, first.Session.ID)
	if err != nil || initialTurn == nil || initialTurn.State != "provisioning" {
		t.Fatalf("initial turn = %#v, error = %v", initialTurn, err)
	}
	if _, err := store.TransitionActiveTurn(
		ctx,
		account.ID,
		first.Session.ID,
		"completed",
		"",
	); err != nil {
		t.Fatal(err)
	}
	beforeHeartbeat, err := store.GetSession(ctx, account.ID, first.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if beforeHeartbeat.RuntimeConnected {
		t.Fatal("new session reported a connected runtime")
	}
	if err := store.RegisterWorkerBootstrap(
		ctx,
		account.ID,
		first.Session.ID,
		"worker-one",
		"test",
		1,
		[]string{"chat.stream-json.v1"},
	); err != nil {
		t.Fatal(err)
	}
	afterBootstrap, err := store.GetSession(ctx, account.ID, first.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterBootstrap.RuntimeConnected {
		t.Fatal("bootstrap exchange reported a ready runtime before heartbeat")
	}
	current, err := store.WorkerConnectionCurrent(
		ctx,
		account.ID,
		first.Session.ID,
		"worker-one",
		1,
	)
	if err != nil || !current {
		t.Fatalf("bootstrap worker current = %t, error = %v", current, err)
	}
	if err := store.MarkWorkerSeen(
		ctx,
		account.ID,
		first.Session.ID,
		"worker-one",
		"test",
		1,
		[]string{"chat.stream-json.v1"},
	); err != nil {
		t.Fatal(err)
	}
	afterHeartbeat, err := store.GetSession(ctx, account.ID, first.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !afterHeartbeat.RuntimeConnected ||
		len(afterHeartbeat.Capabilities) != 1 ||
		afterHeartbeat.Capabilities[0] != "chat.stream-json.v1" {
		t.Fatalf("heartbeat session = %#v", afterHeartbeat)
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
	activeTurn, err := store.GetActiveTurn(ctx, account.ID, first.Session.ID)
	if err != nil || activeTurn == nil || activeTurn.State != "queued" ||
		activeTurn.UserMessageSequence != message.Sequence {
		t.Fatalf("queued turn = %#v, error = %v", activeTurn, err)
	}
	if _, _, err := store.AppendUserMessage(
		ctx,
		account.ID,
		first.Session.ID,
		uuid.NewString(),
		"overlapping task",
	); !errors.Is(err, ErrActiveTurn) {
		t.Fatalf("AppendUserMessage(active turn) error = %v, want ErrActiveTurn", err)
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
	crossKindInput := input
	crossKindInput.IdempotencyKey = messageKey
	if _, err := store.CreateSession(
		ctx,
		account.ID,
		crossKindInput,
	); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf(
			"CreateSession(cross-kind key) error = %v, want ErrIdempotencyConflict",
			err,
		)
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
	activePrompts, err := store.ActivePromptEventsAfter(ctx, account.ID, first.Session.ID, 0, 500)
	if err != nil || len(activePrompts) != 1 || activePrompts[0].Sequence != message.Sequence {
		t.Fatalf("ActivePromptEventsAfter() = %#v, error = %v", activePrompts, err)
	}
	if _, err := store.TransitionActiveTurn(
		ctx,
		account.ID,
		first.Session.ID,
		"running",
		"",
	); err != nil {
		t.Fatal(err)
	}
	if err := store.ClaimActiveTurn(
		ctx,
		account.ID,
		first.Session.ID,
		message.Sequence,
		10,
	); err != nil {
		t.Fatal(err)
	}
	if sequence, err := store.PrepareActiveTurnForWorker(
		ctx,
		account.ID,
		first.Session.ID,
		10,
	); err != nil || sequence != 0 {
		t.Fatalf("same-worker retry sequence = %d, error = %v", sequence, err)
	}
	retrySequence, err := store.PrepareActiveTurnForWorker(
		ctx,
		account.ID,
		first.Session.ID,
		11,
	)
	if err != nil || retrySequence != message.Sequence {
		t.Fatalf("replacement retry sequence = %d, error = %v", retrySequence, err)
	}
	replacementTurn, err := store.GetActiveTurn(ctx, account.ID, first.Session.ID)
	if err != nil || replacementTurn == nil ||
		replacementTurn.State != "provisioning" ||
		replacementTurn.WorkerEpoch != 0 ||
		replacementTurn.AttemptCount != 1 {
		t.Fatalf("replacement turn = %#v, error = %v", replacementTurn, err)
	}
	if _, err := store.TransitionActiveTurn(
		ctx,
		account.ID,
		first.Session.ID,
		"completed",
		"",
	); err != nil {
		t.Fatal(err)
	}
	activePrompts, err = store.ActivePromptEventsAfter(ctx, account.ID, first.Session.ID, 0, 500)
	if err != nil || len(activePrompts) != 0 {
		t.Fatalf("terminal ActivePromptEventsAfter() = %#v, error = %v", activePrompts, err)
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
	retryableTicket, err := store.IssueAccessTicket(
		ctx,
		account.ID,
		first.Session.ID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	firstRedemption, err := store.RedeemWorkerBootstrapTicket(ctx, retryableTicket)
	if err != nil {
		t.Fatalf("RedeemWorkerBootstrapTicket() error = %v", err)
	}
	if _, err := store.RedeemWorkerBootstrapTicket(ctx, retryableTicket); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("retry RedeemWorkerBootstrapTicket() error = %v, want ErrInvalidTicket", err)
	}
	if firstRedemption.WorkerEpoch <= consumed.WorkerEpoch {
		t.Fatalf(
			"replacement bootstrap epoch = %d, want newer than %d",
			firstRedemption.WorkerEpoch,
			consumed.WorkerEpoch,
		)
	}
}

func TestProjectAndOrchestratorConflictsAreTyped(t *testing.T) {
	store := integrationStore(t)
	ctx := context.Background()
	account, err := store.EnsureAccount(ctx, uuid.NewString(), "Conflict Tester")
	if err != nil {
		t.Fatal(err)
	}
	repositoryURL := "https://github.com/example/" + uuid.NewString()
	project, err := store.CreateProject(ctx, account.ID, CreateProjectInput{
		DisplayName:   "Conflict Test",
		RepositoryURL: repositoryURL,
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateProject(ctx, account.ID, CreateProjectInput{
		DisplayName:   "Duplicate",
		RepositoryURL: repositoryURL,
		DefaultBranch: "main",
	}); !errors.Is(err, ErrProjectExists) {
		t.Fatalf("CreateProject(duplicate) error = %v, want ErrProjectExists", err)
	}
	input := CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      project.ID,
		Kind:           "orchestrator",
		Harness:        "fake",
		DisplayName:    "Orchestrator",
		Resource:       clouddomain.DefaultResourceProfile(),
	}
	if _, err := store.CreateSession(ctx, account.ID, input); err != nil {
		t.Fatal(err)
	}
	input.IdempotencyKey = uuid.NewString()
	if _, err := store.CreateSession(ctx, account.ID, input); !errors.Is(err, ErrActiveOrchestrator) {
		t.Fatalf("CreateSession(duplicate orchestrator) error = %v, want ErrActiveOrchestrator", err)
	}
}

func TestDeletedSandboxCanBeRequestedAgain(t *testing.T) {
	store := integrationStore(t)
	ctx := context.Background()
	account, err := store.EnsureAccount(ctx, uuid.NewString(), "Lifecycle Tester")
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject(ctx, account.ID, CreateProjectInput{
		DisplayName:   "Lifecycle",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
		Config:        json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.CreateSession(ctx, account.ID, CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      project.ID,
		Kind:           "worker",
		Harness:        "fake",
		DisplayName:    "recreated-worker",
		Resource:       clouddomain.DefaultResourceProfile(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetAgentSessionID(
		ctx,
		account.ID,
		created.Session.ID,
		"provider-session-on-deleted-volume",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.pool.Exec(ctx, `
		UPDATE ao_sandboxes
		SET desired_state = 'running',
			observed_state = 'deleted',
			provider_environment_id = 'deleted-environment',
			reconcile_after = now(),
			reconcile_lease_owner = '',
			reconcile_lease_until = NULL
		WHERE session_id = $1
	`, created.Session.ID); err != nil {
		t.Fatal(err)
	}

	const owner = "lifecycle-test"
	claimed, err := store.ClaimSandboxes(ctx, owner, 100, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, sandbox := range claimed {
		if sandbox.SessionID == created.Session.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("running sandbox with deleted observation was not reclaimed")
	}
	if err := store.UpdateSandboxObservation(
		ctx,
		owner,
		created.Session.ID,
		"",
		"requested",
		"provider environment disappeared",
		time.Now(),
	); err != nil {
		t.Fatal(err)
	}
	sandbox, err := store.GetSandbox(ctx, account.ID, created.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sandbox.ProviderEnvironmentID != "" || sandbox.ObservedState != "requested" {
		t.Fatalf("reset sandbox = %#v", sandbox)
	}
	session, err := store.GetSession(ctx, account.ID, created.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.AgentSessionID != "" {
		t.Fatalf("AgentSessionID = %q after sandbox loss", session.AgentSessionID)
	}
}

func TestIssueLinkAndPullRequestClaimAreDurableAndExclusive(t *testing.T) {
	store := integrationStore(t)
	ctx := context.Background()
	account, err := store.EnsureAccount(ctx, uuid.NewString(), "Orchestration Tester")
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject(ctx, account.ID, CreateProjectInput{
		DisplayName:   "Orchestration",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	createWorker := func(name string) clouddomain.Session {
		t.Helper()
		result, createErr := store.CreateSession(ctx, account.ID, CreateSessionInput{
			IdempotencyKey: uuid.NewString(),
			ProjectID:      project.ID,
			Kind:           "worker",
			Harness:        "fake",
			DisplayName:    name,
			Resource:       clouddomain.DefaultResourceProfile(),
		})
		if createErr != nil {
			t.Fatal(createErr)
		}
		return result.Session
	}
	first := createWorker("first")
	issue, err := store.UpsertIssueSnapshot(ctx, account.ID, clouddomain.Issue{
		ProjectID:  project.ID,
		Provider:   "github",
		Repository: "example/repository",
		Number:     7,
		URL:        "https://github.com/example/repository/issues/7",
		Title:      "Cloud parity",
		State:      "open",
		ObservedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.LinkSessionIssue(ctx, account.ID, first.ID, issue.ID); err != nil {
		t.Fatal(err)
	}
	var linkedIssueID string
	if err := store.pool.QueryRow(ctx, `SELECT issue_id FROM ao_session_issue_links WHERE session_id = $1`, first.ID).Scan(&linkedIssueID); err != nil || linkedIssueID != issue.ID {
		t.Fatalf("linked issue ID = %q, error = %v", linkedIssueID, err)
	}
	claim := clouddomain.PRClaim{
		SessionID:  first.ID,
		Provider:   "github",
		Repository: "example/repository",
		Number:     8,
		URL:        "https://github.com/example/repository/pull/8",
	}
	firstClaim, err := store.ClaimPullRequest(ctx, account.ID, claim)
	if err != nil {
		t.Fatal(err)
	}
	retriedClaim, err := store.ClaimPullRequest(ctx, account.ID, claim)
	if err != nil || retriedClaim.ID != firstClaim.ID {
		t.Fatalf("idempotent claim = %#v, error = %v", retriedClaim, err)
	}
	scm, err := store.SessionSCM(ctx, account.ID, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if scm == nil ||
		scm.PullRequest.Number != claim.Number ||
		scm.PullRequest.URL != claim.URL ||
		scm.PullRequest.Mergeability != "unknown" {
		t.Fatalf("claimed session SCM = %#v", scm)
	}
	second := createWorker("second")
	claim.SessionID = second.ID
	if _, err := store.ClaimPullRequest(ctx, account.ID, claim); !errors.Is(err, ErrPRClaimed) {
		t.Fatalf("duplicate active claim error = %v, want ErrPRClaimed", err)
	}
}
