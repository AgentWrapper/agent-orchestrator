package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
)

// fakePipelineService is a scripted pipelinesvc.Manager. Each field overrides
// the corresponding method's result; zero values yield a sensible default so a
// test only sets what it asserts on.
type fakePipelineService struct {
	definitions []pipeline.Definition
	definition  pipeline.Definition
	runs        []pipeline.RunState
	run         pipeline.RunState
	artifact    pipeline.Artifact
	runID       pipeline.RunID
	schema      []byte

	valid  bool
	issues []pipeline.Issue

	createErr, updateErr, deleteErr error
	listDefErr, listRunErr          error
	getRunErr, cancelErr, resumeErr error
	triggerErr, artifactErr         error
	validateErr                     error

	lastTrigger pipelinesvc.TriggerInput
	lastFilter  pipeline.RunFilter
}

func (f *fakePipelineService) ListDefinitions(context.Context, domain.ProjectID) ([]pipeline.Definition, error) {
	return f.definitions, f.listDefErr
}

func (f *fakePipelineService) CreateDefinition(_ context.Context, _ domain.ProjectID, _ string) (pipeline.Definition, error) {
	if f.createErr != nil {
		return pipeline.Definition{}, f.createErr
	}
	return f.definition, nil
}

func (f *fakePipelineService) UpdateDefinition(_ context.Context, _ pipeline.ID, _ string) (pipeline.Definition, error) {
	if f.updateErr != nil {
		return pipeline.Definition{}, f.updateErr
	}
	return f.definition, nil
}

func (f *fakePipelineService) DeleteDefinition(context.Context, pipeline.ID) error {
	return f.deleteErr
}

func (f *fakePipelineService) ValidateDefinition(_ context.Context, _ string) (bool, []pipeline.Issue, error) {
	return f.valid, f.issues, f.validateErr
}

func (f *fakePipelineService) ConfigSchema() []byte { return f.schema }

func (f *fakePipelineService) ListRuns(_ context.Context, _ domain.ProjectID, filter pipeline.RunFilter) ([]pipeline.RunState, error) {
	f.lastFilter = filter
	return f.runs, f.listRunErr
}

func (f *fakePipelineService) GetRun(context.Context, pipeline.RunID) (pipeline.RunState, error) {
	if f.getRunErr != nil {
		return pipeline.RunState{}, f.getRunErr
	}
	return f.run, nil
}

func (f *fakePipelineService) CancelRun(context.Context, domain.ProjectID, pipeline.RunID) (pipeline.RunState, error) {
	if f.cancelErr != nil {
		return pipeline.RunState{}, f.cancelErr
	}
	return f.run, nil
}

func (f *fakePipelineService) ResumeRun(context.Context, domain.ProjectID, pipeline.RunID) (pipeline.RunState, error) {
	if f.resumeErr != nil {
		return pipeline.RunState{}, f.resumeErr
	}
	return f.run, nil
}

func (f *fakePipelineService) TriggerRun(_ context.Context, _ domain.ProjectID, in pipelinesvc.TriggerInput) (pipeline.RunID, error) {
	f.lastTrigger = in
	if f.triggerErr != nil {
		return "", f.triggerErr
	}
	return f.runID, nil
}

func (f *fakePipelineService) GetArtifact(context.Context, pipeline.ArtifactID) (pipeline.Artifact, error) {
	if f.artifactErr != nil {
		return pipeline.Artifact{}, f.artifactErr
	}
	return f.artifact, nil
}

func (f *fakePipelineService) PRBlocksMerge(context.Context, domain.ProjectID, string, string) (bool, error) {
	return false, nil
}

func newPipelineTestServer(t *testing.T, svc pipelinesvc.Manager) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Pipelines: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func sampleRun() pipeline.RunState {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	return pipeline.RunState{
		RunID:        "run-1",
		PipelineID:   "pl-1",
		PipelineName: "review",
		SessionID:    "mer-1",
		LoopState:    pipeline.LoopRunning,
		LoopRounds:   1,
		HeadSHA:      "sha1",
		BlocksMerge:  true,
		Stages: map[string]pipeline.StageState{
			"review": {StageRunID: "sr-1", Status: pipeline.StageStatusRunning, Attempt: 1, Artifacts: []pipeline.ArtifactID{"a-1"}},
		},
		Findings: []pipeline.Artifact{{
			ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindFinding, Title: "bug"},
			ArtifactID:    "a-1", Status: pipeline.ArtifactStatusOpen, StageName: "review",
		}},
		CreatedAt: now, UpdatedAt: now,
	}
}

// --- definitions ------------------------------------------------------------

func TestPipelinesListDefinitions_HappyAndMissingProject(t *testing.T) {
	def := pipeline.Definition{ID: "pl-1", ProjectID: "mer", Name: "review", YAMLSource: "name: review"}
	srv := newPipelineTestServer(t, &fakePipelineService{definitions: []pipeline.Definition{def}})

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines?project=mer", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s", status, body)
	}
	for _, want := range []string{`"definitions"`, `"pl-1"`, `"name: review"`} {
		if !contains(body, want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}

	body, status, _ = doRequest(t, srv, "GET", "/api/v1/pipelines", "")
	assertErrorCode(t, body, status, http.StatusBadRequest, "PROJECT_REQUIRED")
}

func TestPipelinesCreateDefinition_ValidationFailureListsEveryIssue(t *testing.T) {
	verr := &pipeline.ValidationError{Issues: []pipeline.Issue{
		{Path: "name", Message: "name must not be empty"},
		{Path: "stages", Message: "pipeline must declare at least one stage"},
	}}
	srv := newPipelineTestServer(t, &fakePipelineService{createErr: verr})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines?project=mer", `{"yamlSource":"bad: true"}`)
	assertJSON(t, headers)
	assertErrorCode(t, body, status, http.StatusUnprocessableEntity, "PIPELINE_VALIDATION_FAILED")

	var got errorBody
	mustJSON(t, body, &got)
	issues, ok := got.Details["issues"].([]any)
	if !ok || len(issues) != 2 {
		t.Fatalf("details.issues = %v, want 2 issues", got.Details["issues"])
	}
	for _, want := range []string{"name must not be empty", "pipeline must declare at least one stage"} {
		if !contains(body, want) {
			t.Fatalf("issue list missing %q: %s", want, body)
		}
	}
}

func TestPipelinesCreateDefinition_Happy(t *testing.T) {
	def := pipeline.Definition{ID: "pl-9", ProjectID: "mer", Name: "review", YAMLSource: "name: review"}
	srv := newPipelineTestServer(t, &fakePipelineService{definition: def})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines?project=mer", `{"yamlSource":"name: review"}`)
	assertJSON(t, headers)
	if status != http.StatusCreated {
		t.Fatalf("status = %d body=%s", status, body)
	}
	if !contains(body, `"pl-9"`) || !contains(body, `"definition"`) {
		t.Fatalf("body missing created definition: %s", body)
	}
}

func TestPipelinesUpdateDefinition_NotFound(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{updateErr: apierr.NotFound("PIPELINE_DEFINITION_NOT_FOUND", "no pipeline definition \"pl-x\"")})

	body, status, _ := doRequest(t, srv, "PUT", "/api/v1/pipelines/pl-x", `{"yamlSource":"name: review"}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_DEFINITION_NOT_FOUND")
}

func TestPipelinesDeleteDefinition_HappyAndNotFound(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{})
	body, status, headers := doRequest(t, srv, "DELETE", "/api/v1/pipelines/pl-1", "")
	assertJSON(t, headers)
	if status != http.StatusOK || !contains(body, `"deleted":true`) {
		t.Fatalf("delete happy: status=%d body=%s", status, body)
	}

	srv = newPipelineTestServer(t, &fakePipelineService{deleteErr: apierr.NotFound("PIPELINE_DEFINITION_NOT_FOUND", "gone")})
	body, status, _ = doRequest(t, srv, "DELETE", "/api/v1/pipelines/pl-x", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_DEFINITION_NOT_FOUND")
}

func TestPipelinesValidateDefinition_Valid(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{valid: true})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines/validate", `{"yamlSource":"name: review"}`)
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s", status, body)
	}
	if !contains(body, `"valid":true`) || !contains(body, `"issues":[]`) {
		t.Fatalf("valid body unexpected: %s", body)
	}
}

func TestPipelinesValidateDefinition_InvalidListsEveryIssue(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{valid: false, issues: []pipeline.Issue{
		{Path: "name", Message: "name must not be empty"},
		{Path: "stages", Message: "pipeline must declare at least one stage"},
	}})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines/validate", `{"yamlSource":"bad: true"}`)
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("validation failure must be 200 (data, not error): status=%d body=%s", status, body)
	}
	if !contains(body, `"valid":false`) {
		t.Fatalf("expected valid:false: %s", body)
	}
	for _, want := range []string{"name must not be empty", "pipeline must declare at least one stage", `"path":"stages"`} {
		if !contains(body, want) {
			t.Fatalf("issue list missing %q: %s", want, body)
		}
	}
}

func TestPipelinesValidateDefinition_MalformedBody(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{valid: true})
	body, status, _ := doRequest(t, srv, "POST", "/api/v1/pipelines/validate", `{"yamlSource":`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_JSON")
}

func TestPipelinesSchema(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{schema: []byte(`{"$schema":"x","title":"Pipeline"}`)})
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/schema", "")
	assertJSON(t, headers)
	if status != http.StatusOK || !contains(body, `"title":"Pipeline"`) {
		t.Fatalf("schema: status=%d body=%s", status, body)
	}
}

// --- runs -------------------------------------------------------------------

func TestPipelinesListRuns_HappyPassesFilter(t *testing.T) {
	svc := &fakePipelineService{runs: []pipeline.RunState{sampleRun()}}
	srv := newPipelineTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs?project=mer&pipeline=review&status=running&limit=5", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s", status, body)
	}
	if !contains(body, `"runs"`) || !contains(body, `"run-1"`) || !contains(body, `"hasOpenFindings":true`) || !contains(body, `"blocksMerge":true`) {
		t.Fatalf("body missing run summary: %s", body)
	}
	if svc.lastFilter.PipelineName != "review" || svc.lastFilter.Status != pipeline.LoopRunning || svc.lastFilter.Limit != 5 {
		t.Fatalf("filter not threaded: %+v", svc.lastFilter)
	}
}

func TestPipelinesGetRun_HappyAndNotFound(t *testing.T) {
	srv := newPipelineTestServer(t, &fakePipelineService{run: sampleRun()})
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1", "")
	assertJSON(t, headers)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s", status, body)
	}
	for _, want := range []string{`"run"`, `"stages"`, `"stageName":"review"`, `"findings"`, `"bug"`} {
		if !contains(body, want) {
			t.Fatalf("run detail missing %s: %s", want, body)
		}
	}

	srv = newPipelineTestServer(t, &fakePipelineService{getRunErr: apierr.NotFound("PIPELINE_RUN_NOT_FOUND", "gone")})
	body, status, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-x", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_RUN_NOT_FOUND")
}

func TestPipelinesTriggerRun_HappyAndRefNotFound(t *testing.T) {
	svc := &fakePipelineService{runID: "run-42"}
	srv := newPipelineTestServer(t, svc)

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines/runs?project=mer",
		`{"pipeline":"review","sessionId":"mer-1","headSha":"sha1"}`)
	assertJSON(t, headers)
	if status != http.StatusCreated || !contains(body, `"runId":"run-42"`) {
		t.Fatalf("trigger happy: status=%d body=%s", status, body)
	}
	if svc.lastTrigger.Ref != "review" || svc.lastTrigger.SessionID != "mer-1" || svc.lastTrigger.HeadSHA != "sha1" {
		t.Fatalf("trigger input not threaded: %+v", svc.lastTrigger)
	}

	srv = newPipelineTestServer(t, &fakePipelineService{triggerErr: apierr.NotFound("PIPELINE_NOT_FOUND", "no such pipeline")})
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/pipelines/runs?project=mer", `{"pipeline":"nope"}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_NOT_FOUND")
}

func TestPipelinesCancelAndResume_ReturnRunDetail(t *testing.T) {
	run := sampleRun()
	run.LoopState = pipeline.LoopTerminated
	srv := newPipelineTestServer(t, &fakePipelineService{run: run})

	body, status, headers := doRequest(t, srv, "POST", "/api/v1/pipelines/runs/run-1/cancel?project=mer", "")
	assertJSON(t, headers)
	if status != http.StatusOK || !contains(body, `"loopState":"terminated"`) {
		t.Fatalf("cancel: status=%d body=%s", status, body)
	}

	body, status, _ = doRequest(t, srv, "POST", "/api/v1/pipelines/runs/run-1/resume?project=mer", "")
	if status != http.StatusOK || !contains(body, `"run"`) {
		t.Fatalf("resume: status=%d body=%s", status, body)
	}

	// project scoping is enforced.
	body, status, _ = doRequest(t, srv, "POST", "/api/v1/pipelines/runs/run-1/cancel", "")
	assertErrorCode(t, body, status, http.StatusBadRequest, "PROJECT_REQUIRED")
}

func TestPipelinesGetArtifact_HappyAndNotFound(t *testing.T) {
	art := pipeline.Artifact{
		ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindFinding, Title: "leak"},
		ArtifactID:    "a-7", Status: pipeline.ArtifactStatusOpen,
	}
	srv := newPipelineTestServer(t, &fakePipelineService{artifact: art})
	body, status, headers := doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/artifacts/a-7", "")
	assertJSON(t, headers)
	if status != http.StatusOK || !contains(body, `"artifact"`) || !contains(body, `"a-7"`) {
		t.Fatalf("artifact happy: status=%d body=%s", status, body)
	}

	srv = newPipelineTestServer(t, &fakePipelineService{artifactErr: apierr.NotFound("PIPELINE_ARTIFACT_NOT_FOUND", "gone")})
	body, status, _ = doRequest(t, srv, "GET", "/api/v1/pipelines/runs/run-1/artifacts/a-x", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "PIPELINE_ARTIFACT_NOT_FOUND")
}

// TestPipelinesFlagOffReturns501 is the AO_PIPELINES=off contract (T11): the
// daemon passes a nil Pipelines Manager when the flag is off, and every route
// stays registered but returns 501 Not Implemented, across all method kinds.
func TestPipelinesFlagOffReturns501(t *testing.T) {
	srv := newPipelineTestServer(t, nil)

	cases := []struct {
		method, path, body string
	}{
		{"GET", "/api/v1/pipelines?project=mer", ""},
		{"POST", "/api/v1/pipelines?project=mer", `{"yamlSource":"name: review"}`},
		{"POST", "/api/v1/pipelines/validate", `{"yamlSource":"name: review"}`},
		{"PUT", "/api/v1/pipelines/pl-1", `{"yamlSource":"name: review"}`},
		{"DELETE", "/api/v1/pipelines/pl-1", ""},
		{"GET", "/api/v1/pipelines/schema", ""},
		{"GET", "/api/v1/pipelines/runs?project=mer", ""},
		{"GET", "/api/v1/pipelines/runs/run-1", ""},
		{"POST", "/api/v1/pipelines/runs/run-1/cancel", ""},
		{"POST", "/api/v1/pipelines/runs/run-1/resume", ""},
		{"GET", "/api/v1/pipelines/runs/run-1/artifacts/a-1", ""},
	}
	for _, tc := range cases {
		_, status, _ := doRequest(t, srv, tc.method, tc.path, tc.body)
		if status != http.StatusNotImplemented {
			t.Errorf("%s %s with flag off = %d, want 501", tc.method, tc.path, status)
		}
	}
}

func contains(body []byte, sub string) bool {
	return strings.Contains(string(body), sub)
}
