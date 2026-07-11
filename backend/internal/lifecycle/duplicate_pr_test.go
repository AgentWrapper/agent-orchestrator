package lifecycle

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeCommenter struct {
	mu       sync.Mutex
	comments []struct{ url, body string }
	err      error
	gate     chan struct{}
}

func (f *fakeCommenter) PostIssueComment(_ context.Context, prURL, body string) error {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.comments = append(f.comments, struct{ url, body string }{prURL, body})
	return nil
}

func sampleDuplicateFact() ports.DuplicatePRFact {
	return ports.DuplicatePRFact{
		ProjectID:         "ao",
		IssueRef:          "acme/demo#169",
		DupSessionID:      "ao-94b",
		DupSessionDisplay: "demo #169 metrics",
		DupPRURL:          "https://github.com/acme/demo/pull/180",
		DupPRNumber:       180,
		DupPRTitle:        "metrics observer",
		ExistingSessionID: "ao-94a",
		ExistingPRURL:     "https://github.com/acme/demo/pull/172",
		ExistingPRNumber:  172,
		Provider:          "github",
		Repo:              "acme/demo",
	}
}

// HandleDuplicatePR comments on the newer PR naming the existing one and emits a
// loud duplicate_pr notification (issue #181 AC1).
func TestHandleDuplicatePR_CommentsAndNotifies(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	commenter := &fakeCommenter{}
	m := New(st, nil, WithNotificationSink(sink), WithSCMCommenter(commenter))
	fact := sampleDuplicateFact()

	if err := m.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("HandleDuplicatePR: %v", err)
	}
	if len(commenter.comments) != 1 {
		t.Fatalf("comments = %d, want 1", len(commenter.comments))
	}
	c := commenter.comments[0]
	if c.url != fact.DupPRURL {
		t.Fatalf("commented on %q, want the newer/duplicate PR %q", c.url, fact.DupPRURL)
	}
	if !strings.Contains(c.body, fact.ExistingPRURL) {
		t.Fatalf("comment body must name the existing PR; got %q", c.body)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1", len(sink.intents))
	}
	intent := sink.intents[0]
	if intent.Type != domain.NotificationDuplicatePR {
		t.Fatalf("intent type = %q, want duplicate_pr", intent.Type)
	}
	if intent.SessionID != fact.DupSessionID || intent.PRURL != fact.DupPRURL || intent.DuplicateOfPRURL != fact.ExistingPRURL {
		t.Fatalf("intent = %+v", intent)
	}
}

// A re-observation of the same duplicate must not re-comment or re-notify: the
// persisted signature dedups it (idempotency across polls/restarts).
func TestHandleDuplicatePR_IdempotentAcrossPolls(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	commenter := &fakeCommenter{}
	m := New(st, nil, WithNotificationSink(sink), WithSCMCommenter(commenter))
	fact := sampleDuplicateFact()

	for i := 0; i < 3; i++ {
		if err := m.HandleDuplicatePR(ctx, fact); err != nil {
			t.Fatalf("HandleDuplicatePR #%d: %v", i, err)
		}
	}
	if len(commenter.comments) != 1 {
		t.Fatalf("comments = %d, want exactly 1 across repeated polls", len(commenter.comments))
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want exactly 1 across repeated polls", len(sink.intents))
	}
}

// A comment failure must not settle the dedup signature: the next poll retries
// (and the notification still fires so the operator is alerted immediately).
func TestHandleDuplicatePR_CommentFailureRetriesNextPoll(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	commenter := &fakeCommenter{err: errors.New("no write scope")}
	m := New(st, nil, WithNotificationSink(sink), WithSCMCommenter(commenter))
	fact := sampleDuplicateFact()

	if err := m.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("HandleDuplicatePR: %v", err)
	}
	// First poll: comment failed, notification still fired.
	if len(sink.intents) != 1 {
		t.Fatalf("intents after failed comment = %d, want 1", len(sink.intents))
	}
	// The comment signature must be unset so a retry re-attempts the comment; the
	// notification signature is settled so it does NOT re-fire.
	commenter.err = nil
	if err := m.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("HandleDuplicatePR retry: %v", err)
	}
	if len(commenter.comments) != 1 {
		t.Fatalf("comments after retry = %d, want 1 (the retry succeeded)", len(commenter.comments))
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents after comment retry = %d, want 1 (notification must not re-fire)", len(sink.intents))
	}
}

// A notification failure must not settle the notify signature (it retries) and
// must not block or repeat a successful comment. This is the inverse of the
// comment-failure case: the two effects are independently idempotent.
func TestHandleDuplicatePR_NotificationFailureRetriesWithoutRepeatingComment(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{err: errors.New("store down")}
	commenter := &fakeCommenter{}
	m := New(st, nil, WithNotificationSink(sink), WithSCMCommenter(commenter))
	fact := sampleDuplicateFact()

	if err := m.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("HandleDuplicatePR: %v", err)
	}
	// Comment landed once; notification attempt failed.
	if len(commenter.comments) != 1 {
		t.Fatalf("comments = %d, want 1", len(commenter.comments))
	}
	// Recover the sink and re-poll: the notification retries, the comment does not.
	sink.err = nil
	if err := m.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("HandleDuplicatePR retry: %v", err)
	}
	if len(commenter.comments) != 1 {
		t.Fatalf("comments after notify retry = %d, want 1 (comment must not repeat)", len(commenter.comments))
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents after retry = %d, want 1 (the retry delivered)", len(sink.intents))
	}
}

// Idempotency survives a daemon restart: a second Manager over the same store
// reads the persisted signatures and does not re-comment or re-notify.
func TestHandleDuplicatePR_IdempotentAcrossRestart(t *testing.T) {
	st := newFakeStore()
	fact := sampleDuplicateFact()

	sink1 := &fakeNotificationSink{}
	commenter1 := &fakeCommenter{}
	m1 := New(st, nil, WithNotificationSink(sink1), WithSCMCommenter(commenter1))
	if err := m1.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("m1 HandleDuplicatePR: %v", err)
	}
	if len(commenter1.comments) != 1 || len(sink1.intents) != 1 {
		t.Fatalf("m1 effects: comments=%d intents=%d, want 1/1", len(commenter1.comments), len(sink1.intents))
	}

	// Fresh Manager over the same store == a daemon restart with an empty
	// in-memory react map; it must load the persisted signatures and no-op.
	sink2 := &fakeNotificationSink{}
	commenter2 := &fakeCommenter{}
	m2 := New(st, nil, WithNotificationSink(sink2), WithSCMCommenter(commenter2))
	if err := m2.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("m2 HandleDuplicatePR: %v", err)
	}
	if len(commenter2.comments) != 0 {
		t.Fatalf("m2 re-commented %d times after restart, want 0", len(commenter2.comments))
	}
	if len(sink2.intents) != 0 {
		t.Fatalf("m2 re-notified %d times after restart, want 0", len(sink2.intents))
	}
}

// Two concurrent HandleDuplicatePR calls for the same duplicate must produce the
// effect at most once: the in-flight reservation makes the check-then-act atomic
// even though external I/O runs with the lock released (reviewer finding 1b).
// Run with -race to catch map races.
func TestHandleDuplicatePR_ConcurrentCallsFireOnce(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	commenter := &fakeCommenter{gate: make(chan struct{})}
	m := New(st, nil, WithNotificationSink(sink), WithSCMCommenter(commenter))
	fact := sampleDuplicateFact()

	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			_ = m.HandleDuplicatePR(ctx, fact)
		}()
	}
	// Release both blocked comment attempts (only one should have been reserved).
	close(commenter.gate)
	wg.Wait()

	commenter.mu.Lock()
	gotComments := len(commenter.comments)
	commenter.mu.Unlock()
	sink.mu.Lock()
	gotIntents := len(sink.intents)
	sink.mu.Unlock()
	if gotComments != 1 {
		t.Fatalf("concurrent comments = %d, want exactly 1", gotComments)
	}
	if gotIntents != 1 {
		t.Fatalf("concurrent notifications = %d, want exactly 1", gotIntents)
	}
}

// Without a commenter wired, the guard still notifies (comment is best-effort).
func TestHandleDuplicatePR_NoCommenterStillNotifies(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	m := New(st, nil, WithNotificationSink(sink))
	fact := sampleDuplicateFact()

	if err := m.HandleDuplicatePR(ctx, fact); err != nil {
		t.Fatalf("HandleDuplicatePR: %v", err)
	}
	if len(sink.intents) != 1 {
		t.Fatalf("intents = %d, want 1 even without a commenter", len(sink.intents))
	}
}

// A malformed fact (missing/equal PR URLs) is a no-op, never a panic.
func TestHandleDuplicatePR_IgnoresDegenerateFacts(t *testing.T) {
	st := newFakeStore()
	sink := &fakeNotificationSink{}
	commenter := &fakeCommenter{}
	m := New(st, nil, WithNotificationSink(sink), WithSCMCommenter(commenter))

	cases := []ports.DuplicatePRFact{
		{ExistingPRURL: "https://github.com/acme/demo/pull/172"},      // no dup url
		{DupPRURL: "https://github.com/acme/demo/pull/180"},           // no existing url
		{DupPRURL: "https://x/pr/1", ExistingPRURL: "https://x/pr/1"}, // same url
	}
	for i, fact := range cases {
		if err := m.HandleDuplicatePR(ctx, fact); err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
	}
	if len(commenter.comments) != 0 || len(sink.intents) != 0 {
		t.Fatalf("degenerate facts produced comments=%d intents=%d", len(commenter.comments), len(sink.intents))
	}
}
