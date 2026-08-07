//go:build !windows

package e2e

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// End-to-end coverage for the provider signal AO used to drop.
//
// These are here rather than only in the unit tests because the claim is about the
// whole stack: the driver has to read the notification, the projection has to write
// it, the store has to keep it, and the snapshot route has to serve it. A field that
// is right in three of those four is not shipped.
//
// One turn drives all of it, because one turn is what the provider gives: asking for
// a planned multi-step edit produces a plan, reasoning, a file change and thread
// status transitions together, and spending four model calls to observe them
// separately would buy nothing.

func TestChatE2EProviderStateFromOneTurn(t *testing.T) {
	requireE2E(t)

	dataDir := t.TempDir()
	d := startDaemon(t, dataDir)
	projectID := seedProject(t, d, "provider-state")

	session := spawn(t, d, map[string]any{
		"projectId": projectID,
		"kind":      "worker",
		"harness":   "codex",
		"mode":      "chat",
	}).Session.ID

	d.mustCall("POST", "/sessions/"+session+"/conversation/messages", http.StatusAccepted,
		map[string]any{
			"text": "Use your plan tool (update_plan) for a three-step plan, then carry it out: " +
				"(1) append a line containing three to README.md, (2) create notes.md with two short " +
				"sentences, (3) run `ls -la` and report how many entries it printed. " +
				"Finish with one sentence.",
			"clientMessageId": "provider-state-1",
		}, nil)

	snap := d.awaitConversation(session, 5*time.Minute, "the turn to finish", func(s snapshot) bool {
		for _, turn := range s.Turns {
			if terminal(turn.State) {
				return true
			}
		}
		return false
	})

	/* ---- plan ---------------------------------------------------------- */

	// A plan is structured steps carrying their own status. The provider re-sends the
	// whole plan on every change, so what must be here is the LATEST one, not a stack
	// of three.
	var plan *turnPlan
	for _, turn := range snap.Turns {
		if turn.Plan != nil && len(turn.Plan.Steps) > 0 {
			plan = turn.Plan
		}
	}
	if plan == nil {
		t.Errorf("no turn carried a plan\n%s", describe(snap))
	} else {
		for i, step := range plan.Steps {
			if step.Text == "" {
				t.Errorf("plan step %d has no text: %+v", i, step)
			}
			switch step.Status {
			case "pending", "in_progress", "completed":
			default:
				t.Errorf("plan step %d status = %q, want AO's own spelling", i, step.Status)
			}
		}
		t.Logf("plan: %d steps, explanation=%q", len(plan.Steps), plan.Explanation)
		for i, step := range plan.Steps {
			t.Logf("  step %d [%s] %s", i, step.Status, trim(step.Text, 70))
		}
		if planRows := activitiesOfKind(snap, "plan"); len(planRows) > 1 {
			t.Errorf("plan produced %d timeline rows; the provider re-sends the whole plan, "+
				"so it must update one row", len(planRows))
		}
	}

	/* ---- reasoning ----------------------------------------------------- */

	// Reasoning used to be a row with no text at all, because the old driver looked
	// for a `text` field a reasoning item does not have. Whether the provider streams
	// summaries depends on the installed config, so an empty summary is tolerated —
	// but a row that has text must carry it where the client reads it.
	reasoning := activitiesOfKind(snap, "reasoning")
	if len(reasoning) == 0 {
		t.Logf("the provider reported no reasoning items for this turn")
	}
	t.Logf("%d reasoning rows", len(reasoning))
	for _, row := range reasoning {
		if row.Status == "running" {
			t.Errorf("reasoning row %s never settled", short(row.ID))
		}
		if text := detailString(t, row, "text"); text != "" {
			t.Logf("reasoning text: %q", trim(text, 90))
		}
	}

	/* ---- file changes -------------------------------------------------- */

	changes := activitiesOfKind(snap, "file_change")
	if len(changes) == 0 {
		t.Fatalf("the agent was asked to edit two files and no file_change activity landed\n%s",
			describe(snap))
	}
	var sawPatch bool
	t.Logf("thread state: %+v", snap.ThreadState)
	for _, row := range changes {
		t.Logf("file change %q status=%s", trim(row.Summary, 70), row.Status)
		files := detailFiles(t, row)
		if len(files) == 0 {
			t.Errorf("file change %s carried no files: %s", short(row.ID), row.DetailJSON)
			continue
		}
		for _, file := range files {
			if file.Path == "" {
				t.Errorf("changed file has no path: %+v", file)
			}
			// The provider spells the change kind as an object. AO's own status is what
			// a client can actually read.
			switch file.Status {
			case "added", "modified", "deleted", "renamed":
			default:
				t.Errorf("changed file status = %q, want AO's neutral spelling", file.Status)
			}
			if file.Patch != "" {
				sawPatch = true
			}
		}
		// The label used to be "Edited files" whether one path or thirty changed.
		if row.Summary == "Edited files" && len(files) == 1 {
			t.Errorf("a single-file change was labelled generically: %q", row.Summary)
		}
	}
	if !sawPatch {
		t.Error("no file change carried patch text, so a client cannot render the diff " +
			"until the turn's aggregate arrives")
	}

	/* ---- thread state -------------------------------------------------- */

	// Every turn produces thread/status/changed, so this is the one piece of provider
	// state that must be present regardless of local configuration.
	if snap.ThreadState == nil {
		t.Fatalf("the provider reported no thread state\n%s", describe(snap))
	}
	switch snap.ThreadState.Status {
	case "active", "idle":
	default:
		t.Errorf("thread status = %q after a finished turn", snap.ThreadState.Status)
	}
	if snap.ThreadState.ArchivedAt != nil {
		t.Errorf("a thread nobody archived reported archivedAt = %v", *snap.ThreadState.ArchivedAt)
	}

	/* ---- MCP servers --------------------------------------------------- */

	// Configuration-dependent: an install with no tool servers reports none, and that
	// is a real answer rather than a failure.
	if len(snap.MCPServers) == 0 {
		t.Logf("no MCP servers configured for this install")
	}
	for _, server := range snap.MCPServers {
		t.Logf("mcp server %q status=%q failure=%q", server.Name, server.Status, server.FailureReason)
		if server.Name == "" {
			t.Errorf("MCP server reported with no name: %+v", server)
		}
		switch server.Status {
		case "starting", "ready", "failed", "cancelled":
		default:
			t.Errorf("MCP server %q status = %q", server.Name, server.Status)
		}
	}

	/* ---- reroute and account ------------------------------------------- */

	// Neither is provokable from a test. Asserting they are ABSENT is still worth
	// doing: a snapshot that claimed the model had been swapped, or that the account
	// needed re-authentication, when neither happened would be a worse lie than
	// reporting nothing.
	if snap.ModelReroute != nil {
		t.Errorf("a turn nobody rerouted reported one: %+v", snap.ModelReroute)
	}
	if snap.Account != nil && snap.Account.ReauthRequiredAt != nil {
		t.Errorf("a working session claimed it needed re-authentication: %+v", snap.Account)
	}
}

// The reload is the only recovery for a tool server that failed to start, so the
// route has to work on an idle conversation and be refused on a busy one.
func TestChatE2EReloadMCPServers(t *testing.T) {
	requireE2E(t)

	d := startDaemon(t, t.TempDir())
	projectID := seedProject(t, d, "mcp-reload")

	session := spawn(t, d, map[string]any{
		"projectId": projectID,
		"kind":      "worker",
		"harness":   "codex",
		"mode":      "chat",
	}).Session.ID
	d.awaitLiveController(session, 90*time.Second)

	var reloaded struct {
		Servers []mcpServerState `json:"servers"`
	}
	d.mustCall("POST", "/sessions/"+session+"/conversation/mcp/reload", http.StatusOK, nil, &reloaded)
	for _, server := range reloaded.Servers {
		if server.Name == "" {
			t.Errorf("reload reported a server with no name: %+v", server)
		}
	}
	t.Logf("reload reported %d tool servers", len(reloaded.Servers))

	// Mid-turn it is refused rather than pulling tools out from under work in flight.
	d.mustCall("POST", "/sessions/"+session+"/conversation/messages", http.StatusAccepted,
		map[string]any{
			"text":            "Count slowly from one to twenty in words, one per line.",
			"clientMessageId": "mcp-reload-busy",
		}, nil)

	status, apiErr := d.callExpectingError("POST", "/sessions/"+session+"/conversation/mcp/reload", nil)
	switch {
	case status == http.StatusConflict && apiErr.Code == "CHAT_TURN_RUNNING":
		if strings.Contains(apiErr.Message, "rolling back") {
			t.Errorf("the busy refusal talks about rolling back: %q", apiErr.Message)
		}
	case status == http.StatusOK:
		// The turn finished before the second call landed. Not a failure of the rule,
		// just a race this test cannot control, and saying so is better than
		// pretending the assertion held.
		t.Log("the turn completed before the busy reload landed; the refusal was not exercised")
	default:
		t.Errorf("busy reload -> %d %s %q", status, apiErr.Code, apiErr.Message)
	}
}

/* ---- helpers ----------------------------------------------------------- */

func activitiesOfKind(s snapshot, kind string) []activity {
	var out []activity
	for _, a := range s.Activities {
		if a.Kind == kind {
			out = append(out, a)
		}
	}
	return out
}

func detailString(t *testing.T, a activity, key string) string {
	t.Helper()
	if len(a.DetailJSON) == 0 {
		return ""
	}
	var detail map[string]any
	if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
		t.Errorf("activity %s detail is not an object: %v", short(a.ID), err)
		return ""
	}
	value, _ := detail[key].(string)
	return value
}

// detailFile mirrors what a client reads out of a file_change activity: AO's own
// per-file shape, including the patch text that lets a diff render before the turn's
// aggregate arrives.
type detailFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Patch     string `json:"patch"`
}

func detailFiles(t *testing.T, a activity) []detailFile {
	t.Helper()
	if len(a.DetailJSON) == 0 {
		return nil
	}
	var detail struct {
		Files []detailFile `json:"files"`
	}
	if err := json.Unmarshal(a.DetailJSON, &detail); err != nil {
		t.Errorf("activity %s detail is not an object: %v", short(a.ID), err)
		return nil
	}
	return detail.Files
}
