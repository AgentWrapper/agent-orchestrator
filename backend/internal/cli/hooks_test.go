package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type activityCapture struct {
	body string
	path string
	hits int
}

// activityServer accepts POST /api/v1/sessions/{id}/activity and records what
// the CLI sent. It mirrors sendServer in send_test.go.
func activityServer(t *testing.T, status int, respBody string) (*httptest.Server, *activityCapture) {
	t.Helper()
	capture := &activityCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/activity") {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		capture.body = string(body)
		capture.path = r.URL.Path
		capture.hits++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func capturedState(t *testing.T, capture *activityCapture) string {
	t.Helper()
	var req struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	return req.State
}

func capturedAgent(t *testing.T, capture *activityCapture) string {
	t.Helper()
	var req struct {
		Agent string `json:"agent"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	return req.Agent
}

func capturedRuntimeToken(t *testing.T, capture *activityCapture) string {
	t.Helper()
	var req struct {
		RuntimeToken string `json:"runtimeToken"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	return req.RuntimeToken
}

func capturedDecision(t *testing.T, capture *activityCapture) struct {
	Kind     string   `json:"kind"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
} {
	t.Helper()
	var req struct {
		Decision struct {
			Kind     string   `json:"kind"`
			Question string   `json:"question"`
			Options  []string `json:"options"`
		} `json:"decision"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	return req.Decision
}

func capturedUsage(t *testing.T, capture *activityCapture) map[string]float64 {
	t.Helper()
	var req struct {
		Usage map[string]float64 `json:"usage"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	return req.Usage
}

func TestHooks_NotificationReportsWaitingInput(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDEnv, strconv.Itoa(os.Getppid()))
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true,"sessionId":"ao-7","state":"waiting_input"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"permission_prompt"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/sessions/ao-7/activity" {
		t.Errorf("path = %q, want /api/v1/sessions/ao-7/activity", capture.path)
	}
	if got := capturedState(t, capture); got != "blocked" {
		t.Errorf("state = %q, want blocked", got)
	}
	if got := capturedAgent(t, capture); got != "claude-code" {
		t.Errorf("agent = %q, want claude-code", got)
	}
	if got := capturedRuntimeToken(t, capture); got != "runtime-7" {
		t.Errorf("runtimeToken = %q, want runtime-7", got)
	}
}

func TestHooks_ForwardsUsagePayload(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex", "codex-fugu"} {
		t.Run(agent, func(t *testing.T) {
			t.Setenv("AO_SESSION_ID", "ao-7")
			cfg := setConfigEnv(t)
			srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
			writeRunFileFor(t, cfg, srv)

			_, _, err := executeCLI(t, Deps{
				In:           strings.NewReader(`{"usage":{"input_tokens":123,"output_tokens":45,"total_tokens":168,"cost_usd":0.0123}}`),
				ProcessAlive: func(int) bool { return true },
			}, "hooks", agent, "stop")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := capturedAgent(t, capture); got != agent {
				t.Fatalf("agent = %q, want %q", got, agent)
			}
			usage := capturedUsage(t, capture)
			want := map[string]float64{"input_tokens": 123, "output_tokens": 45, "total_tokens": 168, "cost_usd": 0.0123}
			if !reflect.DeepEqual(usage, want) {
				t.Fatalf("usage = %#v, want %#v", usage, want)
			}
		})
	}
}

func TestHooks_DropsInvalidUsagePayload(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"usage":{"input_tokens":-1,"output_tokens":"5","cost_usd":1e300}}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "codex", "stop")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if usage := capturedUsage(t, capture); len(usage) != 0 {
		t.Fatalf("usage = %#v, want omitted/empty invalid usage", usage)
	}
}

func TestHooks_IgnoresUsageOnNonTurnBoundaryEvents(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash","tool_use_id":"toolu_1","usage":{"input_tokens":123}}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "post-tool-use")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if usage := capturedUsage(t, capture); len(usage) != 0 {
		t.Fatalf("usage = %#v, want omitted for non-stop event", usage)
	}
}

func TestHooks_NotificationReportsQuestionDecision(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"agent_needs_input","question":"Choose lane","options":["API","Terminal"]}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "blocked" {
		t.Fatalf("state = %q, want blocked", got)
	}
	decision := capturedDecision(t, capture)
	if decision.Kind != "question" || decision.Question != "Choose lane" {
		t.Fatalf("decision = %#v", decision)
	}
	if !reflect.DeepEqual(decision.Options, []string{"API", "Terminal"}) {
		t.Fatalf("options = %#v", decision.Options)
	}
}

func TestHooks_NotificationReportsTextQuestionDecision(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"agent_needs_input","question":"What should I call this?"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	decision := capturedDecision(t, capture)
	if decision.Kind != "question" || decision.Question != "What should I call this?" {
		t.Fatalf("decision = %#v, want text question", decision)
	}
	if len(decision.Options) != 0 {
		t.Fatalf("options = %#v, want none for text question", decision.Options)
	}
}

func TestHooks_QuestionOptionsPreserveIndexes(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)
	longOption := strings.Repeat("x", maxActivityMetaLen+20)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"agent_needs_input","question":"Choose lane","options":["Ship now","` + longOption + `","  "]}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	decision := capturedDecision(t, capture)
	if len(decision.Options) != 3 {
		t.Fatalf("options = %#v, want three labels preserving indexes", decision.Options)
	}
	if decision.Options[0] != "Ship now" || len(decision.Options[1]) > maxActivityMetaLen || decision.Options[2] != "Option 3" {
		t.Fatalf("options = %#v, want original/truncated/placeholder labels", decision.Options)
	}
}

func TestHooks_PermissionRequestReportsPermissionDecision(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash","message":"Allow Bash?"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "permission-request")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "blocked" {
		t.Fatalf("state = %q, want blocked", got)
	}
	decision := capturedDecision(t, capture)
	if decision.Kind != "permission" || !strings.Contains(decision.Question, "Bash") {
		t.Fatalf("decision = %#v, want permission mentioning Bash", decision)
	}
}

func TestHooks_PermissionRequestWithOptionsStaysPermission(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash","message":"Allow Bash?","options":["Allow","Deny"]}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "permission-request")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	decision := capturedDecision(t, capture)
	if decision.Kind != "permission" {
		t.Fatalf("decision = %#v, want permission despite options", decision)
	}
	if len(decision.Options) != 0 {
		t.Fatalf("options = %#v, want none for permission decisions", decision.Options)
	}
}

func TestHooks_PermissionPromptNotificationWithOptionsStaysPermission(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"permission_prompt","message":"Allow Bash?","options":["Allow","Deny"]}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	decision := capturedDecision(t, capture)
	if decision.Kind != "permission" {
		t.Fatalf("decision = %#v, want permission despite notification options", decision)
	}
	if len(decision.Options) != 0 {
		t.Fatalf("options = %#v, want none for permission prompt notifications", decision.Options)
	}
}

func TestHooks_IdlePromptReportsIdle(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true,"sessionId":"ao-7","state":"idle"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"idle_prompt"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if got := capturedState(t, capture); got != "waiting_input" {
		t.Errorf("state = %q, want waiting_input", got)
	}
}

func TestHooks_SessionEndReportsExited(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Errorf("state = %q, want exited", got)
	}
}

func TestHooks_SuppressesNestedChildWhenParentPIDDoesNotMatch(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	t.Setenv(hookParentPIDEnv, "1")
	oldParentProcessInfo := parentProcessInfo
	parentProcessInfo = func(int) (int, string, bool) { return 2, "go", true }
	t.Cleanup(func() { parentProcessInfo = oldParentProcessInfo })
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Fatalf("nested hook posted %d activity request(s); body=%s", capture.hits, capture.body)
	}
}

func TestHooks_SuppressedParentPIDMismatchGoesToHooksLog(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	t.Setenv(hookParentPIDEnv, "1")
	oldParentProcessInfo := parentProcessInfo
	parentProcessInfo = func(int) (int, string, bool) { return 2, "go", true }
	t.Cleanup(func() { parentProcessInfo = oldParentProcessInfo })
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if errOut != "" {
		t.Fatalf("stderr = %q, want suppressed hook to stay quiet", errOut)
	}
	if capture.hits != 0 {
		t.Fatalf("suppressed hook posted %d activity request(s); body=%s", capture.hits, capture.body)
	}
	if data, err := os.ReadFile(filepath.Join(cfg.dataDir, "hooks.log")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("hooks.log should stay reserved for delivery failures, got err=%v data=%q", err, data)
	}
	data, err := os.ReadFile(filepath.Join(cfg.dataDir, suppressedLogName))
	if err != nil {
		t.Fatalf("%s not written: %v", suppressedLogName, err)
	}
	for _, want := range []string{"session=ao-7", "ao hooks claude-code session-end suppressed", "parent pid mismatch"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("%s missing %q:\n%s", suppressedLogName, want, data)
		}
	}
}

func TestHooks_SuppressesNonShellChildWhoseGrandparentMatchesMarker(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	t.Setenv(hookParentPIDEnv, strconv.Itoa(os.Getpid()))
	oldParentProcessInfo := parentProcessInfo
	parentProcessInfo = func(int) (int, string, bool) { return os.Getpid(), "claude", true }
	t.Cleanup(func() { parentProcessInfo = oldParentProcessInfo })
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Fatalf("nested non-shell hook posted %d activity request(s); body=%s", capture.hits, capture.body)
	}
}

func TestHooks_SuppressesShellChildWhoseGrandparentDoesNotMatchMarker(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	expected := os.Getpid() + 100000
	t.Setenv(hookParentPIDEnv, strconv.Itoa(expected))
	oldParentProcessInfo := parentProcessInfo
	parentProcessInfo = func(int) (int, string, bool) { return expected + 1, "bash", true }
	t.Cleanup(func() { parentProcessInfo = oldParentProcessInfo })
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Fatalf("nested shell hook posted %d activity request(s); body=%s", capture.hits, capture.body)
	}
}

func TestHooks_PostsWhenRequiredParentPIDMatches(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	t.Setenv(hookParentPIDEnv, strconv.Itoa(os.Getppid()))
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Fatalf("state = %q, want exited", got)
	}
}

func TestHooks_PostsWhenRequiredParentPIDMarkerIsInvalid(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	t.Setenv(hookParentPIDEnv, "not-a-pid")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Fatalf("state = %q, want exited", got)
	}
}

func TestHooks_PostsWhenRequiredParentPIDLineageIsUnresolvable(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	t.Setenv(hookParentPIDEnv, "1")
	oldParentProcessInfo := parentProcessInfo
	parentProcessInfo = func(int) (int, string, bool) { return 0, "", false }
	t.Cleanup(func() { parentProcessInfo = oldParentProcessInfo })
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Fatalf("state = %q, want exited", got)
	}
}

func TestHooks_SubprocessWhoseParentMatchesMarkerPosts(t *testing.T) {
	switch {
	case os.Getenv("AO_HOOK_AGENT_HELPER") == "1":
		runMarkedAgentHookHelper(t)
		return
	case os.Getenv("AO_HOOK_CHILD_HELPER") == "1":
		_, _, err := executeCLI(t, Deps{
			In:           strings.NewReader(`{"reason":"logout"}`),
			ProcessAlive: func(int) bool { return true },
		}, "hooks", "claude-code", "session-end")
		if err != nil {
			t.Fatalf("hook helper error: %v", err)
		}
		return
	}

	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	cmd := exec.Command(os.Args[0], "-test.run", "^TestHooks_SubprocessWhoseParentMatchesMarkerPosts$")
	cmd.Env = append(os.Environ(), "AO_HOOK_AGENT_HELPER=1")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("agent helper failed: %v\n%s", err, out.String())
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Fatalf("state = %q, want exited; helper output:\n%s", got, out.String())
	}
}

func TestHooks_ShellChildWhoseGrandparentMatchesMarkerPosts(t *testing.T) {
	switch {
	case os.Getenv("AO_HOOK_SHELL_AGENT_HELPER") == "1":
		runMarkedAgentShellHookHelper(t)
		return
	case os.Getenv("AO_HOOK_SHELL_CHILD_HELPER") == "1":
		_, _, err := executeCLI(t, Deps{
			In:           strings.NewReader(`{"reason":"logout"}`),
			ProcessAlive: func(int) bool { return true },
		}, "hooks", "claude-code", "session-end")
		if err != nil {
			t.Fatalf("hook helper error: %v", err)
		}
		return
	}

	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	t.Setenv(hookParentPIDRequiredEnv, "1")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	cmd := exec.Command(os.Args[0], "-test.run", "^TestHooks_ShellChildWhoseGrandparentMatchesMarkerPosts$")
	cmd.Env = append(os.Environ(), "AO_HOOK_SHELL_AGENT_HELPER=1")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("agent helper failed: %v\n%s", err, out.String())
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Fatalf("state = %q, want exited; helper output:\n%s", got, out.String())
	}
}

func runMarkedAgentShellHookHelper(t *testing.T) {
	t.Helper()
	cmd := exec.Command("sh", "-c", `"$1" -test.run "^TestHooks_ShellChildWhoseGrandparentMatchesMarkerPosts$"; true`, "ao-hook-shell", os.Args[0])
	cmd.Env = append(os.Environ(),
		"AO_HOOK_SHELL_AGENT_HELPER=",
		"AO_HOOK_SHELL_CHILD_HELPER=1",
		hookParentPIDEnv+"="+strconv.Itoa(os.Getpid()),
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("hook shell failed: %v\n%s", err, out.String())
	}
}

func runMarkedAgentHookHelper(t *testing.T) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run", "^TestHooks_SubprocessWhoseParentMatchesMarkerPosts$")
	cmd.Env = append(os.Environ(),
		"AO_HOOK_AGENT_HELPER=",
		"AO_HOOK_CHILD_HELPER=1",
		hookParentPIDEnv+"="+strconv.Itoa(os.Getpid()),
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("hook child failed: %v\n%s", err, out.String())
	}
}

func TestHooks_TokenBearingLegacyHookWithoutRequiredParentPIDStillPosts(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "runtime-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "exited" {
		t.Fatalf("state = %q, want exited", got)
	}
}

func TestHooks_StopReportsIdle(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "stop")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "idle" {
		t.Errorf("state = %q, want idle", got)
	}
}

func TestHooks_CodexPermissionRequestReportsBlocked(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "codex", "permission-request")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "blocked" {
		t.Errorf("state = %q, want blocked", got)
	}
}

func TestHooks_PostToolUseCarriesCorrelationFields(t *testing.T) {
	// Tool-use signals must carry the event and the native tool identity so
	// lifecycle can clear a stale blocked only on the approved tool's post.
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash","tool_use_id":"toolu_42","tool_response":"ok"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "post-tool-use")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{State: "active", Agent: "claude-code", Event: "post-tool-use", ToolName: "Bash", ToolUseID: "toolu_42"}
	if req != want {
		t.Errorf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_EventWithoutToolIdentityOmitsIt(t *testing.T) {
	// Adapters whose payloads carry no tool fields (codex permission-request
	// payload here has tool_name only) still tag the event; missing identity
	// fields stay empty rather than inventing values.
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_RUNTIME_TOKEN", "")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "codex", "permission-request")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{State: "blocked", Agent: "codex", Event: "permission-request", ToolName: "Bash", ToolUseID: ""}
	if req != want {
		t.Errorf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_OpenCodeUserPromptReportsActive(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"ses-1","prompt":"fix this"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "opencode", "user-prompt-submit")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := capturedState(t, capture); got != "active" {
		t.Errorf("state = %q, want active", got)
	}
}

func TestHooks_RejectsMalformedSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "../etc/passwd")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Errorf("expected no daemon call for an out-of-alphabet session id, got %d", capture.hits)
	}
}

func TestHooks_NoSessionIDIsNoOp(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"idle_prompt"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Errorf("expected no daemon call for a non-AO session, got %d", capture.hits)
	}
}

func TestHooks_UntrackedEventIsNoOp(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"notification_type":"auth_success"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "notification")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Errorf("expected no daemon call for an untracked notification, got %d", capture.hits)
	}
}

func TestHooks_DaemonDownIsBestEffort(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	setConfigEnv(t) // no run-file written: daemon is "not running"

	_, _, err := executeCLI(t, Deps{
		In: strings.NewReader(`{"reason":"logout"}`),
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("hooks must be best-effort (exit 0) when the daemon is down, got: %v", err)
	}
}

// TestHooks_DeliveryFailureGoesToHooksLog covers the durable failure sink:
// agents swallow hook stderr, so a delivery failure must also land in
// $AO_DATA_DIR/hooks.log — and a delivered hook must not write the file at all.
func TestHooks_DeliveryFailureGoesToHooksLog(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		wantLog bool
		wantIn  []string
	}{
		{
			name:    "daemon error is appended",
			status:  http.StatusInternalServerError,
			body:    `{"error":"internal","code":"BOOM","message":"boom"}`,
			wantLog: true,
			wantIn:  []string{"ao hooks claude-code session-end", "session=ao-7"},
		},
		{
			name:   "successful delivery writes nothing",
			status: http.StatusOK,
			body:   `{"ok":true}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AO_SESSION_ID", "ao-7")
			cfg := setConfigEnv(t)
			srv, _ := activityServer(t, tc.status, tc.body)
			writeRunFileFor(t, cfg, srv)

			_, _, err := executeCLI(t, Deps{
				In:           strings.NewReader(`{"reason":"logout"}`),
				ProcessAlive: func(int) bool { return true },
			}, "hooks", "claude-code", "session-end")
			if err != nil {
				t.Fatalf("hooks must exit 0, got: %v", err)
			}

			logPath := filepath.Join(cfg.dataDir, "hooks.log")
			data, err := os.ReadFile(logPath)
			if !tc.wantLog {
				if !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("hooks.log should not exist after a delivered hook, got err=%v data=%q", err, data)
				}
				return
			}
			if err != nil {
				t.Fatalf("hooks.log not written: %v", err)
			}
			for _, want := range tc.wantIn {
				if !strings.Contains(string(data), want) {
					t.Errorf("hooks.log missing %q:\n%s", want, data)
				}
			}
		})
	}
}

// TestHooks_HooksLogTruncatesPastCap asserts the size guard: an append against
// a hooks.log already past the cap truncates it first, so a persistently
// failing hook cannot grow the file without bound.
func TestHooks_HooksLogTruncatesPastCap(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t) // no run file written: every delivery fails
	logPath := filepath.Join(cfg.dataDir, "hooks.log")
	if err := os.MkdirAll(cfg.dataDir, 0o750); err != nil {
		t.Fatal(err)
	}
	oversized := strings.Repeat("x", maxHooksLogBytes+1)
	if err := os.WriteFile(logPath, []byte(oversized), 0o600); err != nil {
		t.Fatal(err)
	}

	_, _, err := executeCLI(t, Deps{
		In: strings.NewReader(`{"reason":"logout"}`),
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("hooks must exit 0, got: %v", err)
	}

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > maxHooksLogBytes {
		t.Fatalf("hooks.log = %d bytes, want truncated below the %d cap", len(data), maxHooksLogBytes)
	}
	if !strings.Contains(string(data), "ao hooks claude-code session-end") {
		t.Errorf("truncated hooks.log missing the new failure line:\n%s", data)
	}
}

func TestHooks_DaemonErrorIsSwallowed(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, _ := activityServer(t, http.StatusInternalServerError,
		`{"error":"internal","code":"BOOM","message":"boom"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"reason":"logout"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-end")
	if err != nil {
		t.Fatalf("hooks must exit 0 even on a daemon error, got: %v", err)
	}
	if !strings.Contains(errOut, "ao hooks") {
		t.Errorf("expected the failure surfaced to stderr, got %q", errOut)
	}
}
