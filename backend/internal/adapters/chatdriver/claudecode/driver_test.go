package claudecode

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

// scriptedCLI stands in for the claude child process over in-memory pipes, so the
// driver is tested without spawning anything.
//
// Every reply it writes is a SINGLE LINE. readFrame is line-delimited, so a
// pretty-printed reply would leave the client waiting on a newline that never
// comes: the test would hang forever instead of failing.
type scriptedCLI struct {
	t        *testing.T
	toClient io.WriteCloser

	mu        sync.Mutex
	responses map[string]string
	failures  map[string]string
	seen      []sentFrame
	seenCh    chan sentFrame

	stderr string
}

// sentFrame is one frame the client wrote, decoded far enough to assert on.
type sentFrame struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Response  json.RawMessage `json:"response"`
	Message   json.RawMessage `json:"message"`
	// Subtype is lifted out of Request for readability in assertions.
	Subtype string `json:"-"`
	Raw     string `json:"-"`
}

func (s *scriptedCLI) reply(subtype, resultJSON string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.responses[subtype] = resultJSON
}

func (s *scriptedCLI) replyError(subtype, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[subtype] = message
}

// push writes a raw frame at the client. The caller supplies one line of JSON.
func (s *scriptedCLI) push(raw string) {
	s.t.Helper()
	if strings.Contains(raw, "\n") {
		s.t.Fatalf("pushed frame spans multiple lines; the client reads line-delimited JSON")
	}
	if _, err := io.WriteString(s.toClient, raw+"\n"); err != nil {
		s.t.Fatalf("push: %v", err)
	}
}

// tryPush is push from the serving goroutine, where a closed pipe is an expected
// outcome: the tests that simulate a dead CLI close it out from under the reply.
func (s *scriptedCLI) tryPush(raw string) {
	_, _ = io.WriteString(s.toClient, raw+"\n")
}

// nextFrame waits for the next frame the client wrote.
func (s *scriptedCLI) nextFrame(t *testing.T) sentFrame {
	t.Helper()
	select {
	case f, ok := <-s.seenCh:
		if !ok {
			t.Fatal("client closed its stream before sending another frame")
		}
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a frame from the client")
		return sentFrame{}
	}
}

// waitForSubtype drains frames until one carries the named control subtype.
func (s *scriptedCLI) waitForSubtype(t *testing.T, subtype string) sentFrame {
	t.Helper()
	for {
		f := s.nextFrame(t)
		if f.Subtype == subtype {
			return f
		}
	}
}

func (s *scriptedCLI) sentSubtype(subtype string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.seen {
		if f.Subtype == subtype {
			return true
		}
	}
	return false
}

// newHarness builds a driver whose spawn hands back pipes into scriptedCLI.
func newHarness(t *testing.T, plugin fakePlugin) (*Driver, *scriptedCLI, *[]string) {
	t.Helper()

	clientReads, serverWrites := io.Pipe()
	serverReads, clientWrites := io.Pipe()

	cli := &scriptedCLI{
		t:         t,
		toClient:  serverWrites,
		responses: map[string]string{},
		failures:  map[string]string{},
		seenCh:    make(chan sentFrame, 64),
	}

	go func() {
		br := bufio.NewReaderSize(serverReads, 1<<20)
		for {
			line, err := readFrame(br)
			if err != nil {
				close(cli.seenCh)
				return
			}
			if len(line) == 0 {
				continue
			}
			var f sentFrame
			if err := json.Unmarshal(line, &f); err != nil {
				continue
			}
			f.Raw = string(line)
			f.Subtype = controlSubtype(f.Request)

			cli.mu.Lock()
			cli.seen = append(cli.seen, f)
			result, ok := cli.responses[f.Subtype]
			failure, failed := cli.failures[f.Subtype]
			cli.mu.Unlock()

			select {
			case cli.seenCh <- f:
			default:
			}

			if f.Type != "control_request" {
				continue
			}
			switch {
			case failed:
				cli.tryPush(`{"type":"control_response","response":{"subtype":"error","request_id":` +
					quote(f.RequestID) + `,"error":` + quote(failure) + `}}`)
			case ok:
				cli.tryPush(`{"type":"control_response","response":{"subtype":"success","request_id":` +
					quote(f.RequestID) + `,"response":` + result + `}}`)
			default:
				cli.tryPush(`{"type":"control_response","response":{"subtype":"success","request_id":` +
					quote(f.RequestID) + `}}`)
			}
		}
	}()

	var launchArgs []string
	d := New(plugin, slog.New(slog.DiscardHandler))
	d.newSessionID = func() string { return "sess-fixed-0001" }
	d.spawn = func(_ context.Context, _, _ string, args, _ []string) (*process, error) {
		launchArgs = args
		return &process{
			stdin:      clientWrites,
			stdout:     clientReads,
			stderrTail: func() string { return cli.stderr },
			stop: func() error {
				_ = clientWrites.Close()
				_ = serverWrites.Close()
				return nil
			},
		}, nil
	}

	t.Cleanup(func() {
		_ = serverWrites.Close()
		_ = clientWrites.Close()
	})
	return d, cli, &launchArgs
}

func quote(s string) string {
	encoded, _ := json.Marshal(s)
	return string(encoded)
}

func startConversation(t *testing.T, d *Driver) ports.ChatConversation {
	t.Helper()
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{
		SessionID:     "ao-session",
		WorkspacePath: "/tmp/workspace",
		Permissions:   ports.PermissionModeAcceptEdits,
		SystemPrompt:  "AO standing instructions",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = conv.Close() })
	return conv
}

// nextEvent waits for one normalized event.
func nextEvent(t *testing.T, conv ports.ChatConversation) ports.ChatEvent {
	t.Helper()
	select {
	case ev, ok := <-conv.Events():
		if !ok {
			t.Fatal("event stream closed")
		}
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for an event")
		return ports.ChatEvent{}
	}
}

func waitForKind(t *testing.T, conv ports.ChatConversation, kind ports.ChatEventKind) ports.ChatEvent {
	t.Helper()
	for {
		ev := nextEvent(t, conv)
		if ev.Kind == kind {
			return ev
		}
	}
}

func TestProbeRefusesAMissingBinary(t *testing.T) {
	d, _, _ := newHarness(t, fakePlugin{binErr: errors.New("claude not found")})
	if _, err := d.Probe(context.Background()); !errors.Is(err, ports.ErrChatDriverUnavailable) {
		t.Fatalf("Probe error = %v, want ErrChatDriverUnavailable", err)
	}
}

func TestProbeRefusesAnUnauthenticatedInstall(t *testing.T) {
	d, _, _ := newHarness(t, fakePlugin{bin: "claude", authStatus: ports.AgentAuthStatusUnauthorized})
	if _, err := d.Probe(context.Background()); !errors.Is(err, ports.ErrChatAuthRequired) {
		t.Fatalf("Probe error = %v, want ErrChatAuthRequired", err)
	}
}

// An inconclusive auth probe is not proof of failure. AO already applies that
// rule to runtime probes, and refusing here would block a working install
// whenever the auth check happened to be unreadable.
func TestProbeToleratesAnInconclusiveAuthCheck(t *testing.T) {
	d, _, _ := newHarness(t, fakePlugin{bin: "claude", authErr: errors.New("timeout")})
	caps, err := d.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) != 0 {
		t.Fatalf("missing production capabilities: %v", missing)
	}
}

// The floor is what decides whether AO will offer chat mode for this harness at
// all, so it is asserted rather than left to a reader to infer from the map.
func TestCapabilitiesMeetTheProductionFloor(t *testing.T) {
	if missing := ports.MissingProductionCapabilities(capabilities()); len(missing) != 0 {
		t.Fatalf("missing production capabilities: %v", missing)
	}
	// Advertised only where the CLI genuinely delivers. A capability AO cannot
	// drive would light up a control that then fails.
	for _, absent := range []ports.ChatCapability{
		ports.ChatCapabilityDiffs,
		ports.ChatCapabilityRollback,
		ports.ChatCapabilityFork,
		ports.ChatCapabilityHistory,
		ports.ChatCapabilitySteer,
		ports.ChatCapabilityInteractive,
		ports.ChatCapabilitySkills,
	} {
		if capabilities().Has(absent) {
			t.Errorf("capability %q is advertised but the CLI has no mechanism for it", absent)
		}
	}
}

// The launch is the whole contract with the CLI. Each flag here has a failure
// mode if it goes missing, so they are asserted by name.
func TestLaunchCarriesTheFlagsTheProtocolDependsOn(t *testing.T) {
	d, _, args := newHarness(t, fakePlugin{bin: "claude", authStatus: ports.AgentAuthStatusAuthorized})
	conv := startConversation(t, d)

	joined := strings.Join(*args, " ")
	for _, want := range []string{
		"--print",
		"--output-format stream-json",
		"--input-format stream-json",
		// Without it stream-json carries only the final result.
		"--verbose",
		// Without it a mode that would prompt silently denies instead.
		"--permission-prompt-tool stdio",
		// Without it there are no deltas and "streaming" is a lie.
		"--include-partial-messages",
		"--permission-mode acceptEdits",
		"--session-id sess-fixed-0001",
		"--append-system-prompt AO standing instructions",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("launch args missing %q; got %v", want, *args)
		}
	}

	// The id is AO's, minted before the process started, so a conversation is
	// resumable the moment it exists rather than only after somebody talks to it.
	if got := conv.ProviderConversationID(); got != "sess-fixed-0001" {
		t.Fatalf("provider conversation id = %q", got)
	}
}

// AO's session env map is sparse — it is an OVERLAY the terminal path applies on
// top of an inherited environment. Handing exec.Cmd that map alone starts the
// agent with no HOME, and Claude reads its login from ~/.claude.json: every turn
// then fails with "Not logged in" on a machine where the CLI works fine. That is
// how this was found, so it is pinned here.
func TestChildEnvironmentIsAnOverlayNotAReplacement(t *testing.T) {
	t.Setenv("AO_TEST_INHERITED", "from-the-daemon")
	t.Setenv("PATH", "/inherited/bin")

	env := processEnv(map[string]string{
		"AO_SESSION_ID": "sess-1",
		// AO's values win: the HookPATH pin exists precisely to displace whatever
		// `ao` the inherited PATH would resolve to.
		"PATH": "/pinned/bin:/inherited/bin",
	})

	got := map[string]string{}
	for _, kv := range env {
		if idx := strings.IndexByte(kv, '='); idx > 0 {
			got[kv[:idx]] = kv[idx+1:]
		}
	}
	if got["AO_TEST_INHERITED"] != "from-the-daemon" {
		t.Errorf("the inherited environment was dropped: %v", got)
	}
	if got["HOME"] == "" {
		t.Error("HOME is absent, so the agent could not find its own login")
	}
	if got["AO_SESSION_ID"] != "sess-1" {
		t.Errorf("AO's own variables were lost: %v", got)
	}
	if got["PATH"] != "/pinned/bin:/inherited/bin" {
		t.Errorf("PATH = %q, want AO's pin to win", got["PATH"])
	}
}

// AO's default means "whatever the user configured", exactly as the TUI launch
// does. Emitting a mode here would make chat quietly stricter or laxer than the
// terminal for the same setting.
func TestDefaultPermissionModeEmitsNoFlag(t *testing.T) {
	d, _, args := newHarness(t, fakePlugin{bin: "claude"})
	if _, err := d.Start(context.Background(), ports.ChatStartConfig{
		WorkspacePath: "/tmp/workspace",
		Permissions:   ports.PermissionModeDefault,
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if strings.Contains(strings.Join(*args, " "), "--permission-mode") {
		t.Fatalf("default permissions emitted a mode flag: %v", *args)
	}
}

// The CLI resolves a relative cwd against its own process directory, which would
// silently put the agent in the wrong tree.
func TestStartRejectsARelativeWorkspace(t *testing.T) {
	d, _, _ := newHarness(t, fakePlugin{bin: "claude"})
	if _, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "relative/path"}); err == nil {
		t.Fatal("a relative workspace path was accepted")
	}
}

func TestResumeWithoutAStoredIDFails(t *testing.T) {
	d, _, _ := newHarness(t, fakePlugin{bin: "claude"})
	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{WorkspacePath: "/tmp/workspace"})
	if !errors.Is(err, ports.ErrChatResumeFailed) {
		t.Fatalf("Resume error = %v, want ErrChatResumeFailed", err)
	}
}

// A session id the CLI does not have makes it print to stderr and exit before
// answering anything, so the handshake fails. Reported as a resume failure with
// the CLI's own words, and never as a fresh conversation: silently starting one
// would present unrelated history as continuous.
func TestResumeReportsTheCLIsOwnRefusal(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	cli.stderr = "No conversation found with session ID: 9d01e995"
	// Close the CLI's end so the handshake sees the process gone, which is what a
	// bad --resume actually does.
	_ = cli.toClient.Close()

	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		ProviderConversationID: "9d01e995",
		WorkspacePath:          "/tmp/workspace",
	})
	if !errors.Is(err, ports.ErrChatResumeFailed) {
		t.Fatalf("Resume error = %v, want ErrChatResumeFailed", err)
	}
	if !strings.Contains(err.Error(), "No conversation found") {
		t.Fatalf("Resume error = %v, want the CLI's own explanation", err)
	}
}

func TestResumeKeepsTheStoredSessionID(t *testing.T) {
	d, _, args := newHarness(t, fakePlugin{bin: "claude"})
	conv, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		ProviderConversationID: "sess-stored",
		WorkspacePath:          "/tmp/workspace",
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	t.Cleanup(func() { _ = conv.Close() })

	if got := conv.ProviderConversationID(); got != "sess-stored" {
		t.Fatalf("resumed conversation id = %q", got)
	}
	joined := strings.Join(*args, " ")
	if !strings.Contains(joined, "--resume=sess-stored") {
		t.Fatalf("resume args = %v", *args)
	}
	// --fork-session would mint a new id, which is the wrong thing for a restart:
	// AO has the old one persisted and could never resume twice.
	if strings.Contains(joined, "--fork-session") {
		t.Fatalf("resume forked the session: %v", *args)
	}
}

func TestSendTurnWritesAUserFrameAndMintsATurnID(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	ref, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text:            "hello",
		ClientMessageID: "client-1",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	if ref.ProviderTurnID == "" {
		// The CLI has no turn identity, so AO's minted id is the only handle an
		// interrupt or a settle can use.
		t.Fatal("SendTurn returned no turn id")
	}
	// Unique across processes, not just within one. AO's store holds provider turn
	// ids unique per conversation and a conversation outlives its process, so a
	// per-process counter collides with the previous run's first turn after a
	// restart — which is how the restart scenario failed.
	if !strings.HasPrefix(ref.ProviderTurnID, "ao-") || len(ref.ProviderTurnID) < 20 {
		t.Fatalf("turn id %q is not a process-unique AO id", ref.ProviderTurnID)
	}

	frame := cli.nextFrame(t)
	if frame.Type != "user" {
		t.Fatalf("frame type = %q, want user: %s", frame.Type, frame.Raw)
	}
	if !strings.Contains(frame.Raw, `"text":"hello"`) {
		t.Fatalf("user frame = %s", frame.Raw)
	}

	// The turn is already correlated before the CLI says anything, so the first
	// frame it sends lands on the right turn.
	cli.push(fixtureInit)
	started := waitForKind(t, conv, ports.ChatEventTurnStarted)
	if started.ProviderTurnID != ref.ProviderTurnID {
		t.Fatalf("turn started as %q, want %q", started.ProviderTurnID, ref.ProviderTurnID)
	}
}

// There is no keystroke concept on this wire: an empty message is a caller bug,
// not a way to nudge the agent.
func TestSendTurnRejectsAnEmptyMessage(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "   "}); err == nil {
		t.Fatal("an empty message was accepted")
	}
}

// The CLI refuses an escalation to bypassPermissions unless the process was
// launched permissively. Running the turn anyway under the old posture would use
// a policy the user did not choose, so the send fails instead.
func TestSendTurnFailsWhenTheCLIRefusesTheRequestedPosture(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	cli.replyError("set_permission_mode",
		"Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions")

	_, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text:     "go wild",
		Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeBypassPermissions},
	})
	if err == nil {
		t.Fatal("a refused permission escalation still dispatched the turn")
	}
	if !strings.Contains(err.Error(), "dangerously-skip-permissions") {
		t.Fatalf("error = %v, want the CLI's own explanation", err)
	}
}

// The full approval round trip: the CLI asks, AO renders the decisions the CLI
// offered, and the answer goes back as the CLI's own payload.
func TestApprovalRoundTrip(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	// Captured verbatim from claude 2.1.220 under --permission-mode manual.
	cli.push(`{"type":"control_request","request_id":"3a0f8b3f-09bb-43ab-bac4-e772843f088c","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/tmp/aoprobe/notes.txt","content":"hello\n"},"description":"notes.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_014VHv13tXWVbZmCNhbkYib3"}}`)

	ask := waitForKind(t, conv, ports.ChatEventApprovalRequested)
	if ask.RequestID != "3a0f8b3f-09bb-43ab-bac4-e772843f088c" {
		t.Fatalf("request id = %q", ask.RequestID)
	}
	// Its own row, keyed on the request id. Keying it on the tool_use instead made
	// the store's upsert overwrite only status and summary, so the request id was
	// never persisted and the card could not be answered.
	if ask.ProviderItemID != ask.RequestID {
		t.Errorf("approval item id = %q, want the request id %q", ask.ProviderItemID, ask.RequestID)
	}
	// One kind for every ask: the CLI has one ask type, and a pending approval that
	// is filed under some other kind is not discoverable as an approval.
	if ask.ActivityKind != domain.ActivityKindApproval {
		t.Errorf("approval kind = %q, want approval", ask.ActivityKind)
	}
	// The tool call it is about still travels, so a client can tie the card back to
	// the activity the tool_use created.
	if !strings.Contains(string(ask.Detail), `"toolUseId":"toolu_014VHv13tXWVbZmCNhbkYib3"`) {
		t.Errorf("approval detail lost the tool use it is about: %s", ask.Detail)
	}

	offered := map[string]bool{}
	for _, option := range ask.Decisions {
		offered[option.ID] = true
	}
	// allow and deny are the protocol's own two behaviors; the third comes from
	// the CLI's suggestion and would not exist if the CLI had not offered it.
	for _, want := range []string{"allow", "deny", "allowAndSetMode:acceptEdits"} {
		if !offered[want] {
			t.Fatalf("decision %q was not offered; got %v", want, offered)
		}
	}

	if err := conv.ResolveRequest(context.Background(), ask.RequestID,
		ports.ChatDecision{ID: "allowAndSetMode:acceptEdits"}); err != nil {
		t.Fatalf("ResolveRequest: %v", err)
	}

	reply := cli.nextFrame(t)
	if reply.Type != "control_response" {
		t.Fatalf("reply type = %q: %s", reply.Type, reply.Raw)
	}
	if !strings.Contains(reply.Raw, `"behavior":"allow"`) {
		t.Fatalf("reply did not allow: %s", reply.Raw)
	}
	// The CLI's own amendment, echoed back untouched. A client that only knew the
	// decision's id could not reconstruct it, so AO must not compose its own
	// version of the user's consent.
	if !strings.Contains(reply.Raw, `"updatedPermissions"`) ||
		!strings.Contains(reply.Raw, `"mode":"acceptEdits"`) {
		t.Fatalf("reply lost the CLI's suggestion: %s", reply.Raw)
	}
}

// A decision the CLI did not offer is refused AND the request stays parked.
// Forwarding an invented decision is consent AO made up; consuming the request on
// a bad one would leave the user's real answer with nothing left to answer.
func TestResolveRefusesAnUnofferedDecisionAndKeepsTheRequest(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	cli.push(`{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"},"tool_use_id":"toolu_01"}}`)
	ask := waitForKind(t, conv, ports.ChatEventApprovalRequested)

	err := conv.ResolveRequest(context.Background(), ask.RequestID, ports.ChatDecision{ID: "allowForever"})
	if !errors.Is(err, ports.ErrChatDecisionNotOffered) {
		t.Fatalf("error = %v, want ErrChatDecisionNotOffered", err)
	}

	// Still answerable with a real decision.
	if err := conv.ResolveRequest(context.Background(), ask.RequestID, ports.ChatDecision{ID: "deny"}); err != nil {
		t.Fatalf("the request was consumed by a bad decision: %v", err)
	}
	reply := cli.nextFrame(t)
	if !strings.Contains(reply.Raw, `"behavior":"deny"`) {
		t.Fatalf("reply = %s", reply.Raw)
	}
}

// Two clients looking at the same approval is normal, so one arriving second is
// an ordinary outcome and not an internal failure.
func TestResolveRefusesAnUnknownRequest(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	err := conv.ResolveRequest(context.Background(), "never-existed", ports.ChatDecision{ID: "allow"})
	if !errors.Is(err, ports.ErrChatRequestNotPending) {
		t.Fatalf("error = %v, want ErrChatRequestNotPending", err)
	}
}

// A request AO does not model is refused with an error, never with a fabricated
// decision. request_user_dialog is the one that would actually arrive.
func TestUnmodelledControlRequestsAreRefused(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	_ = startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	cli.push(`{"type":"control_request","request_id":"dlg-1","request":{"subtype":"request_user_dialog","dialog_kind":"refusal_fallback_prompt","payload":{}}}`)

	reply := cli.nextFrame(t)
	if !strings.Contains(reply.Raw, `"subtype":"error"`) {
		t.Fatalf("an unmodelled request was answered: %s", reply.Raw)
	}
}

// Pressing stop a moment too late is an ordinary thing for a person to do, so it
// is reported as "nothing to cancel" rather than as an internal failure. AO has
// to make that call itself: the CLI's interrupt takes no turn id and answers
// success either way.
func TestInterruptWithoutALiveTurn(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	if err := conv.Interrupt(context.Background(), ""); !errors.Is(err, ports.ErrChatNoActiveTurn) {
		t.Fatalf("error = %v, want ErrChatNoActiveTurn", err)
	}
	if err := conv.Interrupt(context.Background(), "ao-turn-99"); !errors.Is(err, ports.ErrChatNoActiveTurn) {
		t.Fatalf("stale turn interrupt = %v, want ErrChatNoActiveTurn", err)
	}
	if cli.sentSubtype("interrupt") {
		t.Fatal("an interrupt was sent for a turn that is not running")
	}
}

func TestInterruptCancelsTheLiveTurn(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	// The CLI's own receipt shape, from the interrupt_receipt_v1 capability.
	cli.reply("interrupt", `{"still_queued":[]}`)

	ref, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "count to a thousand"})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	cli.nextFrame(t) // the user frame

	if err := conv.Interrupt(context.Background(), ref.ProviderTurnID); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	sent := cli.waitForSubtype(t, "interrupt")
	// cancel_queued is deliberately absent: AO runs its own queue and drains it a
	// turn at a time, so the CLI never holds queued work of its own.
	if strings.Contains(sent.Raw, "cancel_queued") {
		t.Fatalf("interrupt claimed a queue AO does not use: %s", sent.Raw)
	}
}

// Once the turn is over there is nothing to cancel, and the CLI cannot say so:
// its interrupt takes no turn id and answers success either way. So a stop that
// arrives after the result must be refused here, or the CLI would abort whatever
// turn happens to be running next.
func TestInterruptAfterTheTurnEndedIsRefused(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	ref, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "hello"})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	cli.nextFrame(t) // the user frame

	cli.push(fixtureInit)
	waitForKind(t, conv, ports.ChatEventTurnStarted)
	cli.push(fixtureResultSuccess)
	waitForKind(t, conv, ports.ChatEventTurnCompleted)

	if err := conv.Interrupt(context.Background(), ref.ProviderTurnID); !errors.Is(err, ports.ErrChatNoActiveTurn) {
		t.Fatalf("error = %v, want ErrChatNoActiveTurn", err)
	}
	if cli.sentSubtype("interrupt") {
		t.Fatal("an interrupt was sent for a turn that had already finished")
	}
}

func TestListModelsReadsTheAccountsCatalog(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	// Captured verbatim from a list_models control response.
	cli.reply("list_models", `{"models":[{"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default (recommended)","description":"Opus 5 with 1M context","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true},{"value":"haiku","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku","description":"Haiku 4.5"}]}`)

	lister, ok := conv.(ports.ChatModelLister)
	if !ok {
		t.Fatal("conversation does not list models")
	}
	models, err := lister.ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("got %d models: %+v", len(models), models)
	}
	if models[0].ID != "default" || !models[0].Default {
		t.Errorf("first model = %+v, want the CLI's own default entry", models[0])
	}
	if len(models[0].Efforts) != 5 {
		t.Errorf("effort levels = %v", models[0].Efforts)
	}
	// A model that takes no effort must not be offered one.
	if len(models[1].Efforts) != 0 {
		t.Errorf("haiku offered efforts it does not support: %v", models[1].Efforts)
	}
}

func TestReadRateLimitsReportsBothWindows(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	// Captured verbatim from a get_usage control response (reset instants pushed
	// into the future so the remaining-duration assertion does not rot).
	//
	// The siblings matter as much as the two windows do: rate_limits is NOT a
	// uniform map. It carries window objects, nulls for windows this account has no
	// entitlement for, unrelated objects (extra_usage, spend), arrays (limits,
	// model_scoped), and a bare bool. An earlier build typed it as a map of windows
	// and the whole read failed on the first array — a bug the live test caught and
	// this fixture now holds in place.
	cli.reply("get_usage", `{"session":{"total_cost_usd":0.61},"subscription_type":"team","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":64,"resets_at":"2036-08-02T15:40:00.169357+00:00","limit_dollars":null,"used_dollars":null},"seven_day":{"utilization":74,"resets_at":"2036-08-04T05:00:00.169378+00:00"},"seven_day_opus":null,"tangelo":null,"extra_usage":{"is_enabled":true,"monthly_limit":12000,"used_credits":0,"utilization":null},"limits":[{"kind":"session","group":"session","percent":64,"severity":"normal","resets_at":"2036-08-02T15:40:00.169357+00:00","scope":null,"is_active":false}],"spend":{"used":{"amount_minor":0,"currency":"USD","exponent":2},"percent":0},"member_dashboard_available":false,"model_scoped":[{"display_name":"Fable","utilization":0,"resets_at":null}]}}`)

	reporter, ok := conv.(ports.ChatUsageReporter)
	if !ok {
		t.Fatal("conversation does not report rate limits")
	}
	limits, err := reporter.ReadRateLimits(context.Background())
	if err != nil {
		t.Fatalf("ReadRateLimits: %v", err)
	}
	if limits.PrimaryUsedPercent != 64 || limits.SecondaryUsedPercent != 74 {
		t.Errorf("limits = %+v", limits)
	}
	if limits.PlanLabel != "team" {
		t.Errorf("plan label = %q", limits.PlanLabel)
	}
	if limits.PrimaryResetsInSeconds <= 0 {
		t.Errorf("primary reset = %ds, want a future instant", limits.PrimaryResetsInSeconds)
	}
}

// Compaction rides a "/compact" turn because the control channel has no subtype
// for it. The turn still has to be minted, or the frames it produces would be
// correlated to nothing.
func TestCompactSendsASlashCommandTurn(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	cli.reply("get_context_usage", `{"totalTokens":70309,"maxTokens":1000000,"percentage":7}`)

	compactor, ok := conv.(ports.ChatCompactor)
	if !ok {
		t.Fatal("conversation does not compact")
	}
	result, err := compactor.Compact(context.Background())
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if result.TokensBefore != 70309 {
		t.Errorf("tokens before = %d, want the CLI's own context read", result.TokensBefore)
	}

	for {
		frame := cli.nextFrame(t)
		if frame.Type != "user" {
			continue
		}
		if !strings.Contains(frame.Raw, `"/compact"`) {
			t.Fatalf("compaction sent %s", frame.Raw)
		}
		break
	}

	// The compaction is a turn AO never recorded, so the Chat controller adopts it
	// off this event. Without a turn id there would be nothing to adopt.
	cli.push(fixtureInit)
	started := waitForKind(t, conv, ports.ChatEventTurnStarted)
	if started.ProviderTurnID == "" {
		t.Fatal("the compaction turn carried no id")
	}
}

// A silent channel close is indistinguishable from an idle agent, so the end of
// the connection is reported explicitly — with whatever the CLI said on its way
// out, since that is the only account of a startup refusal.
func TestControllerStopReportsTheCLIsLastWords(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	cli.stderr = "Error: something went wrong"
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	_ = cli.toClient.Close()

	ev := waitForKind(t, conv, ports.ChatEventControllerState)
	if ev.ControllerState != ports.ChatControllerStopped {
		t.Fatalf("state = %q", ev.ControllerState)
	}
	if ev.Err == nil || !strings.Contains(ev.Err.Error(), "something went wrong") {
		t.Fatalf("stop event err = %v, want the CLI's stderr", ev.Err)
	}
}

// A parked approval must not outlive the controller: the handler is blocking a
// goroutine, and a decision arriving afterwards has nothing to answer.
func TestCloseUnblocksParkedApprovals(t *testing.T) {
	d, cli, _ := newHarness(t, fakePlugin{bin: "claude"})
	conv := startConversation(t, d)
	cli.waitForSubtype(t, "initialize")

	cli.push(`{"type":"control_request","request_id":"req-9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"toolu_09"}}`)
	ask := waitForKind(t, conv, ports.ChatEventApprovalRequested)

	if err := conv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := conv.ResolveRequest(context.Background(), ask.RequestID, ports.ChatDecision{ID: "allow"}); err == nil {
		t.Fatal("a decision was accepted after the conversation closed")
	}
}
