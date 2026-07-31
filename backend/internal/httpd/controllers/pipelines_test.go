package controllers_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// fakePipelineService records the last signal it was handed and answers with a
// canned error, so the handler's status mapping is what is under test.
//
// The embedded Manager supplies the rest of the interface: those methods are
// not exercised here and panic on a nil embed if a test ever reaches one, which
// is louder than a silent zero value.
type fakePipelineService struct {
	pipelinesvc.Manager

	signalErr error
	got       pipeline.StageSignal
	calls     int
}

func (f *fakePipelineService) PRBlocksMerge(context.Context, domain.ProjectID, string, string) (bool, error) {
	return false, nil
}

func (f *fakePipelineService) SignalStage(_ context.Context, runID pipeline.RunID, stageID string, kind pipeline.SignalKind, reason string) error {
	f.calls++
	f.got = pipeline.StageSignal{RunID: runID, StageID: stageID, Kind: kind, Reason: reason}
	return f.signalErr
}

func newPipelineTestServer(t *testing.T, svc pipelinesvc.Manager) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Pipelines: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

const signalPath = "/api/v1/pipelines/runs/run-1/stages/review/signal"

func TestPipelineSignal_NilServiceReturns501(t *testing.T) {
	srv := newPipelineTestServer(t, nil)
	body, status, headers := doRequest(t, srv, "POST", signalPath, `{"status":"done"}`)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func TestPipelineSignal_DoneAccepted(t *testing.T) {
	svc := &fakePipelineService{}
	srv := newPipelineTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", signalPath, `{"status":"done"}`)
	assertJSON(t, headers)
	if status != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", status, body)
	}
	var res struct {
		Accepted bool `json:"accepted"`
	}
	mustJSON(t, body, &res)
	if !res.Accepted {
		t.Fatalf("body = %s", body)
	}
	if svc.got.RunID != "run-1" || svc.got.StageID != "review" || svc.got.Kind != pipeline.SignalDone {
		t.Fatalf("signal = %+v", svc.got)
	}
}

func TestPipelineSignal_FailCarriesReason(t *testing.T) {
	svc := &fakePipelineService{}
	srv := newPipelineTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", signalPath, `{"status":"fail","reason":"upstream API is down"}`)
	if status != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", status, body)
	}
	if svc.got.Kind != pipeline.SignalFail || svc.got.Reason != "upstream API is down" {
		t.Fatalf("signal = %+v", svc.got)
	}
}

func TestPipelineSignal_ErrorMapping(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"unknown run", fmt.Errorf("%w: run-1", pipelinesvc.ErrRunNotFound), http.StatusNotFound, "PIPELINE_RUN_NOT_FOUND"},
		{"unknown stage", fmt.Errorf("%w: run-1/review", pipelinesvc.ErrStageNotFound), http.StatusNotFound, "PIPELINE_STAGE_NOT_FOUND"},
		{"stage not running", fmt.Errorf("%w: run-1/review is succeeded", pipelinesvc.ErrStageNotRunning), http.StatusConflict, "PIPELINE_STAGE_NOT_RUNNING"},
		{"store unavailable", pipelinesvc.ErrStoreUnavailable, http.StatusInternalServerError, "PIPELINE_SIGNAL_FAILED"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := newPipelineTestServer(t, &fakePipelineService{signalErr: tc.err})
			body, status, headers := doRequest(t, srv, "POST", signalPath, `{"status":"done"}`)
			assertJSON(t, headers)
			assertErrorCode(t, body, status, tc.wantStatus, tc.wantCode)
		})
	}
}

func TestPipelineSignal_BadRequests(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantCode string
	}{
		{"unknown status", `{"status":"maybe"}`, "INVALID_SIGNAL_STATUS"},
		{"missing status", `{}`, "INVALID_SIGNAL_STATUS"},
		{"malformed json", `{"status":`, "INVALID_JSON"},
		{"empty body", ``, "INVALID_JSON"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakePipelineService{}
			srv := newPipelineTestServer(t, svc)
			body, status, headers := doRequest(t, srv, "POST", signalPath, tc.body)
			assertJSON(t, headers)
			assertErrorCode(t, body, status, http.StatusBadRequest, tc.wantCode)
			if svc.calls != 0 {
				t.Fatalf("service was called %d times for a rejected body", svc.calls)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// The v2 surface, driven end to end through a real service over a real store
// and a real run folder. The outputs endpoint is a file server pointed at a
// caller-supplied name, so nothing short of the real filesystem tests it.
// ---------------------------------------------------------------------------

const runFixtureYAML = `name: review
stages:
  - id: review
    executor: agent
    agent: claude
    prompt: review the diff
    produces: review.md
    on_success: publish
    on_failure: notify
  - id: publish
    executor: command
    run: make publish
  - id: notify
    executor: command
    run: make notify
`

// nothingResolver is a credential store that declares nothing, which is exactly
// the state a user is in the moment they click a starter template.
type nothingResolver struct{}

func (nothingResolver) Resolve(context.Context, string, []string) (map[string]string, error) {
	return nil, nil
}
func (nothingResolver) Exists(context.Context, string, string) (bool, error) { return false, nil }

// newPipelineV2Server wires the real service over a real store, seeds one run
// with a run folder on disk, and returns the server plus that folder.
func newPipelineV2Server(t *testing.T) (*httptest.Server, pipeline.RunFolder) {
	t.Helper()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "proj", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	folder, err := pipeline.CreateRunFolder(t.TempDir(), "proj", "run-1", []byte(runFixtureYAML))
	if err != nil {
		t.Fatalf("create run folder: %v", err)
	}
	def, err := pipeline.ParseDefinition([]byte(runFixtureYAML))
	if err != nil {
		t.Fatalf("parse definition: %v", err)
	}

	run := pipeline.RunState{
		RunID:        "run-1",
		ProjectID:    "proj",
		PipelineID:   "pl-1",
		PipelineName: "review",
		Subject: pipeline.Subject{
			Kind:      pipeline.SubjectPR,
			ProjectID: "proj",
			SessionID: "sess-1",
			PR:        &pipeline.PRRef{Number: 412, Repo: "acme/app", HeadSHA: "deadbeef"},
		},
		Status: pipeline.RunFailed,
		RunDir: folder.Dir,
		Def:    *def,
		Stages: map[string]*pipeline.StageState{
			"review": {
				ID: "review", Outcome: pipeline.OutcomeNoOutput, Attempt: 2,
				EnteredVia: pipeline.EntryTrigger, SessionID: "sess-9",
				WorkspaceKind: pipeline.WorkspaceSession,
				StartedAt:     now, SettledAt: now.Add(time.Minute),
			},
			"notify": {
				ID: "notify", Outcome: pipeline.OutcomeSucceeded, Attempt: 1,
				EnteredVia: pipeline.EntryFailure, FailedStage: "review",
				OutputTail: "notified\n",
				StartedAt:  now.Add(time.Minute), SettledAt: now.Add(2 * time.Minute),
			},
			"publish": {ID: "publish", Outcome: pipeline.OutcomeSkipped},
		},
		CreatedAt: now,
		UpdatedAt: now.Add(2 * time.Minute),
		SettledAt: now.Add(2 * time.Minute),
	}
	if err := store.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("seed run: %v", err)
	}

	svc := pipelinesvc.New(store, pipelinesvc.WithCredentials(nothingResolver{}))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Pipelines: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv, folder
}

func TestPipelineRuns_ListDTOShape(t *testing.T) {
	srv, _ := newPipelineV2Server(t)

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs?project=proj", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res struct {
		Runs []controllers.PipelineRunSummary `json:"runs"`
	}
	mustJSON(t, body, &res)
	if len(res.Runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(res.Runs))
	}
	got := res.Runs[0]
	if got.RunID != "run-1" || got.Status != "failed" || got.SubjectKind != "pr" {
		t.Fatalf("summary = %+v", got)
	}
	if got.PRNumber != 412 || got.HeadSHA != "deadbeef" || got.SessionID != "sess-1" {
		t.Fatalf("subject fields = %+v", got)
	}
	// The run number the store allocated, carried through to the list row that
	// renders it. It is the first run of "review" in this project, so #1.
	if got.RunNumber != 1 {
		t.Fatalf("runNumber = %d, want 1", got.RunNumber)
	}
	if !strings.Contains(string(body), `"runNumber":1`) {
		t.Errorf("runNumber missing from the wire: %s", body)
	}
	if got.StageCount != 3 || got.StageOutcomes["review"] != "no_output" || got.StageOutcomes["publish"] != "skipped" {
		t.Fatalf("stage rollup = %+v", got)
	}
	if got.SettledAt == nil {
		t.Fatal("settledAt is nil for a settled run")
	}
	// The v1 fields are gone from the wire, not merely unused.
	for _, dead := range []string{"loopState", "loopRounds", "hasOpenFindings", "blocksMerge", "stageStatuses"} {
		if strings.Contains(string(body), `"`+dead+`"`) {
			t.Errorf("v1 field %q still on the wire", dead)
		}
	}
}

func TestPipelineRuns_DetailDTOShape(t *testing.T) {
	srv, folder := newPipelineV2Server(t)
	// review declared review.md and settled no_output, so the artifact is named
	// but absent: that is the missing-artifact state run detail renders.
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res struct {
		Run controllers.PipelineRunDetail `json:"run"`
	}
	mustJSON(t, body, &res)

	// Document order, not map order.
	var ids []string
	for _, s := range res.Run.Stages {
		ids = append(ids, s.StageID)
	}
	if want := []string{"review", "publish", "notify"}; !slices.Equal(ids, want) {
		t.Fatalf("stage order = %v, want %v", ids, want)
	}
	if res.Run.RunDir != folder.Dir {
		t.Errorf("runDir = %q, want %q", res.Run.RunDir, folder.Dir)
	}
	// Detail inherits the summary, so the run number the header shows comes
	// from the same field the list row reads.
	if res.Run.RunNumber != 1 {
		t.Errorf("runNumber = %d, want 1", res.Run.RunNumber)
	}

	review := res.Run.Stages[0]
	if review.Outcome != "no_output" || review.Attempt != 2 || review.EnteredVia != "trigger" {
		t.Fatalf("review = %+v", review)
	}
	if review.SessionID != "sess-9" || review.WorkspaceKind != "session" {
		t.Fatalf("review session/workspace = %+v", review)
	}
	if review.ProducedArtifact == nil || review.ProducedArtifact.Name != "review.md" || review.ProducedArtifact.Exists {
		t.Fatalf("producedArtifact = %+v, want review.md absent", review.ProducedArtifact)
	}
	if review.StartedAt == nil || review.SettledAt == nil {
		t.Fatal("review is settled but carries no timestamps")
	}

	notify := res.Run.Stages[2]
	if notify.EnteredVia != "failure" || notify.FailedStage != "review" || notify.OutputTail != "notified\n" {
		t.Fatalf("notify = %+v", notify)
	}
	// A command stage declares no produces, so it has no artifact block at all.
	if notify.ProducedArtifact != nil {
		t.Fatalf("notify.producedArtifact = %+v, want nil", notify.ProducedArtifact)
	}
	if strings.Contains(string(body), `"findings"`) {
		t.Error("the deleted findings array is still on the wire")
	}

	// Write the artifact and the same stage now reports it present.
	if err := os.WriteFile(folder.OutputPath(res2Stage(t, folder)), []byte("# findings\n"), 0o600); err != nil {
		t.Fatalf("write artifact: %v", err)
	}
	body, _, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1", "")
	mustJSON(t, body, &res)
	if !res.Run.Stages[0].ProducedArtifact.Exists {
		t.Fatal("producedArtifact.exists stayed false after the file was written")
	}
}

// res2Stage is the review stage of the fixture definition, for OutputPath.
func res2Stage(t *testing.T, _ pipeline.RunFolder) *pipeline.Stage {
	t.Helper()
	def, err := pipeline.ParseDefinition([]byte(runFixtureYAML))
	if err != nil {
		t.Fatalf("parse definition: %v", err)
	}
	return def.StageByID("review")
}

func TestPipelineRuns_DetailUnknownRunIs404(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-nope", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_RUN_NOT_FOUND")
}

// ---------------------------------------------------------------------------
// Stage log
// ---------------------------------------------------------------------------

func TestPipelineStageLog_TailsTheLog(t *testing.T) {
	srv, folder := newPipelineV2Server(t)
	if err := os.WriteFile(folder.LogPath("notify"), []byte("one\ntwo\nthree\n"), 0o600); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/stages/notify/log", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res controllers.PipelineStageLogResponse
	mustJSON(t, body, &res)
	if res.RunID != "run-1" || res.StageID != "notify" || res.Content != "one\ntwo\nthree\n" || res.Truncated {
		t.Fatalf("whole log = %+v", res)
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/stages/notify/log?tail=2", "")
	if status != http.StatusOK {
		t.Fatalf("tail status = %d, want 200; body=%s", status, body)
	}
	mustJSON(t, body, &res)
	if res.Content != "two\nthree\n" || !res.Truncated {
		t.Fatalf("tail = %+v", res)
	}
}

func TestPipelineStageLog_Rejections(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantCode   string
	}{
		{"unknown run", "/api/v1/pipelines/runs/run-nope/stages/notify/log", http.StatusNotFound, "PIPELINE_RUN_NOT_FOUND"},
		{"unknown stage", "/api/v1/pipelines/runs/run-1/stages/nope/log", http.StatusNotFound, "PIPELINE_STAGE_NOT_FOUND"},
		{"no log yet", "/api/v1/pipelines/runs/run-1/stages/notify/log", http.StatusNotFound, "PIPELINE_STAGE_LOG_NOT_FOUND"},
		{"negative tail", "/api/v1/pipelines/runs/run-1/stages/notify/log?tail=-3", http.StatusBadRequest, "INVALID_TAIL"},
		{"non-numeric tail", "/api/v1/pipelines/runs/run-1/stages/notify/log?tail=all", http.StatusBadRequest, "INVALID_TAIL"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, status, headers := doRequest(t, srv, "GET", tc.path, "")
			assertJSON(t, headers)
			assertErrorCode(t, body, status, tc.wantStatus, tc.wantCode)
		})
	}
}

// ---------------------------------------------------------------------------
// Outputs: adversarial
// ---------------------------------------------------------------------------

func TestPipelineRunOutput_ServesADeclaredArtifact(t *testing.T) {
	srv, folder := newPipelineV2Server(t)
	if err := os.WriteFile(filepath.Join(folder.Dir, "agent-outputs", "review.md"), []byte("# findings\n"), 0o600); err != nil {
		t.Fatalf("seed artifact: %v", err)
	}

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/outputs/review.md", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if string(body) != "# findings\n" {
		t.Fatalf("body = %q", body)
	}
	if got := headers.Get("Content-Disposition"); !strings.Contains(got, "review.md") {
		t.Errorf("Content-Disposition = %q", got)
	}
	// Agent-authored bytes must never render inline as HTML.
	if got := headers.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := headers.Get("Content-Type"); !strings.HasPrefix(got, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain", got)
	}
}

// The endpoint is a file server pointed at a caller-supplied name. Every one of
// these must be a 404 with no bytes of the target: traversal (raw and encoded),
// absolute paths, and files that exist in the run folder but are not declared.
func TestPipelineRunOutput_RejectsTraversalAbsoluteAndUndeclared(t *testing.T) {
	srv, folder := newPipelineV2Server(t)
	if err := os.WriteFile(filepath.Join(folder.Dir, "agent-outputs", "review.md"), []byte("# findings\n"), 0o600); err != nil {
		t.Fatalf("seed artifact: %v", err)
	}
	// Real, readable files just outside the allowlist so a leak is observable.
	if err := os.WriteFile(filepath.Join(folder.Dir, "secret.txt"), []byte("SENSITIVE"), 0o600); err != nil {
		t.Fatalf("seed secret: %v", err)
	}

	for _, raw := range []string{
		"%2e%2e",
		"%2e%2e%2fsecret.txt",
		"%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
		"..%252fsecret.txt",
		"%2fetc%2fpasswd",
		"..%5c..%5csecret.txt",
		"secret.txt",
		"run.json",
		"definition.yaml",
		"review.md%00.png",
		"Review.md",
		"review.md%20",
		"%2e%2freview.md",
	} {
		t.Run(raw, func(t *testing.T) {
			body, status, _ := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/outputs/"+raw, "")
			if status == http.StatusOK {
				t.Fatalf("served %q with 200: %q", raw, body)
			}
			for _, leak := range []string{"SENSITIVE", "root:", "# findings"} {
				if strings.Contains(string(body), leak) {
					t.Fatalf("response for %q leaked %q: %s", raw, leak, body)
				}
			}
		})
	}
}

func TestPipelineRunOutput_DeclaredButNotWrittenIs404(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/outputs/review.md", "")
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_OUTPUT_NOT_FOUND")
}

// A symlink planted under the declared name is the one way a declared filename
// could still resolve outside the run folder.
func TestPipelineRunOutput_RejectsASymlinkEscape(t *testing.T) {
	srv, folder := newPipelineV2Server(t)
	outside := filepath.Join(t.TempDir(), "id_rsa")
	if err := os.WriteFile(outside, []byte("PRIVATE KEY"), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(folder.Dir, "agent-outputs", "review.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/outputs/review.md", "")
	if status == http.StatusOK || strings.Contains(string(body), "PRIVATE KEY") {
		t.Fatalf("symlink served: status=%d body=%s", status, body)
	}
}

// ---------------------------------------------------------------------------
// Validate: warnings are their own array
// ---------------------------------------------------------------------------

func TestPipelineValidate_WarningsAreSeparateFromIssues(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	// Two stages, no failure route anywhere: valid, but warned (spec 13).
	yaml := "name: two\nstages:\n  - id: a\n    executor: command\n    run: make a\n    on_success: b\n  - id: b\n    executor: command\n    run: make b\n"

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines/validate?project=proj",
		`{"yamlSource":`+strconv.Quote(yaml)+`}`)
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res controllers.ValidatePipelineDefinitionResponse
	mustJSON(t, body, &res)
	if !res.Valid {
		t.Fatalf("valid = false for a warned-but-legal pipeline: %+v", res)
	}
	if len(res.Issues) != 0 {
		t.Fatalf("issues = %+v, want none", res.Issues)
	}
	if len(res.Warnings) == 0 {
		t.Fatalf("warnings = none, want the missing-failure-route warning; body=%s", body)
	}
}

func TestPipelineValidate_IssuesAndWarningsCoexist(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	// Same missing-failure-route warning, plus an unknown on_success target.
	yaml := "name: two\nstages:\n  - id: a\n    executor: command\n    run: make a\n    on_success: nope\n  - id: b\n    executor: command\n    run: make b\n"

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/pipelines/validate?project=proj",
		`{"yamlSource":`+strconv.Quote(yaml)+`}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res controllers.ValidatePipelineDefinitionResponse
	mustJSON(t, body, &res)
	if res.Valid || len(res.Issues) == 0 {
		t.Fatalf("expected issues on an invalid document: %+v", res)
	}
	if len(res.Warnings) == 0 {
		t.Fatalf("warnings were dropped because the document was invalid; body=%s", body)
	}
}

// ---------------------------------------------------------------------------
// Unknown credential: the first thing a user sees after clicking a template
// ---------------------------------------------------------------------------

func TestPipelineValidate_UnknownCredentialNamesTheFixingCommand(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	yaml := "name: gate\nstages:\n  - id: publish\n    executor: command\n    run: gh release create\n    credentials: [github-release]\n"

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/pipelines/validate?project=proj",
		`{"yamlSource":`+strconv.Quote(yaml)+`}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res controllers.ValidatePipelineDefinitionResponse
	mustJSON(t, body, &res)
	if res.Valid || len(res.Issues) != 1 {
		t.Fatalf("res = %+v, want exactly one issue", res)
	}
	assertActionableCredentialMessage(t, res.Issues[0].Message)
	if res.Issues[0].Path != "stages[0].credentials[0]" {
		t.Errorf("path = %q, want stages[0].credentials[0]", res.Issues[0].Path)
	}
}

// The save path runs the same check, so clicking a template and hitting save
// gets the same actionable message rather than a bare rejection.
func TestPipelineCreate_UnknownCredentialNamesTheFixingCommand(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	yaml := "name: gate\nstages:\n  - id: publish\n    executor: command\n    run: gh release create\n    credentials: [github-release]\n"

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines?project=proj",
		`{"yamlSource":`+strconv.Quote(yaml)+`}`)
	assertJSON(t, headers)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", status, body)
	}
	assertActionableCredentialMessage(t, string(body))
}

func assertActionableCredentialMessage(t *testing.T, msg string) {
	t.Helper()
	for _, want := range []string{
		`unknown credential`,
		`github-release`,
		"ao pipeline credential set github-release",
		"--project proj",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q is missing %q", msg, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Flag off: every route, including the new ones, answers the locked 501
// ---------------------------------------------------------------------------

func TestPipelineRoutes_NilServiceReturns501(t *testing.T) {
	srv := newPipelineTestServer(t, nil)
	tests := []struct{ method, path, body string }{
		{"GET", "/api/v1/pipelines?project=proj", ""},
		{"POST", "/api/v1/pipelines?project=proj", `{"yamlSource":"name: x"}`},
		{"PUT", "/api/v1/pipelines/pl-1", `{"yamlSource":"name: x"}`},
		{"DELETE", "/api/v1/pipelines/pl-1", ""},
		{"POST", "/api/v1/pipelines/validate?project=proj", `{"yamlSource":"name: x"}`},
		{"GET", "/api/v1/pipelines/schema", ""},
		{"GET", "/api/v1/pipelines/credentials?project=proj", ""},
		{"PUT", "/api/v1/pipelines/credentials/npm?project=proj", `{"env":{"A":"1"}}`},
		{"DELETE", "/api/v1/pipelines/credentials/npm?project=proj", ""},
		{"GET", "/api/v1/pipelines/runs?project=proj", ""},
		{"POST", "/api/v1/pipelines/runs?project=proj", `{"pipeline":"review"}`},
		{"GET", "/api/v1/pipelines/runs/run-1", ""},
		{"POST", "/api/v1/pipelines/runs/run-1/cancel?project=proj", ""},
		{"POST", signalPath, `{"status":"done"}`},
		{"GET", "/api/v1/pipelines/runs/run-1/stages/review/log", ""},
		{"GET", "/api/v1/pipelines/runs/run-1/outputs/review.md", ""},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			body, status, headers := doRequest(t, srv, tc.method, tc.path, tc.body)
			assertJSON(t, headers)
			assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
		})
	}
}

// The two v1 routes v2 deletes are gone from the router, not merely 501.
func TestPipelineRoutes_ResumeAndArtifactsAreGone(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	for _, tc := range []struct{ method, path string }{
		{"POST", "/api/v1/pipelines/runs/run-1/resume?project=proj"},
		{"GET", "/api/v1/pipelines/runs/run-1/artifacts/art-1"},
		{"POST", "/api/v1/pipelines/runs/run-1/artifacts/art-1/status?project=proj"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			_, status, _ := doRequest(t, srv, tc.method, tc.path, `{}`)
			if status != http.StatusNotFound && status != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, want the route to be unmounted", status)
			}
		})
	}
}

// Decision D13: a credential's value is write-only. It goes in through the set
// route and comes out only inside a command stage's process env, so no response
// body on these routes may carry one.
func TestPipelineCredentials_SetListDelete_NeverEchoValues(t *testing.T) {
	srv, _ := newPipelineV2Server(t)
	const secret = "s3cret-value"

	body, status, headers := doRequest(t, srv, "PUT", "/api/v1/pipelines/credentials/npm?project=proj",
		`{"env":{"NPM_TOKEN":"`+secret+`","NPM_SCOPE":"@ao"}}`)
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if strings.Contains(string(body), secret) {
		t.Fatalf("set response echoed the value: %s", body)
	}
	var set controllers.PipelineCredentialResponse
	mustJSON(t, body, &set)
	if set.Name != "npm" || !slices.Equal(set.Keys, []string{"NPM_SCOPE", "NPM_TOKEN"}) {
		t.Fatalf("set response = %+v", set)
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/credentials?project=proj", "")
	if status != http.StatusOK {
		t.Fatalf("list status = %d; body=%s", status, body)
	}
	if strings.Contains(string(body), secret) {
		t.Fatalf("list response echoed the value: %s", body)
	}
	var list controllers.ListPipelineCredentialsResponse
	mustJSON(t, body, &list)
	if !slices.Equal(list.Names, []string{"npm"}) {
		t.Fatalf("names = %v", list.Names)
	}

	body, status, _ = doRequest(t, srv, "DELETE", "/api/v1/pipelines/credentials/npm?project=proj", "")
	if status != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", status, body)
	}
	body, _, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/credentials?project=proj", "")
	mustJSON(t, body, &list)
	if len(list.Names) != 0 {
		t.Fatalf("names after delete = %v", list.Names)
	}
}

func TestPipelineCredentials_Errors(t *testing.T) {
	srv, _ := newPipelineV2Server(t)

	body, status, _ := doRequest(t, srv, "DELETE", "/api/v1/pipelines/credentials/nope?project=proj", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_CREDENTIAL_NOT_FOUND")

	body, status, _ = doRequest(t, srv, "PUT", "/api/v1/pipelines/credentials/npm?project=proj", `{"env":{}}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "PIPELINE_CREDENTIAL_ENV_REQUIRED")

	body, status, _ = doRequest(t, srv, "PUT", "/api/v1/pipelines/credentials/npm?project=proj", `{"env":{"not a key":"v"}}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "PIPELINE_CREDENTIAL_ENV_INVALID")
	if strings.Contains(string(body), `"v"`) {
		t.Fatalf("rejection echoed the value: %s", body)
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/credentials", "")
	assertErrorCode(t, body, status, http.StatusBadRequest, "PROJECT_REQUIRED")
}
