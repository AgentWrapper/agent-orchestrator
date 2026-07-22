package cli

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestHooks_NotificationReportsBlocked(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true,"sessionId":"ao-7","state":"blocked"}`)
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
	if got := capturedState(t, capture); got != "idle" {
		t.Errorf("state = %q, want idle (idle_prompt is not a blocking request)", got)
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

func TestHooks_SessionStartReportsNativeSessionIDWithoutActivity(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"019f6af0-codex-session"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "codex", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{Event: "session-start", AgentSessionID: "019f6af0-codex-session"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_ActivityAlsoReportsNativeSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"claude-session-1"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "stop")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{State: "idle", Event: "stop", AgentSessionID: "claude-session-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_UnknownAgentCannotReportNativeSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"untrusted-session"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "unknown-agent", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Fatalf("unknown agent reported metadata; hits=%d body=%s", capture.hits, capture.body)
	}
}

func TestHooks_ClaudeCodePermissionRequestReportsBlocked(t *testing.T) {
	// claude-code installs the pre/post-tool-use trio, so a permission-request
	// blocked state can be correlated and cleared — it is the one harness that
	// reports blocked.
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"tool_name":"Bash"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "permission-request")
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
	want := setActivityAPIRequest{State: "active", Event: "post-tool-use", ToolName: "Bash", ToolUseID: "toolu_42"}
	if req != want {
		t.Errorf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_EventWithoutToolIdentityOmitsIt(t *testing.T) {
	// Adapters whose payloads carry no tool fields (codex permission-request
	// payload here has tool_name only) still tag the event; missing identity
	// fields stay empty rather than inventing values.
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
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{State: "waiting_input", Event: "permission-request", ToolName: "Bash", ToolUseID: ""}
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

func TestHooks_CodexSessionStartReportsAgentSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"codex-native-1"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "codex", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 1 {
		t.Fatalf("daemon calls = %d, want 1", capture.hits)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{Event: "session-start", AgentSessionID: "codex-native-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_CodexBlankSessionIDIsIgnored(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"   "}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "codex", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Fatalf("daemon calls = %d, want 0", capture.hits)
	}
}

func TestHooks_ClaudeCodeSessionStartReportsAgentSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"claude-native-1"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 1 {
		t.Fatalf("daemon calls = %d, want 1", capture.hits)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{Event: "session-start", AgentSessionID: "claude-native-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_ClaudeCodeBlankSessionIDIsIgnored(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"   "}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 0 {
		t.Fatalf("daemon calls = %d, want 0", capture.hits)
	}
}

func TestHooks_GrokSessionStartReportsAgentSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"grok-native-1"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "grok", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 1 {
		t.Fatalf("daemon calls = %d, want 1", capture.hits)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{Event: "session-start", AgentSessionID: "grok-native-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_RegisteredHarnessSessionStartReportsAgentSessionID(t *testing.T) {
	for _, agent := range []string{"opencode", "qwen", "kimi", "kilocode", "goose"} {
		t.Run(agent, func(t *testing.T) {
			t.Setenv("AO_SESSION_ID", "ao-7")
			cfg := setConfigEnv(t)
			srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
			writeRunFileFor(t, cfg, srv)

			_, _, err := executeCLI(t, Deps{
				In:           strings.NewReader(`{"session_id":"` + agent + `-native-1"}`),
				ProcessAlive: func(int) bool { return true },
			}, "hooks", agent, "session-start")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if capture.hits != 1 {
				t.Fatalf("daemon calls = %d, want 1", capture.hits)
			}
			var req setActivityAPIRequest
			if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
				t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
			}
			want := setActivityAPIRequest{State: "active", Event: "session-start", AgentSessionID: agent + "-native-1"}
			if req != want {
				t.Fatalf("body = %+v, want %+v", req, want)
			}
		})
	}
}

func TestHooks_VibePostAgentReportsSessionIDAndIdle(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"session_id":"vibe-native-1","hook_event_name":"post_agent"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "vibe", "post-agent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 1 {
		t.Fatalf("daemon calls = %d, want 1", capture.hits)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{State: "idle", Event: "post-agent", AgentSessionID: "vibe-native-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_AgySessionStartReportsConversationID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	promptDir := filepath.Join(cfg.dataDir, "prompts", "ao-7")
	if err := os.MkdirAll(promptDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(promptDir, "system.md"), []byte("follow AO standing instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"conversationId":"agy-native-1"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		t.Fatal("expected Agy session-start context output")
	}
	if capture.hits != 1 {
		t.Fatalf("daemon calls = %d, want 1", capture.hits)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{Event: "session-start", AgentSessionID: "agy-native-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_CopilotSessionStartReportsSessionID(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"sessionId":"copilot-native-1"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "copilot", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capture.hits != 1 {
		t.Fatalf("daemon calls = %d, want 1", capture.hits)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	want := setActivityAPIRequest{State: "active", Event: "session-start", AgentSessionID: "copilot-native-1"}
	if req != want {
		t.Fatalf("body = %+v, want %+v", req, want)
	}
}

func TestHooks_DevinSessionStartInjectsSystemPromptContext(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	promptDir := filepath.Join(cfg.dataDir, "prompts", "ao-7")
	if err := os.MkdirAll(promptDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(promptDir, "system.md"), []byte("follow AO standing instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"source":"startup"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "devin", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode Devin hook output: %v\n%s", err, out)
	}
	if got.HookSpecificOutput.HookEventName != "SessionStart" {
		t.Fatalf("hookEventName = %q", got.HookSpecificOutput.HookEventName)
	}
	if got.HookSpecificOutput.AdditionalContext != "follow AO standing instructions" {
		t.Fatalf("additionalContext = %q", got.HookSpecificOutput.AdditionalContext)
	}
	if got := capturedState(t, capture); got != "active" {
		t.Errorf("state = %q, want active", got)
	}
}

func TestHooks_AgySessionStartInjectsSystemPromptContext(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	promptDir := filepath.Join(cfg.dataDir, "prompts", "ao-7")
	if err := os.MkdirAll(promptDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(promptDir, "system.md"), []byte("follow AO standing instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"source":"startup"}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "session-start")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode Agy hook output: %v\n%s", err, out)
	}
	if got.HookSpecificOutput.HookEventName != "SessionStart" {
		t.Fatalf("hookEventName = %q", got.HookSpecificOutput.HookEventName)
	}
	if got.HookSpecificOutput.AdditionalContext != "follow AO standing instructions" {
		t.Fatalf("additionalContext = %q", got.HookSpecificOutput.AdditionalContext)
	}
	if capture.hits != 0 {
		t.Errorf("Agy session-start should only inject context, got %d daemon calls", capture.hits)
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
