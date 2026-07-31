package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// TestPipelineVerbSet pins the v2 surface: resume is gone with the semantics
// behind it, and the credential verbs are here.
func TestPipelineVerbSet(t *testing.T) {
	cmd := newPipelineCommand(&commandContext{})
	got := map[string]bool{}
	for _, sub := range cmd.Commands() {
		got[sub.Name()] = true
	}
	for _, want := range []string{
		"list", "create", "get", "update", "delete", "validate", "schema",
		"runs", "show", "run", "cancel", "credential", "done", "fail",
	} {
		if !got[want] {
			t.Errorf("verb %q is missing", want)
		}
	}
	if got["resume"] {
		t.Error("resume is still registered: v2 has no resume, a failed run is dead")
	}

	credentialVerbs := map[string]bool{}
	for _, sub := range cmd.Commands() {
		if sub.Name() == "credential" {
			for _, verb := range sub.Commands() {
				credentialVerbs[verb.Name()] = true
			}
		}
	}
	for _, want := range []string{"set", "ls", "rm"} {
		if !credentialVerbs[want] {
			t.Errorf("credential verb %q is missing", want)
		}
	}

	// The alias pins: `ao pipelines`, `delete`/`rm`, `get`/`cat`.
	if len(cmd.Aliases) != 1 || cmd.Aliases[0] != "pipelines" {
		t.Errorf("root aliases = %v, want [pipelines]", cmd.Aliases)
	}
	wantAliases := map[string]string{"delete": "rm", "get": "cat"}
	for _, sub := range cmd.Commands() {
		want, ok := wantAliases[sub.Name()]
		if !ok {
			continue
		}
		if len(sub.Aliases) != 1 || sub.Aliases[0] != want {
			t.Errorf("%s aliases = %v, want [%s]", sub.Name(), sub.Aliases, want)
		}
	}
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
	body := `{"runs":[` +
		`{"runId":"run-1","pipelineName":"review","runNumber":8,"status":"running","subjectKind":"session","sessionId":"sess-7","stageCount":3,"createdAt":"2026-07-15T00:00:00Z"},` +
		`{"runId":"run-2","pipelineName":"review","runNumber":7,"status":"cancelled","subjectKind":"pr","prNumber":42,"cancelReason":"head moved","stageCount":3,"createdAt":"2026-07-14T00:00:00Z"}]}`
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
	for _, want := range []string{"run-1", "review #8", "review #7", "running", "session sess-7", "cancelled (head moved)", "pr #42"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout missing %q\nstdout=%s", want, out)
		}
	}
}

func TestPipelineRuns_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, `{"runs":[{"runId":"run-1","pipelineName":"review","status":"succeeded"}]}`)
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

// settledRunBody is a settled v2 run with one nudged stage: `review` was idle
// with `produces` declared, got its one nudge (attempt 2), still wrote nothing,
// and settled no_output, which routed the failure edge to `notify`.
const settledRunBody = `{"run":{"runId":"run-1","pipelineId":"pl-1","pipelineName":"review","runNumber":7,` +
	`"status":"failed","subjectKind":"pr","sessionId":"sess-7","prNumber":42,"headSha":"abc1234",` +
	`"stageCount":3,"stageOutcomes":{"build":"succeeded","review":"no_output","notify":"succeeded"},` +
	`"createdAt":"2026-07-26T12:00:00Z","updatedAt":"2026-07-26T12:30:00Z","settledAt":"2026-07-26T12:30:00Z",` +
	`"runDir":"/data/pipelines/proj/run-1","stages":[` +
	`{"stageId":"build","outcome":"succeeded","attempt":1,"enteredVia":"trigger","workspaceKind":"run",` +
	`"startedAt":"2026-07-26T12:00:00Z","settledAt":"2026-07-26T12:05:00Z"},` +
	`{"stageId":"review","outcome":"no_output","attempt":2,"enteredVia":"success","sessionId":"sess-9",` +
	`"workspaceKind":"stage","startedAt":"2026-07-26T12:05:00Z","settledAt":"2026-07-26T12:25:00Z",` +
	`"reason":"no review.md after the nudge","producedArtifact":{"name":"review.md","exists":false}},` +
	`{"stageId":"notify","outcome":"succeeded","attempt":1,"enteredVia":"failure","failedStage":"review",` +
	`"workspaceKind":"run","startedAt":"2026-07-26T12:25:00Z","settledAt":"2026-07-26T12:30:00Z"}]}}`

// The golden view of a settled run. The attempt column says a stage was nudged
// and the outcome column says it produced nothing, so the two are distinct at a
// glance instead of collapsing into one "failed" line.
const settledRunGolden = `Run review #7
  runId:    run-1
  status:   failed
  subject:  pr #42 abc1234
  session:  sess-7
  runDir:   /data/pipelines/proj/run-1
  created:  2026-07-26T12:00:00Z
  updated:  2026-07-26T12:30:00Z
  settled:  2026-07-26T12:30:00Z

Stages:
  STAGE   OUTCOME    ATTEMPT     VIA              ARTIFACT             REASON
  build   succeeded  1           trigger          -                    -
  review  no_output  2 (nudged)  success          review.md (missing)  no review.md after the nudge
  notify  succeeded  1           failure(review)  -                    -
`

func TestPipelineShow_GoldenSettledRunWithNudgedStage(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, settledRunBody)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "show", "run-1")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/pipelines/runs/run-1" {
		t.Fatalf("path = %q", capture.path)
	}
	if out != settledRunGolden {
		t.Fatalf("stdout mismatch\n--- got ---\n%s\n--- want ---\n%s", out, settledRunGolden)
	}
}

func TestPipelineShow_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, settledRunBody)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "show", "run-1", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var res pipelineRunDetailResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not raw JSON: %v\nstdout=%s", err, out)
	}
	if res.Run.RunID != "run-1" || len(res.Run.Stages) != 3 {
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
		"pipeline", "run", "review", "--project", "proj", "--session", "sess")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/pipelines/runs" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q", capture.query)
	}
	var reqBody map[string]any
	if err := json.Unmarshal([]byte(capture.body), &reqBody); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if reqBody["pipeline"] != "review" || reqBody["sessionId"] != "sess" {
		t.Fatalf("body = %+v", reqBody)
	}
	if !strings.Contains(out, "run-9") {
		t.Fatalf("stdout = %q", out)
	}
}

// The subject is resolved server-side from a PR number: v2 has no --head-sha,
// because the head SHA and the fork flag come from the PR the daemon knows.
func TestPipelineRun_PRSubject(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusCreated, `{"runId":"run-9"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "run", "review", "--project", "proj", "--pr", "42")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var reqBody map[string]any
	if err := json.Unmarshal([]byte(capture.body), &reqBody); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if reqBody["prNumber"] != float64(42) {
		t.Fatalf("body = %+v", reqBody)
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
	srv, capture := pipelineServer(t, http.StatusOK,
		`{"run":{"runId":"run-1","status":"cancelled","cancelReason":"manual"}}`)
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
	if !strings.Contains(out, "run run-1 → cancelled (manual)") {
		t.Fatalf("stdout = %q", out)
	}
}

// v2 deleted resume with the semantics behind it. Like every other unknown
// verb under a command group, it falls through to the group's help; what must
// not happen is the CLI reaching for a resume route that no longer exists.
func TestPipelineResume_IsGone(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{}`)
	writeRunFileFor(t, cfg, srv)

	out, _, _ := executeCLI(t, aliveDeps(), "pipeline", "resume", "run-1")
	if strings.Contains(capture.path, "resume") {
		t.Fatalf("CLI called a resume route: %s %s", capture.method, capture.path)
	}
	if strings.Contains(out, "resume") {
		t.Fatalf("help still advertises resume:\n%s", out)
	}
}

// ---------------------------------------------------------------------------
// Credentials (decision D13)
// ---------------------------------------------------------------------------

func TestPipelineCredentialSet_PutsEnvAndPrintsKeysOnly(t *testing.T) {
	cfg := setConfigEnv(t)
	const secret = "s3cret-value"
	srv, capture := pipelineServer(t, http.StatusOK, `{"name":"npm","keys":["NPM_SCOPE","NPM_TOKEN"]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "credential", "set", "npm", "NPM_TOKEN="+secret, "NPM_SCOPE=@ao", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPut || capture.path != "/api/v1/pipelines/credentials/npm" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q", capture.query)
	}
	var body struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal([]byte(capture.body), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Env["NPM_TOKEN"] != secret || body.Env["NPM_SCOPE"] != "@ao" {
		t.Fatalf("env = %+v", body.Env)
	}
	if strings.Contains(out+errOut, secret) {
		t.Fatalf("set echoed the value back: stdout=%q stderr=%q", out, errOut)
	}
	if !strings.Contains(out, "NPM_TOKEN") || !strings.Contains(out, "npm") {
		t.Fatalf("stdout = %q", out)
	}
}

// A KEY=VALUE that is not one must not be echoed: the mistyped argument may be
// the secret itself.
func TestPipelineCredentialSet_MalformedPairNeverEchoesIt(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{"name":"npm","keys":[]}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "credential", "set", "npm", "oops-a-bare-secret", "--project", "proj")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
	if strings.Contains(err.Error()+errOut, "oops-a-bare-secret") {
		t.Fatalf("the malformed argument was echoed: %v / %s", err, errOut)
	}
	if strings.Contains(capture.path, "credentials") {
		t.Fatalf("CLI sent the credential anyway: %s %s", capture.method, capture.path)
	}
}

func TestPipelineCredentialSet_RequiresAPair(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "credential", "set", "npm", "--project", "proj")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
}

// `ls` is names only. Even if a daemon somehow answered with values attached,
// nothing the CLI prints may carry one.
func TestPipelineCredentialLs_PrintsNoValueBytes(t *testing.T) {
	cfg := setConfigEnv(t)
	const secret = "s3cret-value"
	srv, capture := pipelineServer(t, http.StatusOK,
		`{"names":["apple","npm"],"env":{"NPM_TOKEN":"`+secret+`"}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "credential", "ls", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/pipelines/credentials" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if strings.Contains(out+errOut, secret) {
		t.Fatalf("ls printed a value: stdout=%q stderr=%q", out, errOut)
	}
	for _, want := range []string{"Credentials for proj:", "apple", "npm"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout missing %q\nstdout=%s", want, out)
		}
	}
}

func TestPipelineCredentialLs_Empty(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, `{"names":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "credential", "ls", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "(no credentials for proj)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineCredentialRm_Human(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{"name":"npm","deleted":true}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "credential", "rm", "npm", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete || capture.path != "/api/v1/pipelines/credentials/npm" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q", capture.query)
	}
	if !strings.Contains(out, "credential npm removed") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineCredentialRm_NotFound(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusNotFound,
		`{"message":"no credential \"nope\" in this project","code":"PIPELINE_CREDENTIAL_NOT_FOUND"}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "credential", "rm", "nope", "--project", "proj")
	if err == nil {
		t.Fatal("expected error for 404 credential")
	}
	if !strings.Contains(err.Error(), "PIPELINE_CREDENTIAL_NOT_FOUND") {
		t.Fatalf("error = %v", err)
	}
}

// stageEnv sets (or clears, with "") the ambient stage variables the signal
// verbs read.
func stageEnv(t *testing.T, runID, stageID string) {
	t.Helper()
	t.Setenv("AO_RUN_ID", runID)
	t.Setenv("AO_STAGE", stageID)
}

func TestPipelineDone_PostsSignal(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusAccepted, `{"accepted":true}`)
	writeRunFileFor(t, cfg, srv)
	stageEnv(t, "run-1", "review")

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "done")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/pipelines/runs/run-1/stages/review/signal" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(capture.body), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["status"] != "done" || len(body) != 1 {
		t.Fatalf("body = %+v", body)
	}
	if !strings.Contains(out, "review") || !strings.Contains(out, "run-1") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineFail_PostsReason(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusAccepted, `{"accepted":true}`)
	writeRunFileFor(t, cfg, srv)
	stageEnv(t, "run-1", "review")

	_, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "fail", "--reason", "upstream API is down")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/pipelines/runs/run-1/stages/review/signal" {
		t.Fatalf("path = %q", capture.path)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(capture.body), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["status"] != "fail" || body["reason"] != "upstream API is down" {
		t.Fatalf("body = %+v", body)
	}
}

// Spec section 6.3: a missing stage variable errors by name, never guesses.
func TestPipelineSignal_MissingEnvErrorsByName(t *testing.T) {
	tests := []struct {
		name    string
		runID   string
		stageID string
		args    []string
		want    []string
	}{
		{"done without run id", "", "review", []string{"pipeline", "done"}, []string{"AO_RUN_ID"}},
		{"done without stage", "run-1", "", []string{"pipeline", "done"}, []string{"AO_STAGE"}},
		{"fail without run id", "", "review", []string{"pipeline", "fail", "--reason", "x"}, []string{"AO_RUN_ID"}},
		{"fail without stage", "run-1", "", []string{"pipeline", "fail", "--reason", "x"}, []string{"AO_STAGE"}},
		{"neither set", "", "", []string{"pipeline", "done"}, []string{"AO_RUN_ID", "AO_STAGE"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := setConfigEnv(t)
			srv, capture := pipelineServer(t, http.StatusAccepted, `{"accepted":true}`)
			writeRunFileFor(t, cfg, srv)
			stageEnv(t, tc.runID, tc.stageID)

			_, _, err := executeCLI(t, aliveDeps(), tc.args...)
			if err == nil {
				t.Fatal("expected an error when the stage environment is incomplete")
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error %q does not name %s", err, want)
				}
			}
			// The telemetry ping is the only call an aborted verb may make.
			if strings.Contains(capture.path, "/signal") {
				t.Fatalf("CLI signalled anyway: %s %s", capture.method, capture.path)
			}
		})
	}
}

func TestPipelineFail_MissingReasonIsUsageError(t *testing.T) {
	setConfigEnv(t)
	stageEnv(t, "run-1", "review")
	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "fail")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
}

func TestPipelineDone_StageNotRunningSurfacesConflict(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusConflict,
		`{"message":"Pipeline stage is not running","code":"PIPELINE_STAGE_NOT_RUNNING"}`)
	writeRunFileFor(t, cfg, srv)
	stageEnv(t, "run-1", "review")

	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "done")
	if err == nil {
		t.Fatal("expected error for 409")
	}
	if !strings.Contains(err.Error(), "PIPELINE_STAGE_NOT_RUNNING") {
		t.Fatalf("error = %v", err)
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

// ---------------------------------------------------------------------------
// Definition CRUD (create, get, update, delete, validate, schema)
// ---------------------------------------------------------------------------

// pipelineRoutedServer answers each "METHOD /path" key with its own canned
// body, for verbs that resolve a ref (a GET of the list) before mutating. The
// capture records the last request, which for those verbs is the mutation.
func pipelineRoutedServer(t *testing.T, routes map[string]string) (*httptest.Server, *pipelineCapture) {
	t.Helper()
	capture := &pipelineCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		capture.method = r.Method
		capture.path = r.URL.Path
		capture.query = r.URL.RawQuery
		capture.body = string(body)
		w.Header().Set("Content-Type", "application/json")
		resp, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"no such route","code":"NOT_FOUND"}`)
			return
		}
		_, _ = io.WriteString(w, resp)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

const (
	pipelineDefYAML     = "name: review\nstages:\n  - id: a\n"
	pipelineDefListBody = `{"definitions":[{"id":"pl-1","projectId":"proj","name":"review","yamlSource":"name: review\nstages:\n  - id: a\n","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T01:00:00Z"}]}`
	pipelineDefBody     = `{"definition":{"id":"pl-1","projectId":"proj","name":"review","yamlSource":"name: review\nstages:\n  - id: a\n","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T01:00:00Z"}}`
)

// writePipelineYAML puts a definition document on disk for the -f flag.
func writePipelineYAML(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pipeline.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPipelinesAlias_RoutesToPipeline(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{"definitions":[]}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, aliveDeps(), "pipelines", "list", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/pipelines" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
}

func TestPipelineCreate_HumanFromFile(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusCreated, pipelineDefBody)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "create", "-f", writePipelineYAML(t, pipelineDefYAML), "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/pipelines" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if capture.query != "project=proj" {
		t.Fatalf("query = %q", capture.query)
	}
	var reqBody map[string]string
	if err := json.Unmarshal([]byte(capture.body), &reqBody); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if reqBody["yamlSource"] != pipelineDefYAML {
		t.Fatalf("yamlSource = %q", reqBody["yamlSource"])
	}
	if !strings.Contains(out, "pipeline review created (pl-1)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineCreate_Stdin(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusCreated, pipelineDefBody)
	writeRunFileFor(t, cfg, srv)

	deps := aliveDeps()
	deps.In = strings.NewReader(pipelineDefYAML)
	_, errOut, err := executeCLI(t, deps, "pipeline", "create", "-f", "-", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var reqBody map[string]string
	if err := json.Unmarshal([]byte(capture.body), &reqBody); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if reqBody["yamlSource"] != pipelineDefYAML {
		t.Fatalf("yamlSource = %q", reqBody["yamlSource"])
	}
}

func TestPipelineCreate_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusCreated, pipelineDefBody)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "create", "-f", writePipelineYAML(t, pipelineDefYAML), "--project", "proj", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var res pipelineDefinitionResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not raw JSON: %v\nstdout=%s", err, out)
	}
	if res.Definition.ID != "pl-1" {
		t.Fatalf("definition = %+v", res.Definition)
	}
}

func TestPipelineCreate_MissingFileFlagIsUsageError(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusCreated, pipelineDefBody)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "create", "--project", "proj")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
	// The telemetry ping is the only call an aborted verb may make.
	if strings.Contains(capture.path, "pipelines") {
		t.Fatalf("CLI called the daemon anyway: %s %s", capture.method, capture.path)
	}
}

func TestPipelineCreate_MissingFileIsRuntimeError(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusCreated, pipelineDefBody)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(),
		"pipeline", "create", "-f", filepath.Join(t.TempDir(), "nope.yaml"), "--project", "proj")
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1; err=%v", got, err)
	}
	if !strings.Contains(err.Error(), "read pipeline definition") {
		t.Fatalf("error = %v", err)
	}
	// The telemetry ping is the only call an aborted verb may make.
	if strings.Contains(capture.path, "pipelines") {
		t.Fatalf("CLI called the daemon anyway: %s %s", capture.method, capture.path)
	}
}

func TestPipelineGet_PrintsRawYAML(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, pipelineDefListBody)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "get", "review", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/pipelines" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if out != pipelineDefYAML {
		t.Fatalf("stdout = %q, want the raw YAML document", out)
	}
}

func TestPipelineGet_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, pipelineDefListBody)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "get", "pl-1", "--project", "proj", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var def pipelineDefinitionSummary
	if err := json.Unmarshal([]byte(out), &def); err != nil {
		t.Fatalf("stdout is not JSON: %v\nstdout=%s", err, out)
	}
	if def.ID != "pl-1" || def.Name != "review" {
		t.Fatalf("definition = %+v", def)
	}
}

func TestPipelineGet_UnknownRef(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK, pipelineDefListBody)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(), "pipeline", "get", "nope", "--project", "proj")
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1; err=%v", got, err)
	}
	if !strings.Contains(err.Error(), `no pipeline "nope" in project proj`) {
		t.Fatalf("error = %v", err)
	}
}

func TestPipelineUpdate_ResolvesRefAndPuts(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineRoutedServer(t, map[string]string{
		"GET /api/v1/pipelines":      pipelineDefListBody,
		"PUT /api/v1/pipelines/pl-1": pipelineDefBody,
	})
	writeRunFileFor(t, cfg, srv)

	const updated = "name: review\nstages:\n  - id: b\n"
	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "update", "review", "-f", writePipelineYAML(t, updated), "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPut || capture.path != "/api/v1/pipelines/pl-1" {
		t.Fatalf("last request = %s %s", capture.method, capture.path)
	}
	var reqBody map[string]string
	if err := json.Unmarshal([]byte(capture.body), &reqBody); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if reqBody["yamlSource"] != updated {
		t.Fatalf("yamlSource = %q", reqBody["yamlSource"])
	}
	if !strings.Contains(out, "pipeline review updated (pl-1)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineUpdate_UnknownRef(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineRoutedServer(t, map[string]string{
		"GET /api/v1/pipelines": pipelineDefListBody,
	})
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, aliveDeps(),
		"pipeline", "update", "nope", "-f", writePipelineYAML(t, pipelineDefYAML), "--project", "proj")
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1; err=%v", got, err)
	}
	if capture.method != http.MethodGet {
		t.Fatalf("CLI mutated anyway: %s %s", capture.method, capture.path)
	}
}

func TestPipelineDelete_NonInteractiveWithoutYesIsUsageError(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineRoutedServer(t, map[string]string{
		"GET /api/v1/pipelines": pipelineDefListBody,
	})
	writeRunFileFor(t, cfg, srv)

	deps := aliveDeps()
	deps.In = strings.NewReader("") // a pipe, not a TTY
	_, _, err := executeCLI(t, deps, "pipeline", "delete", "review", "--project", "proj")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
	if !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("error does not point at --yes: %v", err)
	}
	if capture.method == http.MethodDelete {
		t.Fatalf("CLI deleted anyway: %s %s", capture.method, capture.path)
	}
}

func TestPipelineDelete_WithYes(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineRoutedServer(t, map[string]string{
		"GET /api/v1/pipelines":         pipelineDefListBody,
		"DELETE /api/v1/pipelines/pl-1": `{"id":"pl-1","deleted":true}`,
	})
	writeRunFileFor(t, cfg, srv)

	deps := aliveDeps()
	deps.In = strings.NewReader("")
	out, errOut, err := executeCLI(t, deps, "pipeline", "delete", "review", "--yes", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete || capture.path != "/api/v1/pipelines/pl-1" {
		t.Fatalf("last request = %s %s", capture.method, capture.path)
	}
	if !strings.Contains(out, "pipeline review deleted (pl-1)") {
		t.Fatalf("stdout = %q", out)
	}
}

func TestPipelineDelete_RmAlias(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineRoutedServer(t, map[string]string{
		"GET /api/v1/pipelines":         pipelineDefListBody,
		"DELETE /api/v1/pipelines/pl-1": `{"id":"pl-1","deleted":true}`,
	})
	writeRunFileFor(t, cfg, srv)

	deps := aliveDeps()
	deps.In = strings.NewReader("")
	_, errOut, err := executeCLI(t, deps, "pipeline", "rm", "pl-1", "--yes", "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete || capture.path != "/api/v1/pipelines/pl-1" {
		t.Fatalf("last request = %s %s", capture.method, capture.path)
	}
}

func TestPipelineValidate_ValidWithWarnings(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK,
		`{"valid":true,"issues":[],"warnings":[{"path":"stages[0]","message":"no on_failure anywhere"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(),
		"pipeline", "validate", "-f", writePipelineYAML(t, pipelineDefYAML), "--project", "proj")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/pipelines/validate" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	for _, want := range []string{"pipeline definition is valid", "Warnings:", "stages[0]: no on_failure anywhere"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout missing %q\nstdout=%s", want, out)
		}
	}
	if strings.Contains(out, "Errors:") {
		t.Fatalf("a valid document printed an Errors section:\n%s", out)
	}
}

// An invalid document is data plus exit 1, never a usage error (exit 2) and
// never a bare daemon failure: the CLI was used correctly.
func TestPipelineValidate_InvalidListsProblemsAndExitsOne(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK,
		`{"valid":false,"issues":[{"path":"stages[1].needs","message":"needs does not match the inbound edges"}],`+
			`"warnings":[{"path":"","message":"no on_failure anywhere"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(),
		"pipeline", "validate", "-f", writePipelineYAML(t, "name: broken\n"), "--project", "proj")
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1; err=%v", got, err)
	}
	if !strings.Contains(err.Error(), "pipeline definition is invalid (1 error)") {
		t.Fatalf("error = %v", err)
	}
	for _, want := range []string{
		"pipeline definition is invalid",
		"Errors:", "stages[1].needs: needs does not match the inbound edges",
		"Warnings:", "no on_failure anywhere",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout missing %q\nstdout=%s", want, out)
		}
	}
}

func TestPipelineValidate_JSONStillExitsOneOnInvalid(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := pipelineServer(t, http.StatusOK,
		`{"valid":false,"issues":[{"path":"name","message":"name is required"}],"warnings":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, aliveDeps(),
		"pipeline", "validate", "-f", writePipelineYAML(t, "stages: []\n"), "--project", "proj", "--json")
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1; err=%v", got, err)
	}
	var res validatePipelineDefinitionResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("stdout is not raw JSON: %v\nstdout=%s", err, out)
	}
	if res.Valid || len(res.Issues) != 1 {
		t.Fatalf("response = %+v", res)
	}
}

func TestPipelineSchema_DumpsSchema(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := pipelineServer(t, http.StatusOK, `{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"Pipeline"}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pipeline", "schema")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/pipelines/schema" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(out), &schema); err != nil {
		t.Fatalf("stdout is not JSON: %v\nstdout=%s", err, out)
	}
	if schema["title"] != "Pipeline" {
		t.Fatalf("schema = %+v", schema)
	}
}
