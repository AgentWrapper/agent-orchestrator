package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
	shareddomain "github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPrepareClaudeCloudExperienceSkipsFirstRunPrompts(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(home, ".claude.json"),
		[]byte(`{"custom":"preserved"}`),
		0o600,
	); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if err := prepareClaudeCloudExperience(home); err != nil {
		t.Fatalf("prepareClaudeCloudExperience() error = %v", err)
	}

	root := readJSONObject(t, filepath.Join(home, ".claude.json"))
	if root["hasCompletedOnboarding"] != true ||
		root["theme"] != "dark" ||
		root["custom"] != "preserved" {
		t.Fatalf("Claude root config = %#v", root)
	}
	settings := readJSONObject(t, filepath.Join(home, ".claude", "settings.json"))
	permissions, _ := settings["permissions"].(map[string]any)
	if settings["theme"] != "dark" ||
		settings["skipDangerousModePermissionPrompt"] != true ||
		permissions["defaultMode"] != "bypassPermissions" {
		t.Fatalf("Claude settings = %#v", settings)
	}
}

func TestPrepareClaudeCloudExperienceUsesConfiguredDirectory(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "persistent-claude")
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)

	if err := prepareClaudeCloudExperience(home); err != nil {
		t.Fatalf("prepareClaudeCloudExperience() error = %v", err)
	}
	root := readJSONObject(t, filepath.Join(configDir, ".claude.json"))
	settings := readJSONObject(t, filepath.Join(configDir, "settings.json"))
	if root["hasCompletedOnboarding"] != true || root["theme"] != "dark" {
		t.Fatalf("configured Claude root = %#v", root)
	}
	if settings["skipDangerousModePermissionPrompt"] != true {
		t.Fatalf("configured Claude settings = %#v", settings)
	}
}

func TestClaudeTranscriptExistsUsesPersistentConfigDirectory(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	transcriptDir := filepath.Join(configDir, "projects", "-workspace-repository")
	if err := os.MkdirAll(transcriptDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(transcriptDir, "native-session.jsonl"),
		[]byte("{}\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if !claudeTranscriptExists("native-session") {
		t.Fatal("claudeTranscriptExists() = false, want true")
	}
	if claudeTranscriptExists("missing-session") {
		t.Fatal("claudeTranscriptExists(missing) = true")
	}
}

func TestRegressionRestartedClaudeSessionRequiresPersistedTranscript(t *testing.T) {
	configDir := t.TempDir()
	dataDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	if err := os.WriteFile(
		filepath.Join(dataDir, "agent-session-initialized"),
		[]byte("initialized\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	session := clouddomain.Session{
		ID:             "session-one",
		Harness:        "claude-code",
		AgentSessionID: "native-session",
	}
	restore, err := shouldRestoreAgentSession(session, dataDir)
	if err != nil {
		t.Fatalf("shouldRestoreAgentSession() error = %v", err)
	}
	if restore {
		t.Fatal("shouldRestoreAgentSession() = true without transcript")
	}

	transcriptDir := filepath.Join(configDir, "projects", "-workspace-repository")
	if err := os.MkdirAll(transcriptDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(transcriptDir, "native-session.jsonl"),
		[]byte("{}\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	restore, err = shouldRestoreAgentSession(session, dataDir)
	if err != nil {
		t.Fatalf("shouldRestoreAgentSession() error = %v", err)
	}
	if !restore {
		t.Fatal("shouldRestoreAgentSession() = false with durable marker and transcript")
	}
}

func TestOrchestratorSystemPromptRequiresDurableAOWorkers(t *testing.T) {
	prompt := systemPrompt("orchestrator", "project-one", "https://github.com/acme/repo", "main", "ao/orchestrator", "delegate carefully")
	for _, required := range []string{
		`ao spawn --name`,
		`Never use Claude's Agent tool`,
		`ao status`,
		`ao session get <worker>`,
		`ao wait <worker>`,
		`ao result <worker>`,
		`ao send --session`,
		`ao session merge-pr <worker>`,
		`Project-Specific Orchestrator Rules`,
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("orchestrator prompt does not contain %q", required)
		}
	}
	workerPrompt := systemPrompt("worker", "project-one", "https://github.com/acme/repo", "main", "ao/worker", "run focused tests")
	for _, required := range []string{
		`AO Worker Role`,
		`ao blocker --message`,
		`Work on this session branch: ao/worker`,
		`Pull Requests for This Session`,
		`Project Rules`,
	} {
		if !strings.Contains(workerPrompt, required) {
			t.Fatalf("worker prompt does not contain %q", required)
		}
	}
}

func TestRestrictOrchestratorToolsRemovesClaudeAgentTool(t *testing.T) {
	got := restrictOrchestratorTools(
		[]string{"claude", "--permission-mode", "bypassPermissions", "--", "delegate this"},
		"orchestrator",
		"claude-code",
	)
	want := []string{
		"claude",
		"--permission-mode", "bypassPermissions",
		"--tools", "Bash,Read,Glob,Grep,WebFetch,WebSearch",
		"--", "delegate this",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restricted argv = %#v, want %#v", got, want)
	}

	worker := []string{"claude", "--", "work"}
	if got := restrictOrchestratorTools(worker, "worker", "claude-code"); !reflect.DeepEqual(got, worker) {
		t.Fatalf("worker argv = %#v, want %#v", got, worker)
	}
}

func TestRegressionSpawnedClaudePromptIsSubmittedAfterComposerUpdate(t *testing.T) {
	terminal := &recordingWriter{}
	var writeMu sync.Mutex
	if err := submitInteractivePrompt(
		context.Background(),
		terminal,
		&writeMu,
		[]byte("Read the README"),
		0,
	); err != nil {
		t.Fatalf("submitInteractivePrompt() error = %v", err)
	}
	want := [][]byte{[]byte("Read the README"), {'\r'}}
	if !reflect.DeepEqual(terminal.writes, want) {
		t.Fatalf("terminal writes = %#v, want %#v", terminal.writes, want)
	}
}

func TestClaudeTerminalReadyWaitsForComposerFooter(t *testing.T) {
	ready := newAgentTerminalReady("claude-code")
	ready.observe([]byte("Welcome back!"))
	select {
	case <-ready.ready:
		t.Fatal("Claude terminal marked ready before composer footer")
	default:
	}

	ready.observe([]byte("bypass permissions on (shift+tab to cycle)"))
	if err := ready.wait(context.Background()); err != nil {
		t.Fatalf("wait() error = %v", err)
	}
}

func TestNonClaudeTerminalReadyImmediately(t *testing.T) {
	ready := newAgentTerminalReady("codex")
	if err := ready.wait(context.Background()); err != nil {
		t.Fatalf("wait() error = %v", err)
	}
}

func TestClaudeTerminalReadyToleratesStyledComposerFooter(t *testing.T) {
	separators := map[string]string{
		"space":                 " ",
		"mixed whitespace":      "\t\r\n\u00a0",
		"style reset":           "\x1b[2m\x1b[0m",
		"cursor positioning":    "\x1b[13G",
		"OSC title":             "\x1b]0;temporary title\a",
		"OSC string terminator": "\x1b]0;temporary title\x1b\\",
	}
	for name, separator := range separators {
		t.Run(name+"/permission-mode", func(t *testing.T) {
			if !claudeTerminalReady("BYPASS" + separator + "permissions on") {
				t.Fatal("Claude permission-mode footer was not detected")
			}
		})
		t.Run(name+"/keyboard-hint", func(t *testing.T) {
			output := "shift" + separator + "+" + separator + "tab" +
				separator + "to" + separator + "cycle"
			if !claudeTerminalReady(output) {
				t.Fatal("Claude keyboard hint was not detected")
			}
		})
	}
}

func TestClaudeTerminalReadyRejectsUnrelatedStartupText(t *testing.T) {
	for _, output := range []string{
		"Welcome back!",
		"permissions",
		"shift tab",
		"Fixed PreToolUse auto-allow hooks bypassing too broadly",
		"\x1b]0;Claude Code\a",
	} {
		if claudeTerminalReady(output) {
			t.Fatalf("unrelated output marked Claude ready: %q", output)
		}
	}
}

func TestClaudeTerminalReadyToleratesMixedKeyboardHintSeparators(t *testing.T) {
	separators := []string{
		"",
		" ",
		"\t\r\n\u00a0",
		"\x1b[13G",
		"\x1b[2m\x1b[0m",
		"\x1b]0;temporary title\a",
		"\x1bPtemporary device string\x1b\\",
	}
	for firstIndex, first := range separators {
		for secondIndex, second := range separators {
			for thirdIndex, third := range separators {
				for fourthIndex, fourth := range separators {
					output := "shift" + first + "+" + second + "tab" +
						third + "to" + fourth + "cycle"
					if !claudeTerminalReady(output) {
						t.Fatalf(
							"mixed separators [%d,%d,%d,%d] were not detected",
							firstIndex,
							secondIndex,
							thirdIndex,
							fourthIndex,
						)
					}
				}
			}
		}
	}
}

func TestClaudeTerminalReadyMatchesClaude221CursorPositionedFixture(t *testing.T) {
	fixture := readClaudeComposerFixture(t)
	if fixture.Version != "2.1.221" || fixture.TerminalColumns != 80 {
		t.Fatalf("fixture metadata = %#v", fixture)
	}

	ready := newAgentTerminalReady("claude-code")
	for index, chunk := range fixture.Chunks {
		ready.observe([]byte(chunk))
		if index < 4 {
			select {
			case <-ready.ready:
				t.Fatalf("Claude marked ready before composer chunk %d", index)
			default:
			}
		}
	}
	if err := ready.wait(context.Background()); err != nil {
		t.Fatalf("wait() error = %v", err)
	}

	compact := compactTerminalText(strings.Join(fixture.Chunks, ""))
	if !strings.Contains(compact, "bypasspermissionsonshifttabtocycle") {
		t.Fatalf("normalized fixture does not contain composer marker: %q", compact)
	}
}

func TestClaudeTerminalReadyHandlesEveryChunkBoundaryInFixture(t *testing.T) {
	fixture := readClaudeComposerFixture(t)
	output := strings.Join(fixture.Chunks, "")
	for split := 1; split < len(output); split++ {
		ready := newAgentTerminalReady("claude-code")
		ready.observe([]byte(output[:split]))
		ready.observe([]byte(output[split:]))
		select {
		case <-ready.ready:
		default:
			t.Fatalf("Claude fixture was not detected at byte split %d", split)
		}
	}

	bytewise := newAgentTerminalReady("claude-code")
	for index := range len(output) {
		bytewise.observe([]byte(output[index : index+1]))
	}
	if err := bytewise.wait(context.Background()); err != nil {
		t.Fatalf("bytewise fixture wait() error = %v", err)
	}
}

func TestClaudeTerminalReadyRetainsComposerMarkerAfterBufferTruncation(t *testing.T) {
	ready := newAgentTerminalReady("claude-code")
	ready.observe([]byte(strings.Repeat("unrelated startup output ", 600)))
	ready.observe([]byte("\x1b[6Gbypass\x1b[13Gpermissions"))
	if err := ready.wait(context.Background()); err != nil {
		t.Fatalf("wait() error = %v", err)
	}
}

func TestClaudePromptCanWaitForComposerBeforeActivityHook(t *testing.T) {
	if !promptDeliveryCanWaitForTerminal(false, newAgentTerminalReady("claude-code")) {
		t.Fatal("Claude prompt remained dependent on the activity hook")
	}
	if promptDeliveryCanWaitForTerminal(false, newAgentTerminalReady("codex")) {
		t.Fatal("non-Claude prompt bypassed the activity hook")
	}
	if !promptDeliveryCanWaitForTerminal(true, newAgentTerminalReady("codex")) {
		t.Fatal("ready non-Claude agent could not receive its prompt")
	}
}

func TestClaudePromptPrecedesBrowserCommandsDuringStartup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	terminal, agentSide, err := pty.Open()
	if err != nil {
		t.Fatalf("pty.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = terminal.Close()
		_ = agentSide.Close()
	})

	promptAccepted := make(chan struct{})
	commandsSent := make(chan struct{})
	serverErrors := make(chan error, 1)
	var acceptedOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cloud/v1/worker/connect":
			socket, acceptErr := websocket.Accept(w, r, nil)
			if acceptErr != nil {
				serverErrors <- acceptErr
				return
			}
			defer socket.Close(websocket.StatusNormalClosure, "test complete")
			commands := []cloudworkerhub.Command{
				{
					Type:     "prompt",
					Sequence: 1,
					Data:     base64.StdEncoding.EncodeToString([]byte("startup task")),
				},
				{Type: "resize", Rows: 40, Cols: 120},
				{
					Type: "input",
					Data: base64.StdEncoding.EncodeToString([]byte("premature browser input\r")),
				},
				{Type: "agent_ready"},
				{
					Type: "input",
					Data: base64.StdEncoding.EncodeToString([]byte("accepted browser input\r")),
				},
			}
			for _, command := range commands {
				encoded, marshalErr := json.Marshal(command)
				if marshalErr != nil {
					serverErrors <- marshalErr
					return
				}
				if writeErr := socket.Write(r.Context(), websocket.MessageText, encoded); writeErr != nil {
					serverErrors <- writeErr
					return
				}
			}
			close(commandsSent)
			<-r.Context().Done()
		case "/api/cloud/v1/worker/events":
			var event struct {
				Type string `json:"type"`
			}
			if decodeErr := json.NewDecoder(r.Body).Decode(&event); decodeErr != nil {
				serverErrors <- decodeErr
				http.Error(w, decodeErr.Error(), http.StatusBadRequest)
				return
			}
			if event.Type == "worker.prompt_accepted" {
				acceptedOnce.Do(func() { close(promptAccepted) })
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := NewClient(server.URL, server.Client())
	client.acceptToken("worker-token")
	runner := &Runner{client: client}
	terminalReady := newAgentTerminalReady("claude-code")
	var writeMu sync.Mutex
	var workspaceWriteMu sync.Mutex
	go runner.commandLoop(
		ctx,
		terminal,
		terminalReady,
		terminal,
		&writeMu,
		&workspaceWriteMu,
		0,
	)

	select {
	case <-commandsSent:
	case err := <-serverErrors:
		t.Fatalf("send startup commands: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("startup commands were not sent")
	}
	select {
	case <-promptAccepted:
		t.Fatal("prompt was accepted before Claude rendered its composer")
	case err := <-serverErrors:
		t.Fatalf("startup command stream error: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	for _, chunk := range readClaudeComposerFixture(t).Chunks {
		terminalReady.observe([]byte(chunk))
	}

	select {
	case <-promptAccepted:
	case err := <-serverErrors:
		t.Fatalf("accept startup prompt: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("Claude 2.1.221 composer did not release the startup prompt")
	}

	terminalInput := make(chan string, 1)
	go func() {
		var received strings.Builder
		buffer := make([]byte, 256)
		for !strings.Contains(received.String(), "accepted browser input") {
			count, readErr := agentSide.Read(buffer)
			if readErr != nil {
				return
			}
			received.Write(buffer[:count])
		}
		terminalInput <- received.String()
	}()
	select {
	case received := <-terminalInput:
		if !strings.Contains(received, "startup task") {
			t.Fatalf("terminal input %q does not contain startup prompt", received)
		}
		if strings.Contains(received, "premature browser input") {
			t.Fatalf("browser input interrupted startup: %q", received)
		}
	case err := <-serverErrors:
		t.Fatalf("process startup commands: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("browser input was not restored after startup prompt")
	}
}

func TestFollowUpPromptRunsAfterCommandDeliveredStartupPrompt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	terminal, agentSide, err := pty.Open()
	if err != nil {
		t.Fatalf("pty.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = terminal.Close()
		_ = agentSide.Close()
	})

	const startupSequence = int64(2)
	const followUpSequence = int64(4)
	promptAccepted := make(chan int64, 1)
	commandsSent := make(chan struct{})
	serverErrors := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cloud/v1/worker/connect":
			if got := r.URL.Query().Get("after"); got != "2" {
				serverErrors <- fmt.Errorf("after = %q, want 2", got)
				http.Error(w, "invalid after", http.StatusBadRequest)
				return
			}
			if got := r.URL.Query().Get("commandPrompt"); got != "2" {
				serverErrors <- fmt.Errorf("commandPrompt = %q, want 2", got)
				http.Error(w, "invalid command prompt", http.StatusBadRequest)
				return
			}
			socket, acceptErr := websocket.Accept(w, r, nil)
			if acceptErr != nil {
				serverErrors <- acceptErr
				return
			}
			defer socket.Close(websocket.StatusNormalClosure, "test complete")
			for _, command := range []cloudworkerhub.Command{
				{Type: "agent_ready"},
				{
					Type:     "prompt",
					Sequence: startupSequence,
					Data: base64.StdEncoding.EncodeToString(
						[]byte("duplicated startup prompt"),
					),
				},
				{
					Type:     "prompt",
					Sequence: followUpSequence,
					Data: base64.StdEncoding.EncodeToString(
						[]byte("orchestrator follow-up"),
					),
				},
			} {
				encoded, marshalErr := json.Marshal(command)
				if marshalErr != nil {
					serverErrors <- marshalErr
					return
				}
				if writeErr := socket.Write(
					r.Context(),
					websocket.MessageText,
					encoded,
				); writeErr != nil {
					serverErrors <- writeErr
					return
				}
			}
			close(commandsSent)
			<-r.Context().Done()
		case "/api/cloud/v1/worker/events":
			var event struct {
				Type    string `json:"type"`
				Payload struct {
					Sequence int64 `json:"sequence"`
				} `json:"payload"`
			}
			if decodeErr := json.NewDecoder(r.Body).Decode(&event); decodeErr != nil {
				serverErrors <- decodeErr
				http.Error(w, decodeErr.Error(), http.StatusBadRequest)
				return
			}
			if event.Type == "worker.prompt_accepted" {
				promptAccepted <- event.Payload.Sequence
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := NewClient(server.URL, server.Client())
	client.acceptToken("worker-token")
	runner := &Runner{client: client}
	terminalReady := newAgentTerminalReady("claude-code")
	var writeMu sync.Mutex
	var workspaceWriteMu sync.Mutex
	go runner.commandLoop(
		ctx,
		terminal,
		terminalReady,
		terminal,
		&writeMu,
		&workspaceWriteMu,
		startupSequence,
	)

	select {
	case <-commandsSent:
	case err := <-serverErrors:
		t.Fatalf("send follow-up commands: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("follow-up commands were not sent")
	}
	select {
	case sequence := <-promptAccepted:
		t.Fatalf("prompt sequence %d accepted before Claude was ready", sequence)
	case err := <-serverErrors:
		t.Fatalf("follow-up command stream error: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	for _, chunk := range readClaudeComposerFixture(t).Chunks {
		terminalReady.observe([]byte(chunk))
	}

	select {
	case sequence := <-promptAccepted:
		if sequence != followUpSequence {
			t.Fatalf("accepted prompt sequence = %d, want %d", sequence, followUpSequence)
		}
	case err := <-serverErrors:
		t.Fatalf("accept follow-up prompt: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("follow-up prompt was not acknowledged")
	}

	terminalInput := make(chan string, 1)
	go func() {
		buffer := make([]byte, 256)
		count, readErr := agentSide.Read(buffer)
		if readErr == nil {
			terminalInput <- string(buffer[:count])
		}
	}()
	select {
	case received := <-terminalInput:
		if !strings.Contains(received, "orchestrator follow-up") {
			t.Fatalf("terminal input %q does not contain follow-up prompt", received)
		}
		if strings.Contains(received, "duplicated startup prompt") {
			t.Fatalf("terminal input duplicated startup prompt: %q", received)
		}
	case err := <-serverErrors:
		t.Fatalf("read follow-up terminal input: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("follow-up prompt was not written to the terminal")
	}
}

type claudeComposerFixture struct {
	Version         string   `json:"version"`
	TerminalColumns int      `json:"terminalColumns"`
	Chunks          []string `json:"chunks"`
}

func readClaudeComposerFixture(t *testing.T) claudeComposerFixture {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("testdata", "claude-2.1.221-composer.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture claudeComposerFixture
	if err := json.Unmarshal(contents, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Chunks) == 0 {
		t.Fatal("Claude composer fixture has no chunks")
	}
	return fixture
}

func TestTerminalInputAllowedAfterAgentReady(t *testing.T) {
	if terminalInputAllowed(false) {
		t.Fatal("terminal input allowed before agent readiness")
	}
	if !terminalInputAllowed(true) {
		t.Fatal("terminal input blocked after agent readiness")
	}
}

func TestStreamOutputRetriesWithoutStoppingPTYDrain(t *testing.T) {
	calls := 0
	runner := &Runner{
		outputRetryDelay: -1,
		outputEvent: func(_ context.Context, eventType string, payload any) error {
			calls++
			if eventType != "terminal.output" {
				t.Fatalf("event type = %q", eventType)
			}
			if calls < 3 {
				return errors.New("temporary delivery failure")
			}
			values, _ := payload.(map[string]any)
			if values["data"] != base64.StdEncoding.EncodeToString([]byte("agent output")) {
				t.Fatalf("payload = %#v", payload)
			}
			return nil
		},
	}

	err := runner.streamOutput(
		context.Background(),
		strings.NewReader("agent output"),
		"terminal.output",
	)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("streamOutput() error = %v, want EOF", err)
	}
	if calls != 3 {
		t.Fatalf("delivery calls = %d, want 3", calls)
	}
}

func TestStreamOutputFailsAfterBoundedDeliveryAttempts(t *testing.T) {
	calls := 0
	runner := &Runner{
		outputRetryDelay: -1,
		outputEvent: func(context.Context, string, any) error {
			calls++
			return errors.New("delivery unavailable")
		},
	}

	err := runner.streamOutput(
		context.Background(),
		strings.NewReader("agent output"),
		"terminal.output",
	)
	if err == nil || !strings.Contains(err.Error(), "after 5 attempts") {
		t.Fatalf("streamOutput() error = %v", err)
	}
	if calls != terminalOutputMaxAttempts {
		t.Fatalf("delivery calls = %d, want %d", calls, terminalOutputMaxAttempts)
	}
}

func TestStreamOutputCancelsDeliveryWhenBoundedQueueFills(t *testing.T) {
	runner := &Runner{
		outputRetryDelay: -1,
		outputEvent: func(ctx context.Context, _ string, _ any) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}
	output := bytes.NewReader(
		make([]byte, terminalOutputChunkBytes*(terminalOutputQueueDepth+2)),
	)

	err := runner.streamOutput(context.Background(), output, "terminal.output")
	if !errors.Is(err, errTerminalOutputQueueFull) {
		t.Fatalf("streamOutput() error = %v", err)
	}
}

func TestLocalGitHubCredentialPersistsAndConfiguresGit(t *testing.T) {
	workspaceDir := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(workspaceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, workspaceDir, nil, "init")
	runGitTestCommand(t, workspaceDir, nil, "remote", "add", "origin", "https://example.invalid/old.git")

	runner := &Runner{
		workspaceDir: workspaceDir,
		dataDir:      t.TempDir(),
		bootstrap: BootstrapResponse{
			LocalGitHubToken: "github-token",
			Launch: cloudpostgres.WorkerLaunchSpec{
				RepositoryURL: "https://github.com/example/repository",
			},
		},
	}
	tokenPath, err := runner.persistLocalGitHubToken()
	if err != nil {
		t.Fatalf("persistLocalGitHubToken() error = %v", err)
	}
	if runner.bootstrap.LocalGitHubToken != "" {
		t.Fatal("bootstrap retained local GitHub token")
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode = %o, want 600", info.Mode().Perm())
	}
	if err := runner.configureLocalGitHubCredential(context.Background(), tokenPath); err != nil {
		t.Fatalf("configureLocalGitHubCredential() error = %v", err)
	}
	remote := strings.TrimSpace(string(runGitTestCommand(t, workspaceDir, nil, "remote", "get-url", "origin")))
	if remote != runner.bootstrap.Launch.RepositoryURL {
		t.Fatalf("origin = %q, want %q", remote, runner.bootstrap.Launch.RepositoryURL)
	}
	credentialInput := []byte("protocol=https\nhost=github.com\n\n")
	credential := string(runGitTestCommand(t, workspaceDir, credentialInput, "credential", "fill"))
	if !strings.Contains(credential, "username=x-access-token") ||
		!strings.Contains(credential, "password=github-token") {
		t.Fatalf("credential output = %q", credential)
	}
}

func TestWorkerGitCredentialHelperUsesCurrentTokenWithoutEmbeddingIt(t *testing.T) {
	dataDir := t.TempDir()
	tokenPath := filepath.Join(dataDir, "worker-token")
	if err := os.WriteFile(tokenPath, []byte("initial-worker-token"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{dataDir: dataDir}
	helperPath, err := runner.prepareWorkerGitCredentialHelper()
	if err != nil {
		t.Fatalf("prepareWorkerGitCredentialHelper() error = %v", err)
	}

	helperInfo, err := os.Stat(helperPath)
	if err != nil {
		t.Fatal(err)
	}
	if helperInfo.Mode().Perm() != 0o700 {
		t.Fatalf("helper mode = %o, want 700", helperInfo.Mode().Perm())
	}
	tokenInfo, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if tokenInfo.Mode().Perm() != 0o600 {
		t.Fatalf("token mode = %o, want 600", tokenInfo.Mode().Perm())
	}
	helperContents, err := os.ReadFile(helperPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(helperContents), "initial-worker-token") {
		t.Fatal("credential helper embedded the worker token")
	}
	assertWorkerGitCredential(t, helperPath, "initial-worker-token")

	if err := os.WriteFile(tokenPath, []byte("heartbeat-refreshed-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertWorkerGitCredential(t, helperPath, "heartbeat-refreshed-token")
	if strings.Contains(string(helperContents), "heartbeat-refreshed-token") {
		t.Fatal("credential helper embedded the refreshed worker token")
	}
}

func TestPrepareRepositoryConfiguresWorkerCredentialForNewAndResumedWorkspace(t *testing.T) {
	root := t.TempDir()
	sourceDir := filepath.Join(root, "source")
	remoteDir := filepath.Join(
		root,
		"api",
		"cloud",
		"v1",
		"git",
		"example",
		"repository.git",
	)
	if err := os.MkdirAll(sourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, sourceDir, nil, "init", "-b", "main")
	runGitTestCommand(t, sourceDir, nil, "config", "user.email", "worker@example.test")
	runGitTestCommand(t, sourceDir, nil, "config", "user.name", "AO Worker")
	if err := os.WriteFile(filepath.Join(sourceDir, "README.md"), []byte("fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, sourceDir, nil, "add", "README.md")
	runGitTestCommand(t, sourceDir, nil, "commit", "-m", "fixture")
	if err := os.MkdirAll(filepath.Dir(remoteDir), 0o700); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, root, nil, "clone", "--bare", sourceDir, remoteDir)

	dataDir := filepath.Join(root, "worker-data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "worker-token"), []byte("worker-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_CLOUD_PUBLIC_URL", "file://"+root)
	workspaceDir := filepath.Join(root, "workspace")
	client := NewClient("http://127.0.0.1:1", nil)
	client.SetToken("worker-token")
	runner := &Runner{
		client:       client,
		workspaceDir: workspaceDir,
		dataDir:      dataDir,
		bootstrap: BootstrapResponse{
			Launch: cloudpostgres.WorkerLaunchSpec{
				RepositoryURL: "https://github.com/example/repository",
				DefaultBranch: "main",
				Session: clouddomain.Session{
					Branch: "ao/session",
				},
			},
		},
	}

	if err := runner.prepareRepository(context.Background()); err != nil {
		t.Fatalf("prepareRepository(new) error = %v", err)
	}
	assertWorkerGitRepositoryConfig(
		t,
		workspaceDir,
		filepath.Join(dataDir, "git-credential-worker"),
		"worker-token",
	)

	if err := runner.prepareRepository(context.Background()); err != nil {
		t.Fatalf("prepareRepository(resumed) error = %v", err)
	}
	assertWorkerGitRepositoryConfig(
		t,
		workspaceDir,
		filepath.Join(dataDir, "git-credential-worker"),
		"worker-token",
	)
}

func TestPrepareRepositoryInitializesStandaloneWorkspace(t *testing.T) {
	workspaceDir := filepath.Join(t.TempDir(), "workspace")
	client := NewClient("http://127.0.0.1:1", nil)
	client.SetToken("worker-token")
	runner := &Runner{
		client:       client,
		workspaceDir: workspaceDir,
		dataDir:      t.TempDir(),
		bootstrap: BootstrapResponse{
			Launch: cloudpostgres.WorkerLaunchSpec{
				RepositoryURL: "ao-standalone://org-one/project-one",
				DefaultBranch: "main",
				ProjectConfig: []byte(`{"source":"standalone"}`),
				Session: clouddomain.Session{
					Branch: "ao/standalone-session",
				},
			},
		},
	}

	if err := runner.prepareRepository(context.Background()); err != nil {
		t.Fatalf("prepareRepository() error = %v", err)
	}
	if info, err := os.Stat(filepath.Join(workspaceDir, ".git")); err != nil || !info.IsDir() {
		t.Fatalf("standalone .git missing: info=%#v err=%v", info, err)
	}
	branch := strings.TrimSpace(string(runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"branch",
		"--show-current",
	)))
	if branch != "ao/standalone-session" {
		t.Fatalf("branch = %q, want ao/standalone-session", branch)
	}
	authorName := strings.TrimSpace(string(runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"config",
		"--local",
		"--get",
		"user.name",
	)))
	if authorName != cloudGitAuthorName {
		t.Fatalf("user.name = %q, want %q", authorName, cloudGitAuthorName)
	}
	if remoteOutput, err := exec.Command("git", "-C", workspaceDir, "remote").CombinedOutput(); err != nil {
		t.Fatalf("git remote failed: %v: %s", err, remoteOutput)
	} else if strings.TrimSpace(string(remoteOutput)) != "" {
		t.Fatalf("standalone remotes = %q, want none", strings.TrimSpace(string(remoteOutput)))
	}
}

func assertWorkerGitCredential(t *testing.T, helperPath, token string) {
	t.Helper()
	command := exec.Command(helperPath, "get")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run worker Git credential helper: %v: %s", err, output)
	}
	credential := string(output)
	if !strings.Contains(credential, "username="+GitProxyUsername+"\n") ||
		!strings.Contains(credential, "password="+token+"\n") {
		t.Fatalf("credential output = %q", credential)
	}
}

func assertWorkerGitRepositoryConfig(t *testing.T, workspaceDir, helperPath, token string) {
	t.Helper()
	helpers := string(runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"config",
		"--local",
		"--get-all",
		"credential.helper",
	))
	if !strings.Contains(helpers, helperPath) {
		t.Fatalf("credential helpers = %q, want %q", helpers, helperPath)
	}
	useHTTPPath := strings.TrimSpace(string(runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"config",
		"--local",
		"--get",
		"credential.useHttpPath",
	)))
	if useHTTPPath != "true" {
		t.Fatalf("credential.useHttpPath = %q, want true", useHTTPPath)
	}
	authorName := strings.TrimSpace(string(runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"config",
		"--local",
		"--get",
		"user.name",
	)))
	if authorName != cloudGitAuthorName {
		t.Fatalf("user.name = %q, want %q", authorName, cloudGitAuthorName)
	}
	authorEmail := strings.TrimSpace(string(runGitTestCommand(
		t,
		workspaceDir,
		nil,
		"config",
		"--local",
		"--get",
		"user.email",
	)))
	if authorEmail != cloudGitAuthorEmail {
		t.Fatalf("user.email = %q, want %q", authorEmail, cloudGitAuthorEmail)
	}
	credential := string(runGitTestCommand(
		t,
		workspaceDir,
		[]byte("protocol=https\nhost=cloud.example\npath=api/cloud/v1/git/example/repository.git\n\n"),
		"credential",
		"fill",
	))
	if !strings.Contains(credential, "username="+GitProxyUsername+"\n") ||
		!strings.Contains(credential, "password="+token+"\n") {
		t.Fatalf("repository credential output = %q", credential)
	}
}

func runGitTestCommand(
	t *testing.T,
	dir string,
	stdin []byte,
	arguments ...string,
) []byte {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", dir}, arguments...)...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	command.Stdin = bytes.NewReader(stdin)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", arguments, err, output)
	}
	return output
}

func TestRegressionRestartedClaudeSessionUsesRestoreCommand(t *testing.T) {
	agent := &recordingCloudAgentLauncher{
		launch:    []string{"agent", "new"},
		restore:   []string{"agent", "resume", "native-session"},
		restoreOK: true,
	}
	got, err := cloudAgentCommand(
		context.Background(),
		agent,
		ports.LaunchConfig{
			DataDir:       "/workspace/.ao/worker",
			Kind:          shareddomain.KindWorker,
			Permissions:   ports.PermissionModeBypassPermissions,
			SystemPrompt:  "standing instructions",
			WorkspacePath: "/workspace/repository",
		},
		clouddomain.Session{
			ID:             "session-one",
			AgentSessionID: "native-session",
		},
		true,
	)
	if err != nil {
		t.Fatalf("cloudAgentCommand() error = %v", err)
	}
	if !reflect.DeepEqual(got, agent.restore) {
		t.Fatalf("cloudAgentCommand() = %#v, want %#v", got, agent.restore)
	}
	if agent.restoreConfig.Session.Metadata[ports.MetadataKeyAgentSessionID] != "native-session" ||
		agent.restoreConfig.Session.WorkspacePath != "/workspace/repository" ||
		agent.restoreConfig.SystemPrompt != "standing instructions" {
		t.Fatalf("restore config = %#v", agent.restoreConfig)
	}
	if agent.launchCalls != 0 {
		t.Fatalf("GetLaunchCommand() calls = %d, want 0", agent.launchCalls)
	}
}

func TestPrepareCloudPromptDeliveryUsesHarnessCommand(t *testing.T) {
	agent := &recordingCloudAgentLauncher{
		strategy: ports.PromptDeliveryInCommand,
	}
	config := ports.LaunchConfig{Prompt: "Fix the flaky test"}
	sequence, err := prepareCloudPromptDelivery(
		context.Background(),
		agent,
		&config,
		42,
		false,
	)
	if err != nil {
		t.Fatalf("prepareCloudPromptDelivery() error = %v", err)
	}
	if sequence != 42 {
		t.Fatalf("command prompt sequence = %d, want 42", sequence)
	}
	if config.Prompt != "Fix the flaky test" {
		t.Fatalf("launch prompt = %q", config.Prompt)
	}
	if agent.strategyCalls != 1 || agent.strategyConfig.Prompt != config.Prompt {
		t.Fatalf("strategy calls = %d, config = %#v", agent.strategyCalls, agent.strategyConfig)
	}
}

func TestPrepareCloudPromptDeliveryKeepsAfterStartPromptsOutOfArgv(t *testing.T) {
	agent := &recordingCloudAgentLauncher{
		strategy: ports.PromptDeliveryAfterStart,
	}
	config := ports.LaunchConfig{Prompt: "Inject after startup"}
	sequence, err := prepareCloudPromptDelivery(
		context.Background(),
		agent,
		&config,
		17,
		false,
	)
	if err != nil {
		t.Fatalf("prepareCloudPromptDelivery() error = %v", err)
	}
	if sequence != 0 || config.Prompt != "" {
		t.Fatalf("after-start result = (%d, %q), want (0, empty)", sequence, config.Prompt)
	}
}

func TestPrepareCloudPromptDeliveryDoesNotReplayPromptInRestoreCommand(t *testing.T) {
	agent := &recordingCloudAgentLauncher{
		strategy: ports.PromptDeliveryInCommand,
	}
	config := ports.LaunchConfig{Prompt: "Do not duplicate me"}
	sequence, err := prepareCloudPromptDelivery(
		context.Background(),
		agent,
		&config,
		29,
		true,
	)
	if err != nil {
		t.Fatalf("prepareCloudPromptDelivery() error = %v", err)
	}
	if sequence != 0 || config.Prompt != "" || agent.strategyCalls != 0 {
		t.Fatalf(
			"restore result = (%d, %q), strategy calls = %d",
			sequence,
			config.Prompt,
			agent.strategyCalls,
		)
	}
}

type recordingCloudAgentLauncher struct {
	launch         []string
	restore        []string
	restoreOK      bool
	launchCalls    int
	restoreConfig  ports.RestoreConfig
	strategy       ports.PromptDeliveryStrategy
	strategyCalls  int
	strategyConfig ports.LaunchConfig
}

func (a *recordingCloudAgentLauncher) GetLaunchCommand(
	context.Context,
	ports.LaunchConfig,
) ([]string, error) {
	a.launchCalls++
	return a.launch, nil
}

func (a *recordingCloudAgentLauncher) GetPromptDeliveryStrategy(
	_ context.Context,
	config ports.LaunchConfig,
) (ports.PromptDeliveryStrategy, error) {
	a.strategyCalls++
	a.strategyConfig = config
	return a.strategy, nil
}

func (a *recordingCloudAgentLauncher) GetRestoreCommand(
	_ context.Context,
	config ports.RestoreConfig,
) ([]string, bool, error) {
	a.restoreConfig = config
	return a.restore, a.restoreOK, nil
}

type recordingWriter struct {
	writes [][]byte
}

func (w *recordingWriter) Write(data []byte) (int, error) {
	w.writes = append(w.writes, append([]byte(nil), data...))
	return len(data), nil
}

func readJSONObject(t *testing.T, path string) map[string]any {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	var object map[string]any
	if err := json.Unmarshal(contents, &object); err != nil {
		t.Fatalf("Unmarshal(%q) error = %v", path, err)
	}
	return object
}

func TestCloudWorkerEnvironmentsTargetCanonicalGitHubRepository(t *testing.T) {
	const repositoryURL = "https://github.com/amoreX/flowlens.git"
	agentEnvironment := workerEnvironment("worker-token", repositoryURL)
	workspaceEnvironment := workspaceShellEnvironment("ao/readme-tweak", repositoryURL)
	for name, environment := range map[string]map[string]string{
		"agent":     agentEnvironment,
		"workspace": workspaceEnvironment,
	} {
		if got := environment["GH_REPO"]; got != "amoreX/flowlens" {
			t.Fatalf("%s GH_REPO = %q, want amoreX/flowlens", name, got)
		}
	}
	if got := agentEnvironment["AO_WORKER_TOKEN"]; got != "worker-token" {
		t.Fatalf("agent worker token = %q", got)
	}
	if got := workspaceEnvironment["AO_SESSION_BRANCH"]; got != "ao/readme-tweak" {
		t.Fatalf("workspace branch = %q", got)
	}
}

func TestCloudWorkerEnvironmentOmitsInvalidGitHubRepository(t *testing.T) {
	environment := workerEnvironment("worker-token", "https://example.com/repository")
	if _, ok := environment["GH_REPO"]; ok {
		t.Fatalf("invalid repository produced GH_REPO = %q", environment["GH_REPO"])
	}
}

func TestPrepareAgentCredentialEnvironment(t *testing.T) {
	tests := []struct {
		name           string
		harness        string
		credentialType string
		environmentKey string
	}{
		{
			name:           "Claude OAuth token",
			harness:        "claude-code",
			credentialType: "oauth_token",
			environmentKey: "CLAUDE_CODE_OAUTH_TOKEN",
		},
		{
			name:           "Claude API key",
			harness:        "claude-code",
			credentialType: "api_key",
			environmentKey: "ANTHROPIC_API_KEY",
		},
		{
			name:           "Cursor API key",
			harness:        "cursor",
			credentialType: "api_key",
			environmentKey: "CURSOR_API_KEY",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			credential := &AgentCredential{
				Provider:       test.harness,
				CredentialType: test.credentialType,
				Secret:         "test-secret",
			}
			runner := runnerWithCredential(test.harness, credential)
			environment := map[string]string{}

			name, err := runner.prepareAgentCredential(context.Background(), environment)
			if err != nil {
				t.Fatalf("prepareAgentCredential() error = %v", err)
			}
			if name != test.environmentKey {
				t.Fatalf("environment name = %q, want %q", name, test.environmentKey)
			}
			if environment[test.environmentKey] != "test-secret" {
				t.Fatalf("credential environment was not populated")
			}
			if credential.Secret != "" {
				t.Fatalf("credential secret was not cleared")
			}
		})
	}
}

func TestSanitizedProcessEnvironmentDropsSecrets(t *testing.T) {
	t.Setenv("AO_WORKER_TOKEN", "worker-token")
	t.Setenv("AO_WORKER_BOOTSTRAP_TOKEN", "bootstrap-token")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")
	t.Setenv("AO_SESSION_ID", "session-id")

	environment := sanitizedProcessEnvironment()
	joined := "\n" + strings.Join(environment, "\n") + "\n"
	for _, name := range []string{
		"AO_WORKER_TOKEN",
		"AO_WORKER_BOOTSTRAP_TOKEN",
		"ANTHROPIC_API_KEY",
	} {
		if strings.Contains(joined, "\n"+name+"=") {
			t.Fatalf("sanitized environment retained %s", name)
		}
	}
	if !strings.Contains(joined, "\nAO_SESSION_ID=session-id\n") {
		t.Fatal("sanitized environment dropped non-secret session id")
	}
}

func TestPrepareAgentCredentialCodexLoginUsesStdin(t *testing.T) {
	for _, credentialType := range []string{"api_key", "access_token"} {
		t.Run(credentialType, func(t *testing.T) {
			credential := &AgentCredential{
				Provider:       "codex",
				CredentialType: credentialType,
				Secret:         "codex-secret",
			}
			runner := runnerWithCredential("codex", credential)
			var gotName string
			var gotArguments []string
			var gotStdin string
			runner.credentialCommand = func(
				_ context.Context,
				name string,
				arguments []string,
				stdin io.Reader,
			) error {
				gotName = name
				gotArguments = append([]string(nil), arguments...)
				encoded, err := io.ReadAll(stdin)
				if err != nil {
					return err
				}
				gotStdin = string(encoded)
				return nil
			}
			environment := map[string]string{}

			name, err := runner.prepareAgentCredential(context.Background(), environment)
			if err != nil {
				t.Fatalf("prepareAgentCredential() error = %v", err)
			}
			wantOption := "--with-api-key"
			if credentialType == "access_token" {
				wantOption = "--with-access-token"
			}
			if gotName != "codex" || !reflect.DeepEqual(gotArguments, []string{"login", wantOption}) {
				t.Fatalf("command = %q %#v, want codex login %s", gotName, gotArguments, wantOption)
			}
			if gotStdin != "codex-secret" {
				t.Fatalf("stdin = %q, want credential", gotStdin)
			}
			if name != "" || len(environment) != 0 {
				t.Fatalf("Codex credential leaked into environment: name=%q env=%#v", name, environment)
			}
			if credential.Secret != "" {
				t.Fatalf("credential secret was not cleared")
			}
		})
	}
}

func TestPrepareAgentCredentialCodexLoginFailure(t *testing.T) {
	credential := &AgentCredential{
		Provider:       "codex",
		CredentialType: "api_key",
		Secret:         "codex-secret",
	}
	runner := runnerWithCredential("codex", credential)
	runner.credentialCommand = func(context.Context, string, []string, io.Reader) error {
		return errors.New("codex login failed")
	}

	if _, err := runner.prepareAgentCredential(context.Background(), map[string]string{}); err == nil {
		t.Fatal("prepareAgentCredential() error = nil, want login failure")
	}
	if credential.Secret != "" {
		t.Fatalf("credential secret was not cleared after failure")
	}
}

func TestPrepareWorkerHomeCreatesConfiguredDirectories(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	codexHome := filepath.Join(home, ".codex")
	claudeConfig := filepath.Join(home, ".claude")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", claudeConfig)

	if err := prepareWorkerHome(); err != nil {
		t.Fatalf("prepareWorkerHome() error = %v", err)
	}
	for _, path := range []string{home, codexHome, claudeConfig} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("Stat(%q) error = %v", path, err)
		}
		if !info.IsDir() {
			t.Fatalf("%q is not a directory", path)
		}
	}
}

func runnerWithCredential(harness string, credential *AgentCredential) *Runner {
	return &Runner{
		bootstrap: BootstrapResponse{
			Launch: cloudpostgres.WorkerLaunchSpec{
				Session: clouddomain.Session{Harness: harness},
			},
			AgentCredential: credential,
		},
	}
}
