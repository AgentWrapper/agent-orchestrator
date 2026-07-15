package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// pipelineCapture records the method, path, raw query, and body of the last
// request the CLI made to the fake daemon.
type pipelineCapture struct {
	method string
	path   string
	query  string
	body   string
}

// pipelineServer stands up a fake daemon that replies to any request with the
// given status/body and records what the CLI sent. A single canned response is
// enough for the per-command happy-path and error tests.
func pipelineServer(t *testing.T, status int, respBody string) (*httptest.Server, *pipelineCapture) {
	t.Helper()
	capture := &pipelineCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		capture.method = r.Method
		capture.path = r.URL.Path
		capture.query = r.URL.RawQuery
		capture.body = string(body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestPipelineList_Human(t *testing.T) {
	cfg := setConfigEnv(t)
	body := `{"definitions":[{"id":"pl-1","projectId":"proj","name":"review","yamlSource":"name: review\nstages:\n  - name: a\n    trigger: {on: [manual]}\n  - name: b\n    trigger: {on: [manual]}\n","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T01:00:00Z"}]}`
	srv, capture := pipelineServer(t, http.StatusOK, body)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "list", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/pipelines" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q, want project=proj", capture.query)
	}
	if !strings.Contains(out, "Pipelines for proj:") || !strings.Contains(out, "pl-1") ||
		!strings.Contains(out, "review") || !strings.Contains(out, "2 stages") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineList_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	body := `{"definitions":[{"id":"pl-1","projectId":"proj","name":"review","yamlSource":"name: review\n","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T01:00:00Z"}]}`
	srv, _ := pipelineServer(t, http.StatusOK, body)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "list", "--project", "proj", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var res listPipelineDefinitionsResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not the raw JSON response: %v\nstdout=%s", err, out)
	}
	if len(res.Definitions) != 1 || res.Definitions[0].ID != "pl-1" {
		t.Fatalf("definitions = %+v", res.Definitions)
	}
}

func TestPipelineList_Empty(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, `{"definitions":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "list", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "(no pipelines configured for proj)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineRuns_HumanAndFilters(t *testing.T) {
	cfg := setConfigEnv(t)
	body := `{"runs":[{"runId":"run-1","pipelineName":"review","loopState":"running","createdAt":"2026-07-15T00:00:00Z"},{"runId":"run-2","pipelineName":"review","loopState":"stalled","terminationReason":"retry_exhausted","createdAt":"2026-07-14T00:00:00Z"}]}`
	srv, capture := pipelineServer(t, http.StatusOK, body)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "runs", "--project", "proj", "--pipeline", "review", "--status", "running", "--limit", "5")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/pipelines/runs" {
		t.Fatalf("path = %q", capture.path)
	}
	q := capture.query
	for _, want := range []string{"project=proj", "pipeline=review", "status=running", "limit=5"} {
		if !strings.Contains(q, want) {
			t.Fatalf("query %q missing %q", q, want)
		}
	}
	if !strings.Contains(out, "run-1") || !strings.Contains(out, "running") ||
		!strings.Contains(out, "stalled (retry_exhausted)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineRuns_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, `{"runs":[{"runId":"run-1","pipelineName":"review","loopState":"done"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "runs", "--project", "proj", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var res listPipelineRunsResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not raw JSON: %v\nstdout=%s", err, out)
	}
	if len(res.Runs) != 1 || res.Runs[0].RunID != "run-1" {
		t.Fatalf("runs = %+v", res.Runs)
	}
}

func TestPipelineShow_Human(t *testing.T) {
	cfg := setConfigEnv(t)
	body := `{"run":{"runId":"run-1","pipelineName":"review","sessionId":"sess","loopState":"stalled","terminationReason":"retry_exhausted","loopRounds":2,"headSha":"abc123","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T02:00:00Z","stages":[{"stageName":"lint","stageRunId":"sr-1","status":"failed","attempt":1,"errorMessage":"boom","artifactIds":["a1"]}],"findings":[{"artifactId":"a1","kind":"finding","stageName":"lint","title":"bad import","filePath":"x.go","severity":"high","status":"open"}]}}`
	srv, capture := pipelineServer(t, http.StatusOK, body)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "show", "run-1")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/pipelines/runs/run-1" {
		t.Fatalf("path = %q", capture.path)
	}
	for _, want := range []string{"Run run-1", "pipeline:", "review", "state:", "stalled",
		"lint", "failed", "attempt=1", "artifacts=1", "error: boom", "Findings: 1 open, 1 total", "bad import"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout missing %q\nstdout=%s", want, out)
		}
	}
}

func TestPipelineShow_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, `{"run":{"runId":"run-1","pipelineName":"review","loopState":"done","stages":[],"findings":[]}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "show", "run-1", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var res pipelineRunDetailResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not raw JSON: %v\nstdout=%s", err, out)
	}
	if res.Run.RunID != "run-1" {
		t.Fatalf("run = %+v", res.Run)
	}
}

func TestPipelineShow_RunNotFound(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusNotFound, `{"message":"no pipeline run \"run-x\"","code":"PIPELINE_RUN_NOT_FOUND"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "show", "run-x")
	if err == nil {
		t.Fatal("expected error for 404 run")
	}
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1; err=%v", got, err)
	}
	if !strings.Contains(err.Error(), "PIPELINE_RUN_NOT_FOUND") {
		t.Fatalf("error = %v (stderr=%s)", err, errOut)
	}
}

func TestPipelineRun_Human(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusCreated, `{"runId":"run-9"}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "run", "review", "--project", "proj", "--session", "sess", "--head-sha", "deadbeef")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/pipelines/runs" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q", capture.query)
	}
	var reqBody map[string]string
	if err := json.Unmarshal([]byte(capture.body), &reqBody); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if reqBody["pipeline"] != "review" || reqBody["sessionId"] != "sess" || reqBody["headSha"] != "deadbeef" {
		t.Fatalf("body = %+v", reqBody)
	}
	if !strings.Contains(out, "run-9") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineRun_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusCreated, `{"runId":"run-9"}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "run", "review", "--project", "proj", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var res triggerPipelineRunResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not raw JSON: %v\nstdout=%s", err, out)
	}
	if res.RunID != "run-9" {
		t.Fatalf("runId = %q", res.RunID)
	}
}

func TestPipelineRun_PipelineNotFound(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusNotFound, `{"message":"no pipeline definition \"nope\" in this project","code":"PIPELINE_NOT_FOUND"}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "run", "nope", "--project", "proj")
	if err == nil {
		t.Fatal("expected error for 404 pipeline")
	}
	if !strings.Contains(err.Error(), "PIPELINE_NOT_FOUND") {
		t.Fatalf("error = %v", err)
	}
}

func TestPipelineCancel_Human(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{"run":{"runId":"run-1","loopState":"terminated","terminationReason":"manual_cancel"}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "cancel", "run-1", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/pipelines/runs/run-1/cancel" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q", capture.query)
	}
	if !strings.Contains(out, "run run-1 → terminated (manual_cancel)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineResume_Human(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{"run":{"runId":"run-1","loopState":"running"}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "resume", "run-1", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/pipelines/runs/run-1/resume" {
		t.Fatalf("path = %q", capture.path)
	}
	if !strings.Contains(out, "run run-1 → running") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineShow_MissingRunIDIsUsageError(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "show")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
}

func TestPipelineRun_MissingRefIsUsageError(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "run")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
}
