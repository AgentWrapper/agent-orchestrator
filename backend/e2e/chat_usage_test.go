//go:build !windows

package e2e

import (
	"net/http"
	"testing"
	"time"
)

// Scenarios for the context meter and the quota warning.
//
// Both exist to explain a failure the user cannot otherwise diagnose: a
// conversation that stops accepting turns because it is full, and a turn that fails
// for a reason unrelated to what was asked because the account is out of quota. So
// what these look for is a readout that cannot be acted on -- a used figure with no
// window to scale it against, a percentage that survives a restart as a different
// number, or usage that has crept back into the timeline.

// TestChatUsageIsReportedWithAContextWindow is the whole point of the feature: the
// header can only say "how full is this" if the provider's window comes with the
// used figure. A total on its own is a number with no scale.
func TestChatUsageIsReportedWithAContextWindow(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "usage")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	snap := d.awaitConversation(session, 3*time.Minute, "the provider to report token usage",
		func(s snapshot) bool { return s.Usage != nil && s.Usage.ContextUsed > 0 })

	usage := snap.Usage
	if usage.ContextWindow <= 0 {
		t.Fatalf("context window = %d; without it the readout is a number with no scale",
			usage.ContextWindow)
	}
	// A conversation cannot occupy more of the window than exists. If this trips,
	// the driver is reading the cumulative total as the context position, which
	// would report a fresh conversation as nearly full.
	if usage.ContextUsed > usage.ContextWindow {
		t.Errorf("context used %d exceeds the window %d; the running total is being read as the context position",
			usage.ContextUsed, usage.ContextWindow)
	}
	// A first turn should occupy a small slice of a real model's window. A figure at
	// or near capacity here means the wrong breakdown is being reported.
	if fraction := float64(usage.ContextUsed) / float64(usage.ContextWindow); fraction > 0.5 {
		t.Errorf("a single opening turn reports the context %.0f%% full", fraction*100)
	}
	if usage.TotalTokens <= 0 {
		t.Errorf("cumulative total = %d, want the conversation's spend", usage.TotalTokens)
	}
}

// Usage is current state, not history. The provider emits a report after every
// tool call, so if these ever became timeline rows a session that ran twenty
// commands would bury its own conversation under twenty accounting entries -- which
// is exactly what happened the first time this signal was handled.
func TestChatUsageIsLatestWinsAndStaysOutOfTheTimeline(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "usagestate")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	first := d.awaitConversation(session, 3*time.Minute, "the first usage report",
		func(s snapshot) bool { return s.Usage != nil && s.Usage.ContextUsed > 0 })
	before := first.Usage.ContextUsed

	// Something that forces several tool calls, so the provider reports repeatedly
	// within one turn.
	send(t, d, session,
		"Run `ls`, then `pwd`, then `date`, each as a separate shell command, then reply with exactly: WALKED",
		"usage-walk")

	snap := d.awaitConversation(session, 5*time.Minute, "the multi-command turn to settle",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })

	// Not one row per report, under any activity kind.
	for _, a := range snap.Activities {
		if a.Kind == "usage" {
			t.Fatalf("usage was written to the timeline as activity %s; one row per tool call is what buried the conversation", a.ID)
		}
	}

	if snap.Usage == nil {
		t.Fatal("usage disappeared after a turn that produced several reports")
	}
	// The conversation grew, so the state moved. An unchanged figure across a turn
	// that ran three commands would mean the projection stopped applying.
	if snap.Usage.ContextUsed <= before {
		t.Errorf("context used did not advance across a turn: %d then %d",
			before, snap.Usage.ContextUsed)
	}
	if snap.Usage.ContextUsed > snap.Usage.ContextWindow {
		t.Errorf("context used %d exceeds the window %d", snap.Usage.ContextUsed, snap.Usage.ContextWindow)
	}
}

// The quota position is read at controller startup rather than only pushed with a
// turn. That is the difference between knowing you are near a wall before spending
// a turn and finding out by failing one.
func TestChatRateLimitsAreReportedForTheAccount(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "ratelimits")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	snap := d.awaitConversation(session, 3*time.Minute, "the account's quota position",
		func(s snapshot) bool { return s.RateLimits != nil })

	limits := snap.RateLimits
	// The provider reports percentages, not token counts. A figure above 100 means
	// an absolute is being passed through as a percentage.
	if limits.PrimaryUsedPercent > 100 {
		t.Errorf("primary window = %v; a percentage cannot exceed 100, so an absolute is leaking through",
			limits.PrimaryUsedPercent)
	}
	// Negative is the "not reported" signal and is legitimate for a window the
	// account does not have. Anything else must be a real percentage.
	if limits.PrimaryUsedPercent >= 0 && limits.SecondaryUsedPercent > 100 {
		t.Errorf("secondary window = %v, want a percentage or a negative", limits.SecondaryUsedPercent)
	}
	if limits.PrimaryUsedPercent < 0 && limits.SecondaryUsedPercent < 0 {
		t.Error("neither window was reported, so the quota warning can never fire")
	}
	// A reset is a remaining duration, not the absolute instant the provider sends.
	// A value of this size would be a unix timestamp that leaked through unconverted.
	const tenYears = int64(10 * 365 * 24 * 60 * 60)
	if limits.PrimaryResetsInSeconds > tenYears {
		t.Errorf("primary resets in %d seconds; an absolute timestamp was not converted to a duration",
			limits.PrimaryResetsInSeconds)
	}
	if limits.PrimaryResetsInSeconds < 0 || limits.SecondaryResetsInSeconds < 0 {
		t.Errorf("negative reset durations (%d, %d); a window cannot refill in the past",
			limits.PrimaryResetsInSeconds, limits.SecondaryResetsInSeconds)
	}
}

// Usage and limits are durable state on the conversation, so they have to survive
// the controller that recorded them. History stays readable after the agent process
// is gone, and the meter is part of that history.
func TestChatUsageSurvivesADaemonRestart(t *testing.T) {
	requireE2E(t)
	dir := t.TempDir()
	d := startDaemon(t, dir)
	project := seedProject(t, d, "usagerestart")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	before := d.awaitConversation(session, 3*time.Minute, "usage to be recorded",
		func(s snapshot) bool { return s.Usage != nil && s.Usage.ContextUsed > 0 })

	// A clean shutdown, the way quitting the app behaves, then the same data dir.
	d.stop()
	restarted := startDaemon(t, dir)

	var after snapshot
	restarted.mustCall("GET", "/sessions/"+session+"/conversation", http.StatusOK, nil, &after)

	if after.Usage == nil {
		t.Fatal("usage was lost across a restart; it is conversation state, not controller state")
	}
	if after.Usage.ContextUsed != before.Usage.ContextUsed {
		t.Errorf("context used changed across a restart: %d then %d",
			before.Usage.ContextUsed, after.Usage.ContextUsed)
	}
	if after.Usage.ContextWindow != before.Usage.ContextWindow {
		t.Errorf("context window changed across a restart: %d then %d",
			before.Usage.ContextWindow, after.Usage.ContextWindow)
	}
	if before.RateLimits != nil {
		if after.RateLimits == nil {
			t.Fatal("rate limits were lost across a restart")
		}
		// An unreported window has to come back unreported. Reading as 0 instead
		// would claim untouched quota, which is a much more reassuring statement.
		if (before.RateLimits.SecondaryUsedPercent < 0) != (after.RateLimits.SecondaryUsedPercent < 0) {
			t.Errorf("an unreported window changed meaning across a restart: %v then %v",
				before.RateLimits.SecondaryUsedPercent, after.RateLimits.SecondaryUsedPercent)
		}
	}
}
