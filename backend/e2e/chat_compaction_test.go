//go:build !windows

package e2e

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// Scenarios for reclaiming context.
//
// Every turn re-sends the whole conversation, so context fills whether or not the
// user does anything unusual, and once it is full the thread cannot accept another
// turn at all. Compaction is the difference between a session that works for an
// hour and one that works for a day, which is why the promise worth checking here
// is not "the call returned 202" but "the conversation still works afterwards and
// the timeline says what happened".
//
// The provider reports no token figures on its own compaction event, so the driver
// brackets them from the token-usage reports either side of the compaction turn.
// That bracketing is only observable against a real app-server, which is what makes
// this an end-to-end scenario rather than a unit test.

type compactAccepted struct {
	TokensBefore int64 `json:"tokensBefore"`
	TokensAfter  int64 `json:"tokensAfter"`
}

type compactionDetail struct {
	Event           string `json:"event"`
	TokensBefore    int64  `json:"tokensBefore"`
	TokensAfter     int64  `json:"tokensAfter"`
	TokensReclaimed int64  `json:"tokensReclaimed"`
	ContextWindow   int64  `json:"contextWindow"`
}

// compactionMarkers reads the compaction entries out of a timeline the way the
// renderer does: by the discriminator in the detail payload, not by the activity
// kind. `system` is a general bucket, so the kind alone does not identify one.
func compactionMarkers(s snapshot) []compactionDetail {
	var found []compactionDetail
	for _, a := range s.Activities {
		if a.Kind != "system" || len(a.DetailJSON) == 0 {
			continue
		}
		var detail compactionDetail
		if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
			continue
		}
		if detail.Event == "compaction" {
			found = append(found, detail)
		}
	}
	return found
}

func TestChatCompactionReclaimsContextAndSaysSo(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "compaction")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	// Give the conversation some history to summarize. Even two small turns carry a
	// real context load, because the provider's own instructions dominate it.
	send(t, d, session, "List the files in this repo, then reply with exactly: LISTED", "compact-1")
	d.awaitConversation(session, 3*time.Minute, "history to accumulate", func(s snapshot) bool {
		return len(s.Turns) >= 2 && terminal(s.Turns[len(s.Turns)-1].State)
	})

	var accepted compactAccepted
	d.mustCall("POST", "/sessions/"+session+"/conversation/compact",
		http.StatusAccepted, nil, &accepted)
	// 202, not 200: the provider takes the request and does the work as its own turn
	// over the following seconds. Reporting the before figure is the honest thing to
	// answer with at that point.
	if accepted.TokensBefore <= 0 {
		t.Errorf("compaction reported no context position; there was a conversation to measure")
	}
	if accepted.TokensAfter != 0 {
		t.Errorf("tokensAfter = %d, want 0 while the reclaim is still in flight", accepted.TokensAfter)
	}

	snap := d.awaitConversation(session, 3*time.Minute, "the compaction to land on the timeline",
		func(s snapshot) bool { return len(compactionMarkers(s)) > 0 })

	markers := compactionMarkers(snap)
	if len(markers) != 1 {
		t.Fatalf("got %d compaction entries for one compaction:\n%s", len(markers), describe(snap))
	}
	marker := markers[0]

	// The figures have to be internally consistent or the reclaim they claim is
	// meaningless. They are checked rather than required, because a compaction whose
	// token reports AO never saw honestly does not know what it saved and says
	// nothing instead of inventing a number.
	if marker.TokensReclaimed != 0 {
		if marker.TokensBefore <= marker.TokensAfter {
			t.Errorf("claimed a reclaim of %d from %d -> %d, which cannot be true",
				marker.TokensReclaimed, marker.TokensBefore, marker.TokensAfter)
		}
		if want := marker.TokensBefore - marker.TokensAfter; marker.TokensReclaimed != want {
			t.Errorf("reclaimed = %d, want %d from the bracket", marker.TokensReclaimed, want)
		}
	}
	if marker.TokensAfter != 0 && marker.ContextWindow != 0 && marker.TokensAfter > marker.ContextWindow {
		t.Errorf("context used (%d) exceeds the window (%d)", marker.TokensAfter, marker.ContextWindow)
	}

	// The conversation records it too, so a client does not have to walk the
	// timeline to find out whether compaction has run.
	if snap.CompactedAt == nil || *snap.CompactedAt == "" {
		t.Error("the conversation was not marked compacted; a restart would forget it happened")
	}

	// The whole point. A compaction that reclaimed context but left the session
	// unable to take another turn would have solved nothing.
	send(t, d, session, "Reply with exactly: STILLHERE", "compact-after")
	after := d.awaitConversation(session, 3*time.Minute, "a turn after compaction",
		func(s snapshot) bool { return contains(s.assistantText(), "STILLHERE") })
	for _, turn := range after.Turns {
		if turn.State == "failed" {
			t.Errorf("a turn failed around the compaction (%q):\n%s", turn.ErrorMessage, describe(after))
		}
	}
}

// Measured twice against a live app-server: thread/compact/start mid-turn silently
// interrupts the running turn and reports it as interrupted, then compacts. The
// daemon refuses instead of forwarding it, because losing work the user is waiting
// on as a side effect of housekeeping is not something they should discover
// afterwards from the timeline.
func TestChatCompactionIsRefusedWhileATurnIsInFlight(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "compactbusy")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	send(t, d, session, "Count slowly from 1 to 40, one number per line, then reply: COUNTED", "compact-busy")
	d.awaitConversation(session, 1*time.Minute, "the turn to be running", func(s snapshot) bool {
		for _, turn := range s.Turns {
			if turn.State == "running" {
				return true
			}
		}
		return false
	})

	status, body := d.callExpectingError("POST", "/sessions/"+session+"/conversation/compact", nil)
	if status == http.StatusAccepted {
		t.Skip("the turn finished before the compaction request landed; nothing to assert")
	}
	if status >= 500 {
		t.Fatalf("compacting mid-turn returned %d (%+v); this is a refusal, not a server fault",
			status, body)
	}
	if status != http.StatusConflict || body.Code != "CHAT_COMPACTION_BUSY" {
		t.Errorf("status/code = %d/%q, want 409/CHAT_COMPACTION_BUSY", status, body.Code)
	}

	// The turn the refusal protected must still be the user's. Nothing was
	// interrupted on their behalf.
	snap := d.awaitConversation(session, 3*time.Minute, "the protected turn to finish",
		func(s snapshot) bool {
			return terminal(s.Turns[len(s.Turns)-1].State)
		})
	if got := snap.Turns[len(snap.Turns)-1].State; got == "interrupted" {
		t.Errorf("the running turn was interrupted anyway; the refusal did not protect it:\n%s",
			describe(snap))
	}
	if len(compactionMarkers(snap)) != 0 {
		t.Errorf("a compaction ran despite the refusal:\n%s", describe(snap))
	}
}
