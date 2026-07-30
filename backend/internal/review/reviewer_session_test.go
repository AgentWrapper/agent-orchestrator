package review

import "testing"

// The reviewer's conversation id and its terminal id were the same string, so
// harnesses that pin a stable agent session (Claude Code derives a deterministic
// --session-id from it) refused the second review on a worker with "Session ID
// ... is already in use".
func TestReviewerSessionIDIsPerRunWhileThePaneIsPerWorker(t *testing.T) {
	first := reviewerSessionID("w-1", "run-1")
	second := reviewerSessionID("w-1", "run-2")
	if first == second {
		t.Fatalf("two runs on one worker shared a reviewer session id: %q", first)
	}

	// The terminal stays put, so a worker keeps one reviewer pane.
	if reviewerHandleID("w-1") != "review-w-1" {
		t.Fatalf("handle = %q, want review-w-1", reviewerHandleID("w-1"))
	}
	if first == reviewerHandleID("w-1") {
		t.Fatal("conversation id must not collide with the pane id")
	}
}

func TestReviewerSessionIDFallsBackToTheHandleWithoutARun(t *testing.T) {
	if got := reviewerSessionID("w-1", ""); got != reviewerHandleID("w-1") {
		t.Fatalf("got %q, want the handle as fallback", got)
	}
}
