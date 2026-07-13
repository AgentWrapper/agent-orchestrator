package controllers_test

import (
	"net/http"
	"testing"
)

// #293 M1: a non-empty but unknown `kind` used to persist and launch, producing
// an agent with no worker/orchestrator standing instructions (buildSystemPrompt
// returns "" for an unknown kind). The HTTP boundary must reject it.
func TestSessionsAPI_SpawnRejectsUnknownKind(t *testing.T) {
	srv := newSessionTestServer(t, newFakeSessionService())

	for _, kind := range []string{"bogus", "Worker", "worker "} {
		body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions",
			`{"projectId":"ao","harness":"codex","kind":"`+kind+`","prompt":"go"}`)
		assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_KIND")
	}
}

// A worker/orchestrator kind (and an omitted kind, which defaults to worker)
// still spawns.
func TestSessionsAPI_SpawnAcceptsKnownKinds(t *testing.T) {
	for _, body := range []string{
		`{"projectId":"ao","harness":"codex","prompt":"go"}`,
		`{"projectId":"ao","harness":"codex","kind":"worker","prompt":"go"}`,
		`{"projectId":"ao","harness":"codex","kind":"orchestrator","prompt":"go"}`,
	} {
		srv := newSessionTestServer(t, newFakeSessionService())
		resp, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions", body)
		if status != http.StatusCreated {
			t.Fatalf("spawn %s = %d, want 201; body=%s", body, status, resp)
		}
	}
}
