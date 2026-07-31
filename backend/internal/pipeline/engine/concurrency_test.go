package engine

import (
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// prSubject is a PR subject on the given number, with a local session so the
// session scope also has an identity to resolve.
func prSubject(number int) pipeline.Subject {
	return pipeline.Subject{
		Kind:      pipeline.SubjectPR,
		ProjectID: "proj",
		SessionID: "sess-1",
		PR:        &pipeline.PRRef{Number: number, Repo: "acme/app"},
	}
}

func sessionSubject(id string) pipeline.Subject {
	return pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: "proj", SessionID: id}
}

// reviewPipeline is the per-PR shape from spec section 10: no explicit scope,
// so it defaults to the subject's natural scope.
func reviewPipeline() pipeline.Definition {
	return pipeline.Definition{
		ID:        "def-review",
		ProjectID: "proj",
		Name:      "review",
		Config: pipeline.Pipeline{
			Name:        "review",
			On:          pipeline.TriggerSpec{PR: []pipeline.PREvent{pipeline.PREventUpdated}},
			Concurrency: pipeline.ConcurrencySpec{CancelInProgress: true},
		},
	}
}

// releasePipeline is the spec section 11 example: a pr.merged trigger with an
// explicit project scope, so every PR merge serializes against every other.
func releasePipeline() pipeline.Definition {
	return pipeline.Definition{
		ID:        "def-release",
		ProjectID: "proj",
		Name:      "release",
		Config: pipeline.Pipeline{
			Name: "release",
			On:   pipeline.TriggerSpec{PR: []pipeline.PREvent{pipeline.PREventMerged}},
			Concurrency: pipeline.ConcurrencySpec{
				Scope:            pipeline.ConcurrencyScopeProject,
				Group:            "release",
				CancelInProgress: false,
			},
		},
	}
}

func trigger(def pipeline.Definition, subject pipeline.Subject, runID pipeline.RunID) pendingTrigger {
	return pendingTrigger{Definition: def, Event: "pr.updated", Subject: subject, RunID: runID}
}

func admit(t *testing.T, table *ConcurrencyTable, def pipeline.Definition, subject pipeline.Subject, runID pipeline.RunID) Admission {
	t.Helper()
	return table.Admit(keyFor(def, subject), def.Config.Concurrency.CancelInProgress, trigger(def, subject, runID))
}

func TestKeyForDefaultsGroupToPipelineName(t *testing.T) {
	def := reviewPipeline()
	key := keyFor(def, prSubject(412))
	if key.Group != "review" {
		t.Errorf("group = %q, want the pipeline name %q", key.Group, "review")
	}
	if key.ScopeIdentity != "acme/app#412" {
		t.Errorf("scope identity = %q, want %q", key.ScopeIdentity, "acme/app#412")
	}
}

// Scope defaults by trigger family: pr.* subjects get pr scope, session.*
// subjects get session scope (spec section 10).
func TestKeyForScopeDefaultsByTriggerFamily(t *testing.T) {
	def := reviewPipeline()
	if got := keyFor(def, prSubject(412)).ScopeIdentity; got != "acme/app#412" {
		t.Errorf("pr subject identity = %q, want %q", got, "acme/app#412")
	}
	if got := keyFor(def, sessionSubject("sess-7")).ScopeIdentity; got != "sess-7" {
		t.Errorf("session subject identity = %q, want %q", got, "sess-7")
	}
	project := pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj"}
	if got := keyFor(def, project).ScopeIdentity; got != "proj" {
		t.Errorf("project subject identity = %q, want %q", got, "proj")
	}
}

// Two different PRs on the same pipeline never collide: different identities,
// so both start now.
func TestAdmitDifferentPRsRunConcurrently(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()

	first := admit(t, &table, def, prSubject(412), "run-1")
	second := admit(t, &table, def, prSubject(413), "run-2")

	if first.Kind != StartNow {
		t.Errorf("PR 412 admission = %q, want %q", first.Kind, StartNow)
	}
	if second.Kind != StartNow {
		t.Errorf("PR 413 admission = %q, want %q", second.Kind, StartNow)
	}
}

// The same PR serializes: with cancel-in-progress off, the second arrival
// queues behind the first.
func TestAdmitSamePRSerializes(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()
	def.Config.Concurrency.CancelInProgress = false

	if got := admit(t, &table, def, prSubject(412), "run-1"); got.Kind != StartNow {
		t.Fatalf("first admission = %q, want %q", got.Kind, StartNow)
	}
	second := admit(t, &table, def, prSubject(412), "run-2")
	if second.Kind != Queued {
		t.Errorf("second admission = %q, want %q", second.Kind, Queued)
	}
	if second.Victim != "" {
		t.Errorf("queued admission carries victim %q, want none", second.Victim)
	}
}

// Two pipelines that declare the same group share a bucket even though their
// names differ.
func TestAdmitSharedGroupSerializesAcrossPipelines(t *testing.T) {
	var table ConcurrencyTable
	first := reviewPipeline()
	first.Config.Concurrency.Group = "review"
	first.Config.Concurrency.CancelInProgress = false
	second := reviewPipeline()
	second.Name = "deep-review"
	second.Config.Name = "deep-review"
	second.Config.Concurrency.Group = "review"
	second.Config.Concurrency.CancelInProgress = false

	if got := admit(t, &table, first, prSubject(412), "run-1"); got.Kind != StartNow {
		t.Fatalf("first admission = %q, want %q", got.Kind, StartNow)
	}
	if got := admit(t, &table, second, prSubject(412), "run-2"); got.Kind != Queued {
		t.Errorf("second admission = %q, want %q", got.Kind, Queued)
	}
}

// cancel-in-progress: true names the in-flight run as the victim and hands the
// key to the newcomer.
func TestAdmitCancelInProgressReturnsVictim(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()

	if got := admit(t, &table, def, prSubject(412), "run-1"); got.Kind != StartNow {
		t.Fatalf("first admission = %q, want %q", got.Kind, StartNow)
	}
	second := admit(t, &table, def, prSubject(412), "run-2")
	if second.Kind != CancelThenStart {
		t.Fatalf("second admission = %q, want %q", second.Kind, CancelThenStart)
	}
	if second.Victim != "run-1" {
		t.Errorf("victim = %q, want %q", second.Victim, "run-1")
	}

	// The newcomer now holds the key, so a third arrival cancels it in turn.
	third := admit(t, &table, def, prSubject(412), "run-3")
	if third.Kind != CancelThenStart || third.Victim != "run-2" {
		t.Errorf("third admission = %q victim %q, want %q victim %q", third.Kind, third.Victim, CancelThenStart, "run-2")
	}
}

// Queue depth is 1: a third arrival evicts the queued trigger instead of
// stacking behind it.
func TestAdmitThirdArrivalEvictsQueued(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()
	def.Config.Concurrency.CancelInProgress = false
	subject := prSubject(412)
	key := keyFor(def, subject)

	admit(t, &table, def, subject, "run-1")
	admit(t, &table, def, subject, "run-2")
	if got := admit(t, &table, def, subject, "run-3"); got.Kind != Queued {
		t.Fatalf("third admission = %q, want %q", got.Kind, Queued)
	}

	next, ok := table.Release(key, "run-1")
	if !ok {
		t.Fatal("Release returned no queued trigger, want the newest one")
	}
	if next.RunID != "run-3" {
		t.Errorf("queued run = %q, want the newest arrival %q", next.RunID, "run-3")
	}
}

// Release hands the queued trigger back so the caller can start it, and the
// released run stops holding the key.
func TestReleaseStartsQueuedTrigger(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()
	def.Config.Concurrency.CancelInProgress = false
	subject := prSubject(412)
	key := keyFor(def, subject)

	admit(t, &table, def, subject, "run-1")
	admit(t, &table, def, subject, "run-2")

	next, ok := table.Release(key, "run-1")
	if !ok {
		t.Fatal("Release returned no queued trigger, want run-2")
	}
	if next.RunID != "run-2" || next.Definition.ID != def.ID {
		t.Errorf("queued trigger = %+v, want run-2 on %q", next, def.ID)
	}

	// run-2 now holds the key, and nothing is queued behind it.
	if got := admit(t, &table, def, subject, "run-3"); got.Kind != Queued {
		t.Errorf("admission after release = %q, want %q", got.Kind, Queued)
	}
	if _, ok := table.Release(key, "run-2"); !ok {
		t.Error("Release after re-queue returned nothing, want run-3")
	}
	if _, ok := table.Release(key, "run-3"); ok {
		t.Error("Release on an empty queue returned a trigger, want none")
	}
}

// A settling run that no longer holds the key must not evict the run that
// replaced it. This is the normal cancel-in-progress path: the victim settles
// after its replacement already started.
func TestReleaseByStaleRunIsIgnored(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()
	subject := prSubject(412)
	key := keyFor(def, subject)

	admit(t, &table, def, subject, "run-1")
	if got := admit(t, &table, def, subject, "run-2"); got.Kind != CancelThenStart {
		t.Fatalf("second admission = %q, want %q", got.Kind, CancelThenStart)
	}

	if _, ok := table.Release(key, "run-1"); ok {
		t.Error("stale Release returned a trigger, want none")
	}

	// run-2 still holds the key.
	third := admit(t, &table, def, subject, "run-3")
	if third.Kind != CancelThenStart || third.Victim != "run-2" {
		t.Errorf("third admission = %q victim %q, want %q victim %q", third.Kind, third.Victim, CancelThenStart, "run-2")
	}
}

// A trigger already waiting keeps its place when a cancel-in-progress arrival
// takes over the key: cancel-in-progress targets the in-flight run only.
func TestAdmitCancelInProgressKeepsQueuedTrigger(t *testing.T) {
	var table ConcurrencyTable
	patient := reviewPipeline()
	patient.Config.Concurrency.CancelInProgress = false
	impatient := reviewPipeline()
	subject := prSubject(412)
	key := keyFor(patient, subject)

	admit(t, &table, patient, subject, "run-1")
	admit(t, &table, patient, subject, "run-2")
	if got := admit(t, &table, impatient, subject, "run-3"); got.Kind != CancelThenStart {
		t.Fatalf("cancelling admission = %q, want %q", got.Kind, CancelThenStart)
	}

	next, ok := table.Release(key, "run-3")
	if !ok || next.RunID != "run-2" {
		t.Errorf("Release = %q ok=%v, want the still-queued %q", next.RunID, ok, "run-2")
	}
}

// The spec section 11 release pipeline: scope: project on a pr.merged trigger,
// so two merges on different PRs serialize instead of releasing concurrently.
func TestAdmitProjectScopeSerializesAcrossPRs(t *testing.T) {
	var table ConcurrencyTable
	def := releasePipeline()

	if got := admit(t, &table, def, prSubject(412), "run-1"); got.Kind != StartNow {
		t.Fatalf("first merge admission = %q, want %q", got.Kind, StartNow)
	}
	second := admit(t, &table, def, prSubject(998), "run-2")
	if second.Kind != Queued {
		t.Errorf("second merge admission = %q, want %q", second.Kind, Queued)
	}
	if second.Victim != "" {
		t.Errorf("cancel-in-progress is false, but admission named victim %q", second.Victim)
	}
}

// A subject with no identity at the requested scope is ungrouped and
// serializes against nothing (see Subject.ScopeIdentity).
func TestAdmitUngroupedKeyNeverSerializes(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()
	def.Config.Concurrency.Scope = pipeline.ConcurrencyScopePR
	project := pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj"}
	key := keyFor(def, project)

	if key.ScopeIdentity != "" {
		t.Fatalf("scope identity = %q, want empty for a project subject at pr scope", key.ScopeIdentity)
	}
	for _, runID := range []pipeline.RunID{"run-1", "run-2", "run-3"} {
		if got := admit(t, &table, def, project, runID); got.Kind != StartNow {
			t.Errorf("admission for %q = %q, want %q", runID, got.Kind, StartNow)
		}
	}
	if _, ok := table.Release(key, "run-1"); ok {
		t.Error("Release on an ungrouped key returned a trigger, want none")
	}
}

// The supervisor calls the table from more than one goroutine, so the whole
// surface has to be race free. Run with -race.
func TestConcurrentAdmitAndRelease(t *testing.T) {
	var table ConcurrencyTable
	def := reviewPipeline()

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			subject := prSubject(400 + i%4)
			key := keyFor(def, subject)
			table.Admit(key, true, trigger(def, subject, pipeline.RunID("run")))
			table.Release(key, "run")
		}(i)
	}
	wg.Wait()
}
