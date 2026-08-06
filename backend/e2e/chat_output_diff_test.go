//go:build !windows

package e2e

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Scenarios for streamed command output and the turn's changed-file summary.
//
// Both exist because the provider's settled payloads are not enough on their own:
// aggregatedOutput arrives only at completion and was measured dropping its first
// chunk, and there is no per-file diff notification at all -- only one aggregated
// unified diff string per turn, which AO parses. So what these look for is the gap
// between "the agent did work on disk" and "AO can say what that work was".

// commandDetail decodes an activity's typed payload.
func commandDetail(t *testing.T, a activity) map[string]any {
	t.Helper()
	if len(a.DetailJSON) == 0 {
		return nil
	}
	var detail map[string]any
	if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
		t.Fatalf("activity %s detail does not decode: %v", a.ID, err)
	}
	return detail
}

// commandWithOutput finds a command activity that has output recorded.
func commandWithOutput(t *testing.T, s snapshot) (activity, map[string]any, bool) {
	t.Helper()
	for _, a := range s.Activities {
		if a.Kind != "command" {
			continue
		}
		detail := commandDetail(t, a)
		if text, ok := detail["output"].(string); ok && text != "" {
			return a, detail, true
		}
	}
	return activity{}, nil, false
}

// Output has to reach the timeline, and it has to say what it is. The provider drops
// the beginning of a command's output from BOTH the delta stream and the aggregate,
// so a card that presented either as the full record would be lying.
func TestChatCommandOutputIsRecordedAndLabelled(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "cmdoutput")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	send(t, d, session,
		"Run this exact shell command and then reply with exactly: PRINTED. "+
			"Command: for i in $(seq 1 40); do echo \"line-$i\"; done",
		"out-1")

	snap := d.awaitConversation(session, 3*time.Minute, "the command output to be recorded",
		func(s snapshot) bool {
			_, _, ok := commandWithOutput(t, s)
			return ok
		})

	found, detail, _ := commandWithOutput(t, snap)
	output, _ := detail["output"].(string)
	if !strings.Contains(output, "line-40") {
		t.Errorf("recorded output is missing the end of the run:\n%q", trim(output, 400))
	}

	// Which channel the text came from is load-bearing: the two are partial for
	// different reasons, and a client that cannot tell them apart cannot explain
	// either.
	source, _ := detail["outputSource"].(string)
	if source != "stream" && source != "aggregate" {
		t.Errorf("activity %s recorded output with no source label (%q)", found.ID, source)
	}
	// Never presented as complete, whichever channel it came from.
	if partial, _ := detail["outputMayBePartial"].(bool); !partial {
		t.Errorf("output from %q was presented as a complete record", source)
	}
}

// Output while the command is STILL RUNNING is the whole reason to accumulate deltas
// rather than wait for the aggregate. A command that prints slowly is the only case
// where the provider streams at all: measured on codex-cli 0.146.0, a fast command
// finishes before a single delta is flushed and produces only the aggregate.
func TestChatSlowCommandOutputAppearsBeforeItFinishes(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "liveoutput")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	send(t, d, session,
		"Run this exact shell command and then reply with exactly: TICKED. "+
			"Command: for i in $(seq 1 20); do echo \"tick-$i\"; sleep 1; done",
		"live-1")

	// The assertion is the timing: output visible while the activity is still
	// running. Waiting for completion first would pass on the aggregate alone and
	// prove nothing about streaming.
	snap := d.awaitConversation(session, 3*time.Minute, "output from a command still running",
		func(s snapshot) bool {
			for _, a := range s.Activities {
				if a.Kind != "command" || a.Status != "running" {
					continue
				}
				var detail map[string]any
				if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
					continue
				}
				text, _ := detail["output"].(string)
				return strings.Contains(text, "tick-")
			}
			return false
		})

	for _, a := range snap.Activities {
		if a.Kind != "command" || a.Status != "running" {
			continue
		}
		detail := commandDetail(t, a)
		if source, _ := detail["outputSource"].(string); source != "stream" {
			t.Errorf("output on a still-running command claimed source %q, but no aggregate exists yet", source)
		}
	}

	d.awaitConversation(session, 3*time.Minute, "the slow turn to settle",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })
}

// The changed-file summary has to describe what the turn actually did on disk, with
// the right kind per file. AO derives all of this by parsing one unified diff string,
// so every field here is a chance for that parse to be wrong.
func TestChatTurnDiffReportsChangedFiles(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "turndiff")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	send(t, d, session,
		"Do exactly this, then reply with exactly: EDITED. "+
			"Create a new file called added.txt containing the single line 'hello'. "+
			"Then append a line 'appended' to the end of README.md.",
		"diff-1")

	snap := d.awaitConversation(session, 4*time.Minute, "a turn diff naming both files",
		func(s snapshot) bool {
			last := s.Turns[len(s.Turns)-1]
			if last.Diff == nil {
				return false
			}
			_, added := last.Diff.fileByPath("added.txt")
			_, edited := last.Diff.fileByPath("README.md")
			return added && edited
		})

	diff := snap.Turns[len(snap.Turns)-1].Diff
	if diff.Truncated {
		t.Error("a two-file change was reported as truncated")
	}

	added, _ := diff.fileByPath("added.txt")
	// A new file must not read as a modification: that is the difference between
	// "the agent wrote this" and "the agent touched something that existed".
	if added.Status != "added" {
		t.Errorf("added.txt status = %q, want added", added.Status)
	}
	if added.Additions < 1 {
		t.Errorf("added.txt reported %d additions for a file with content", added.Additions)
	}
	if added.Deletions != 0 {
		t.Errorf("a brand-new file reported %d deletions", added.Deletions)
	}

	edited, _ := diff.fileByPath("README.md")
	if edited.Status != "modified" {
		t.Errorf("README.md status = %q, want modified", edited.Status)
	}
	if edited.Additions < 1 {
		t.Errorf("an appended line produced %d additions", edited.Additions)
	}

	// The diff belongs to the turn that made the change. Attributing it to the wrong
	// turn would show a user edits they did not ask for in that message.
	for i, turn := range snap.Turns[:len(snap.Turns)-1] {
		if turn.Diff != nil && len(turn.Diff.Files) > 0 {
			t.Errorf("turn %d (%q) also claims %d changed files", i, turn.State, len(turn.Diff.Files))
		}
	}
}

// The provider re-sends the whole diff repeatedly (three byte-identical payloads in
// one captured turn). That must overwrite per-turn state, never accumulate: a
// timeline entry per update would show the same edits over and over, and a file
// listed twice would double its counts.
func TestChatRepeatedTurnDiffDoesNotDuplicate(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "diffrepeat")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	activitiesBefore := len(d.conversation(session).Activities)

	send(t, d, session,
		"Append a line 'one' to README.md, then append a line 'two' to README.md as a "+
			"separate edit, then reply with exactly: TWICE",
		"repeat-1")

	snap := d.awaitConversation(session, 4*time.Minute, "the multi-edit turn to settle",
		func(s snapshot) bool {
			last := s.Turns[len(s.Turns)-1]
			return terminal(last.State) && last.Diff != nil
		})

	diff := snap.Turns[len(snap.Turns)-1].Diff
	seen := map[string]bool{}
	for _, file := range diff.Files {
		if seen[file.Path] {
			t.Errorf("%s is listed twice in one turn diff, so its counts are doubled", file.Path)
		}
		seen[file.Path] = true
	}

	// No timeline row per diff update. The provider sent several; the conversation
	// should carry the agent's work, not one entry per notification.
	for _, a := range snap.Activities[activitiesBefore:] {
		if a.Summary == "diff file list truncated" {
			t.Errorf("a diff update leaked into the timeline as activity %s", a.ID)
		}
	}
}

// A turn that changed nothing must not carry another turn's file list, and must not
// be confused with a turn the provider never reported on.
func TestChatTurnThatChangesNothingReportsNoFiles(t *testing.T) {
	requireE2E(t)
	d := startDaemon(t, t.TempDir())
	project := seedProject(t, d, "nodiff")
	session := chatSession(t, d, project, "Reply with exactly: READY")

	send(t, d, session, "Do not touch any files. Reply with exactly: UNTOUCHED", "nodiff-1")

	snap := d.awaitConversation(session, 3*time.Minute, "the read-only turn to settle",
		func(s snapshot) bool { return terminal(s.Turns[len(s.Turns)-1].State) })

	last := snap.Turns[len(snap.Turns)-1]
	if last.Diff != nil && len(last.Diff.Files) > 0 {
		t.Errorf("a turn that changed nothing reported %d changed files: %+v",
			len(last.Diff.Files), last.Diff.Files)
	}
}
