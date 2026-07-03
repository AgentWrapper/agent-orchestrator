package lifecycle

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func hotCollision(a, b domain.SessionID, nameA, nameB, sig string, files ...domain.CollisionFile) domain.CollisionWithNames {
	return domain.CollisionWithNames{
		SessionCollision: domain.SessionCollision{
			SessionA:  a,
			SessionB:  b,
			Severity:  domain.CollisionHot,
			Files:     files,
			Signature: sig,
		},
		NameA: nameA,
		NameB: nameB,
	}
}

func TestApplyCollision_NudgesBothLiveParticipants(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.sessions["mer-2"] = working("mer-2")

	c := hotCollision("mer-1", "mer-2", "alpha", "bravo", "sig1",
		domain.CollisionFile{Path: "config.go", Ranges: [][2]int{{15, 20}}})
	if err := m.ApplyCollision(ctx, c); err != nil {
		t.Fatalf("ApplyCollision: %v", err)
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("want 2 nudges (one per participant), got %d: %v", len(msg.msgs), msg.msgs)
	}
	// The message sent to mer-1 names the peer (bravo) and the overlapping file.
	joined := strings.Join(msg.msgs, "\n")
	if !strings.Contains(joined, "alpha") || !strings.Contains(joined, "bravo") {
		t.Fatalf("nudges should name both peers; got %v", msg.msgs)
	}
	if !strings.Contains(joined, "config.go") {
		t.Fatalf("nudges should name the overlapping file; got %v", msg.msgs)
	}
}

func TestApplyCollision_DedupesSameSignature(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.sessions["mer-2"] = working("mer-2")
	c := hotCollision("mer-1", "mer-2", "alpha", "bravo", "sig1",
		domain.CollisionFile{Path: "config.go"})

	for i := 0; i < 3; i++ {
		if err := m.ApplyCollision(ctx, c); err != nil {
			t.Fatalf("ApplyCollision %d: %v", i, err)
		}
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("same signature must nudge each participant once; got %d", len(msg.msgs))
	}
}

func TestApplyCollision_RenudgesOnChangedSignature(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.sessions["mer-2"] = working("mer-2")

	if err := m.ApplyCollision(ctx, hotCollision("mer-1", "mer-2", "a", "b", "sig1", domain.CollisionFile{Path: "config.go"})); err != nil {
		t.Fatal(err)
	}
	if err := m.ApplyCollision(ctx, hotCollision("mer-1", "mer-2", "a", "b", "sig2", domain.CollisionFile{Path: "config.go", Ranges: [][2]int{{1, 9}}})); err != nil {
		t.Fatal(err)
	}
	if len(msg.msgs) != 4 {
		t.Fatalf("changed signature should re-nudge both; want 4 total, got %d", len(msg.msgs))
	}
}

func TestApplyCollision_SkipsTerminatedRecipient(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	term := working("mer-2")
	term.IsTerminated = true
	st.sessions["mer-2"] = term

	c := hotCollision("mer-1", "mer-2", "alpha", "bravo", "sig1", domain.CollisionFile{Path: "config.go"})
	if err := m.ApplyCollision(ctx, c); err != nil {
		t.Fatalf("ApplyCollision: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("terminated recipient must be skipped; want 1 nudge, got %d", len(msg.msgs))
	}
}

func TestApplyCollision_SoftIsNoOp(t *testing.T) {
	m, st, msg := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.sessions["mer-2"] = working("mer-2")
	soft := domain.CollisionWithNames{
		SessionCollision: domain.SessionCollision{SessionA: "mer-1", SessionB: "mer-2", Severity: domain.CollisionSoft, Signature: "s"},
		NameA:            "a", NameB: "b",
	}
	if err := m.ApplyCollision(ctx, soft); err != nil {
		t.Fatalf("ApplyCollision: %v", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("soft collision must not nudge; got %d", len(msg.msgs))
	}
}
