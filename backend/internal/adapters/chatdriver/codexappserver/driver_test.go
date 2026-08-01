package codexappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakePlugin struct {
	bin        string
	binErr     error
	authStatus ports.AgentAuthStatus
	authErr    error
}

func (f fakePlugin) ResolveBinary(context.Context) (string, error) { return f.bin, f.binErr }
func (f fakePlugin) AuthStatus(context.Context) (ports.AgentAuthStatus, error) {
	return f.authStatus, f.authErr
}

// scriptedServer answers client requests from a canned table and lets a test push
// notifications and server->client requests at the driver.
type scriptedServer struct {
	t        *testing.T
	toClient io.WriteCloser

	mu        sync.Mutex
	responses map[string]string
	seen      []frame
	seenCh    chan frame
}

func (s *scriptedServer) respondTo(method, resultJSON string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.responses[method] = resultJSON
}

func (s *scriptedServer) push(raw string) {
	s.t.Helper()
	if _, err := io.WriteString(s.toClient, raw+"\n"); err != nil {
		s.t.Fatalf("push: %v", err)
	}
}

// awaitFrame waits for a frame matching pred among everything the client sent.
func (s *scriptedServer) awaitFrame(pred func(frame) bool) frame {
	s.t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		s.mu.Lock()
		for _, f := range s.seen {
			if pred(f) {
				s.mu.Unlock()
				return f
			}
		}
		s.mu.Unlock()
		select {
		case <-s.seenCh:
		case <-deadline:
			s.t.Fatal("timed out waiting for an expected client frame")
			return frame{}
		}
	}
}

// newTestDriver wires a Driver to a scripted server over in-memory pipes, so no
// process is ever spawned.
func newTestDriver(t *testing.T) (*Driver, *scriptedServer) {
	t.Helper()

	clientReads, serverWrites := io.Pipe()
	serverReads, clientWrites := io.Pipe()

	srv := &scriptedServer{
		t:        t,
		toClient: serverWrites,
		responses: map[string]string{
			"initialize":     `{"userAgent":"ao/test","codexHome":"/tmp/.codex"}`,
			"thread/start":   `{"thread":{"id":"thread-1"},"model":"gpt-test","cwd":"/tmp/ws"}`,
			"turn/start":     `{"turn":{"id":"turn-1","status":"inProgress","items":[]}}`,
			"turn/interrupt": `{}`,
			"thread/resume":  `{"thread":{"id":"thread-1"}}`,
		},
		seenCh: make(chan frame, 64),
	}

	go func() {
		br := bufio.NewReader(serverReads)
		for {
			line, err := readFrame(br)
			if err != nil {
				return
			}
			if len(line) == 0 {
				continue
			}
			var f frame
			if err := json.Unmarshal(line, &f); err != nil {
				continue
			}

			srv.mu.Lock()
			srv.seen = append(srv.seen, f)
			reply, known := srv.responses[f.Method]
			srv.mu.Unlock()

			select {
			case srv.seenCh <- f:
			default:
			}

			if f.ID != nil && f.Method != "" && known {
				srv.push(`{"id":` + string(*f.ID) + `,"result":` + reply + `}`)
			}
		}
	}()

	d := &Driver{
		plugin: fakePlugin{bin: "codex", authStatus: ports.AgentAuthStatusAuthorized},
		log:    slog.New(slog.DiscardHandler),
		spawn: func(context.Context, string, string, []string) (*process, error) {
			return &process{
				stdin:  clientWrites,
				stdout: clientReads,
				stop:   func() error { return serverWrites.Close() },
			}, nil
		},
	}
	t.Cleanup(func() { _ = serverWrites.Close() })
	return d, srv
}

// nextEvent returns the next event of interest, skipping ones the test does not
// assert on.
func nextEvent(t *testing.T, events <-chan ports.ChatEvent, want ports.ChatEventKind) ports.ChatEvent {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("event stream closed while waiting for %q", want)
			}
			if ev.Kind == want {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for event %q", want)
			return ports.ChatEvent{}
		}
	}
}

func TestStartCompletesHandshakeAndOpensThread(t *testing.T) {
	d, srv := newTestDriver(t)

	conv, err := d.Start(context.Background(), ports.ChatStartConfig{
		SessionID:     "ao-1",
		WorkspacePath: "/tmp/ws",
		Permissions:   ports.PermissionModeDefault,
		SystemPrompt:  "standing rules",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	if got := conv.ProviderConversationID(); got != "thread-1" {
		t.Fatalf("provider conversation id = %q, want thread-1", got)
	}

	// initialized must be notified, or the provider never leaves handshake.
	srv.awaitFrame(func(f frame) bool { return f.Method == "initialized" && f.ID == nil })

	start := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/start" })
	var params struct {
		Cwd                   string `json:"cwd"`
		ApprovalPolicy        string `json:"approvalPolicy"`
		Sandbox               string `json:"sandbox"`
		DeveloperInstructions string `json:"developerInstructions"`
	}
	if err := json.Unmarshal(start.Params, &params); err != nil {
		t.Fatalf("thread/start params: %v", err)
	}
	if params.Cwd != "/tmp/ws" {
		t.Errorf("cwd = %q", params.Cwd)
	}
	if params.DeveloperInstructions != "standing rules" {
		t.Errorf("developerInstructions = %q", params.DeveloperInstructions)
	}
	// Default permissions must match what AO already gives a Codex TUI session.
	if params.ApprovalPolicy != "never" || params.Sandbox != "danger-full-access" {
		t.Errorf("default posture = %q/%q, want never/danger-full-access", params.ApprovalPolicy, params.Sandbox)
	}
}

// A relative cwd would put the agent in a directory relative to app-server's own
// process, silently editing the wrong tree.
func TestStartRejectsRelativeWorkspacePath(t *testing.T) {
	d, _ := newTestDriver(t)
	_, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "workspace"})
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("err = %v, want a rejection naming the absolute-path requirement", err)
	}
}

func TestSendTurnCarriesIdempotencyKey(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	ref, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text:            "what changed?",
		ClientMessageID: "client-msg-7",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	if ref.ProviderTurnID != "turn-1" {
		t.Fatalf("turn id = %q", ref.ProviderTurnID)
	}

	sent := srv.awaitFrame(func(f frame) bool { return f.Method == "turn/start" })
	var params struct {
		ThreadID            string `json:"threadId"`
		ClientUserMessageID string `json:"clientUserMessageId"`
		Input               []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"input"`
	}
	if err := json.Unmarshal(sent.Params, &params); err != nil {
		t.Fatalf("turn/start params: %v", err)
	}
	if params.ThreadID != "thread-1" {
		t.Errorf("threadId = %q", params.ThreadID)
	}
	if params.ClientUserMessageID != "client-msg-7" {
		t.Errorf("clientUserMessageId = %q, want the caller's key", params.ClientUserMessageID)
	}
	if len(params.Input) != 1 || params.Input[0].Text != "what changed?" {
		t.Errorf("input = %+v", params.Input)
	}
}

// An empty send is a caller bug, not a way to nudge the agent: there is no
// keystroke concept in Chat mode.
func TestSendTurnRejectsEmptyText(t *testing.T) {
	d, _ := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "  "}); err == nil {
		t.Fatal("expected empty text to be rejected")
	}
}

// The whole approval design in one test: the provider blocks on a server->client
// request, AO surfaces it with the provider's own decision list, and the user's
// choice is what unblocks the turn.
func TestApprovalIsParkedUntilResolved(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	// Shaped after a real captured approval: no requestId field, so the JSON-RPC
	// id is the only correlation key, and decline is not on offer.
	srv.push(`{"id":0,"method":"item/commandExecution/requestApproval","params":{` +
		`"threadId":"thread-1","turnId":"turn-1","itemId":"exec-1",` +
		`"command":"/bin/zsh -lc 'date -u'","cwd":"/tmp/ws",` +
		`"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["date","-u"]}},"cancel"]}}`)

	ev := nextEvent(t, conv.Events(), ports.ChatEventApprovalRequested)
	if ev.RequestID != "0" {
		t.Fatalf("request id = %q, want the JSON-RPC id 0", ev.RequestID)
	}
	if ev.ActivityStatus != domain.ActivityStatusPending {
		t.Errorf("status = %q, want pending", ev.ActivityStatus)
	}
	if ev.Summary != "Run date -u" {
		t.Errorf("summary = %q, want the shell wrapper stripped", ev.Summary)
	}

	var ids []string
	for _, opt := range ev.Decisions {
		ids = append(ids, opt.ID)
	}
	want := []string{"accept", "acceptWithExecpolicyAmendment", "cancel"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("decisions = %v, want %v (from the provider's own list)", ids, want)
	}

	// Nothing has been answered yet, so the provider is still blocked.
	srv.mu.Lock()
	for _, f := range srv.seen {
		if f.ID != nil && string(*f.ID) == "0" {
			srv.mu.Unlock()
			t.Fatal("approval was answered before the user decided")
		}
	}
	srv.mu.Unlock()

	if err := conv.ResolveRequest(context.Background(), "0", ports.ChatDecision{ID: "accept"}); err != nil {
		t.Fatalf("ResolveRequest: %v", err)
	}

	reply := srv.awaitFrame(func(f frame) bool { return f.ID != nil && string(*f.ID) == "0" && f.Method == "" })
	var payload struct {
		Decision string `json:"decision"`
	}
	if err := json.Unmarshal(reply.Result, &payload); err != nil {
		t.Fatalf("reply not decodable: %v (%s)", err, reply.Result)
	}
	if payload.Decision != "accept" {
		t.Fatalf("decision sent = %q", payload.Decision)
	}
}

// A structured decision must round-trip exactly, or the provider rejects it.
func TestStructuredDecisionIsEchoedVerbatim(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	srv.push(`{"id":3,"method":"item/commandExecution/requestApproval","params":{"command":"ls","availableDecisions":["accept"]}}`)
	ev := nextEvent(t, conv.Events(), ports.ChatEventApprovalRequested)

	raw := json.RawMessage(`{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["ls"]}}`)
	if err := conv.ResolveRequest(context.Background(), ev.RequestID, ports.ChatDecision{
		ID:  "acceptWithExecpolicyAmendment",
		Raw: raw,
	}); err != nil {
		t.Fatalf("ResolveRequest: %v", err)
	}

	reply := srv.awaitFrame(func(f frame) bool { return f.ID != nil && string(*f.ID) == "3" && f.Method == "" })
	if !strings.Contains(string(reply.Result), "execpolicy_amendment") {
		t.Fatalf("structured decision was not echoed: %s", reply.Result)
	}
}

// A card the user clicks after the request is gone must fail, never resolve
// something newer.
func TestResolveUnknownRequestIsRefused(t *testing.T) {
	d, _ := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	err = conv.ResolveRequest(context.Background(), "999", ports.ChatDecision{ID: "accept"})
	if err == nil {
		t.Fatal("expected resolving an unknown request to fail")
	}
}

// Answering a request AO does not model could consent to something on the user's
// behalf, so it must be refused with an error instead.
func TestUnmodelledServerRequestIsRefused(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	srv.push(`{"id":11,"method":"mcpServer/elicitation/request","params":{}}`)

	reply := srv.awaitFrame(func(f frame) bool { return f.ID != nil && string(*f.ID) == "11" && f.Method == "" })
	if reply.Error == nil {
		t.Fatalf("unmodelled request was answered with a result: %s", reply.Result)
	}
}

func TestNotificationsBecomeNeutralEvents(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	srv.push(`{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}}`)
	srv.push(`{"method":"item/agentMessage/delta","params":{"turnId":"turn-1","itemId":"m1","delta":"hello"}}`)
	srv.push(`{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}`)

	if ev := nextEvent(t, conv.Events(), ports.ChatEventMessageDelta); ev.Delta != "hello" {
		t.Fatalf("delta = %q", ev.Delta)
	}
	if ev := nextEvent(t, conv.Events(), ports.ChatEventTurnCompleted); ev.TurnState != domain.TurnStateCompleted {
		t.Fatalf("turn state = %q", ev.TurnState)
	}
}

// Resume must not quietly become a fresh thread: that would present unrelated
// history as continuous.
func TestResumeFailureDoesNotFallBackToStart(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.mu.Lock()
	delete(srv.responses, "thread/resume")
	srv.mu.Unlock()

	// Answer thread/resume with an error instead.
	go func() {
		f := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/resume" })
		srv.push(`{"id":` + string(*f.ID) + `,"error":{"code":-32602,"message":"unknown thread"}}`)
	}()

	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		SessionID:              "ao-1",
		ProviderConversationID: "thread-gone",
		WorkspacePath:          "/tmp/ws",
	})
	if !errors.Is(err, ports.ErrChatResumeFailed) {
		t.Fatalf("err = %v, want ErrChatResumeFailed", err)
	}

	srv.mu.Lock()
	defer srv.mu.Unlock()
	for _, f := range srv.seen {
		if f.Method == "thread/start" {
			t.Fatal("driver fell back to thread/start after a failed resume")
		}
	}
}

func TestResumeRequiresStoredThreadID(t *testing.T) {
	d, _ := newTestDriver(t)
	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{WorkspacePath: "/tmp/ws"})
	if !errors.Is(err, ports.ErrChatResumeFailed) {
		t.Fatalf("err = %v, want ErrChatResumeFailed", err)
	}
}

func TestProbeReportsAuthRequired(t *testing.T) {
	d := &Driver{
		plugin: fakePlugin{bin: "codex", authStatus: ports.AgentAuthStatusUnauthorized},
		log:    slog.New(slog.DiscardHandler),
	}
	if _, err := d.Probe(context.Background()); !errors.Is(err, ports.ErrChatAuthRequired) {
		t.Fatalf("err = %v, want ErrChatAuthRequired", err)
	}
}

// An inconclusive auth probe is not proof of failure, matching how AO already
// treats runtime probes.
func TestProbeTreatsUnknownAuthAsUsable(t *testing.T) {
	d := &Driver{
		plugin: fakePlugin{bin: "codex", authStatus: ports.AgentAuthStatusUnknown, authErr: errors.New("probe timed out")},
		log:    slog.New(slog.DiscardHandler),
	}
	caps, err := d.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) != 0 {
		t.Fatalf("codex is missing production capabilities: %v", missing)
	}
}

func TestProbeReportsMissingBinary(t *testing.T) {
	d := &Driver{
		plugin: fakePlugin{binErr: errors.New("codex not found on PATH")},
		log:    slog.New(slog.DiscardHandler),
	}
	if _, err := d.Probe(context.Background()); !errors.Is(err, ports.ErrChatDriverUnavailable) {
		t.Fatalf("err = %v, want ErrChatDriverUnavailable", err)
	}
}

// Chat must not be quietly stricter than the terminal path for the same setting.
func TestApprovalSettingsMirrorTUIPosture(t *testing.T) {
	for _, tc := range []struct {
		mode            ports.PermissionMode
		policy, sandbox string
	}{
		{ports.PermissionModeDefault, "never", "danger-full-access"},
		{ports.PermissionModeBypassPermissions, "never", "danger-full-access"},
		{ports.PermissionModeAcceptEdits, "on-request", "workspace-write"},
		{ports.PermissionModeAuto, "on-request", "workspace-write"},
		{ports.PermissionMode("nonsense"), "never", "danger-full-access"},
	} {
		policy, sandbox := approvalSettings(tc.mode)
		if policy != tc.policy || sandbox != tc.sandbox {
			t.Errorf("approvalSettings(%q) = %q/%q, want %q/%q", tc.mode, policy, sandbox, tc.policy, tc.sandbox)
		}
	}
}

func TestEnvSliceIsSortedForReproducibleRelaunch(t *testing.T) {
	got := envSlice(map[string]string{"PATH": "/a:/b", "HOME": "/h", "AO_SESSION": "ao-1"})
	want := []string{"AO_SESSION=ao-1", "HOME=/h", "PATH=/a:/b"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("envSlice = %v, want %v", got, want)
	}
	if envSlice(nil) != nil {
		t.Error("envSlice(nil) should stay nil so exec inherits the parent env")
	}
}

// When the process dies, the stream must say so rather than just going quiet.
func TestControllerStopIsAnnounced(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	_ = srv.toClient.Close()

	ev := nextEvent(t, conv.Events(), ports.ChatEventControllerState)
	if ev.ControllerState != ports.ChatControllerStopped {
		t.Fatalf("controller state = %q, want stopped", ev.ControllerState)
	}
	_ = conv.Close()
}
