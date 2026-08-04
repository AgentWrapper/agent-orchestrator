package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeAgent struct {
	conn *acpsdk.AgentSideConnection

	mu        sync.Mutex
	newParams acpsdk.NewSessionRequest
	mode      string
	options   map[string]string
	newConfig []acpsdk.SessionConfigOption
	setConfig []acpsdk.SessionConfigOption
	setCalls  int
	steering  bool
	steerText string
	steerMeta map[string]any
	steerOut  string
}

var _ acpsdk.Agent = (*fakeAgent)(nil)

func (a *fakeAgent) Authenticate(context.Context, acpsdk.AuthenticateRequest) (acpsdk.AuthenticateResponse, error) {
	return acpsdk.AuthenticateResponse{}, nil
}
func (a *fakeAgent) Initialize(context.Context, acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	meta := map[string]any(nil)
	if a.steering {
		meta = map[string]any{"steering": map[string]any{"supported": true}}
	}
	return acpsdk.InitializeResponse{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		Meta:            meta,
		AgentCapabilities: acpsdk.AgentCapabilities{
			SessionCapabilities: acpsdk.SessionCapabilities{Resume: &acpsdk.SessionResumeCapabilities{}},
		},
	}, nil
}

func (a *fakeAgent) HandleExtensionMethod(_ context.Context, method string, raw json.RawMessage) (any, error) {
	if method != steeringMethod {
		return nil, acpsdk.NewMethodNotFound(method)
	}
	var params struct {
		Prompt []acpsdk.ContentBlock `json:"prompt"`
		Meta   map[string]any        `json:"_meta"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, err
	}
	text := ""
	if len(params.Prompt) > 0 && params.Prompt[0].Text != nil {
		text = params.Prompt[0].Text.Text
	}
	a.mu.Lock()
	a.steerText = text
	a.steerMeta = params.Meta
	outcome := a.steerOut
	a.mu.Unlock()
	if outcome == "" {
		outcome = "injected"
	}
	return steeringResponse{Outcome: outcome}, nil
}
func (a *fakeAgent) Logout(context.Context, acpsdk.LogoutRequest) (acpsdk.LogoutResponse, error) {
	return acpsdk.LogoutResponse{}, nil
}
func (a *fakeAgent) Cancel(context.Context, acpsdk.CancelNotification) error { return nil }
func (a *fakeAgent) CloseSession(context.Context, acpsdk.CloseSessionRequest) (acpsdk.CloseSessionResponse, error) {
	return acpsdk.CloseSessionResponse{}, nil
}
func (a *fakeAgent) ListSessions(context.Context, acpsdk.ListSessionsRequest) (acpsdk.ListSessionsResponse, error) {
	return acpsdk.ListSessionsResponse{}, nil
}
func (a *fakeAgent) NewSession(_ context.Context, params acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	a.mu.Lock()
	a.newParams = params
	a.mu.Unlock()
	return acpsdk.NewSessionResponse{SessionId: "claude-session-1", ConfigOptions: a.newConfig}, nil
}
func (a *fakeAgent) ResumeSession(context.Context, acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.ResumeSessionResponse{}, nil
}
func (a *fakeAgent) SetSessionConfigOption(_ context.Context, params acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	a.mu.Lock()
	a.setCalls++
	if params.ValueId != nil {
		if a.options == nil {
			a.options = make(map[string]string)
		}
		a.options[string(params.ValueId.ConfigId)] = string(params.ValueId.Value)
	}
	if params.Boolean != nil {
		if a.options == nil {
			a.options = make(map[string]string)
		}
		a.options[string(params.Boolean.ConfigId)] = fmt.Sprintf("%t", params.Boolean.Value)
	}
	response := append([]acpsdk.SessionConfigOption(nil), a.setConfig...)
	a.mu.Unlock()
	return acpsdk.SetSessionConfigOptionResponse{ConfigOptions: response}, nil
}
func (a *fakeAgent) SetSessionMode(_ context.Context, params acpsdk.SetSessionModeRequest) (acpsdk.SetSessionModeResponse, error) {
	a.mu.Lock()
	a.mode = string(params.ModeId)
	a.mu.Unlock()
	return acpsdk.SetSessionModeResponse{}, nil
}
func (a *fakeAgent) Prompt(ctx context.Context, params acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	_ = a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{
		SessionId: params.SessionId,
		Update:    acpsdk.UpdateAgentMessageText("working"),
	})
	permission, err := a.conn.RequestPermission(ctx, acpsdk.RequestPermissionRequest{
		SessionId: params.SessionId,
		ToolCall: acpsdk.ToolCallUpdate{
			ToolCallId: "tool-1", Title: acpsdk.Ptr("Edit file"), Kind: acpsdk.Ptr(acpsdk.ToolKindEdit),
		},
		Options: []acpsdk.PermissionOption{
			{OptionId: "allow", Name: "Allow", Kind: acpsdk.PermissionOptionKindAllowOnce},
			{OptionId: "reject", Name: "Reject", Kind: acpsdk.PermissionOptionKindRejectOnce},
		},
	})
	if err != nil {
		return acpsdk.PromptResponse{}, err
	}
	if permission.Outcome.Selected != nil {
		_ = a.conn.SessionUpdate(ctx, acpsdk.SessionNotification{
			SessionId: params.SessionId,
			Update:    acpsdk.UpdateAgentMessageText(" done"),
		})
	}
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
}

func TestACPDriverDefersPromptUntilDurableTurnBinding(t *testing.T) {
	agent := &fakeAgent{}
	driver := New(Config{
		Harness: domain.HarnessClaudeCode,
		Capabilities: ports.ChatCapabilities{
			ports.ChatCapabilityStreaming: true, ports.ChatCapabilityApprovals: true,
			ports.ChatCapabilityInterrupt: true, ports.ChatCapabilityResume: true,
		},
		Probe: func(context.Context) error { return nil },
		Launch: func(context.Context, string, map[string]string) (Launch, error) {
			return Launch{Command: "fake"}, nil
		},
		NewSessionMeta: func(ports.ChatStartConfig) map[string]any {
			return map[string]any{"systemPrompt": map[string]any{"append": "AO instructions"}}
		},
		SessionMode: func(permission ports.PermissionMode) string {
			if permission == ports.PermissionModeAcceptEdits {
				return "acceptEdits"
			}
			return ""
		},
		SessionOptions: func(settings ports.ChatTurnSettings) []SessionOption {
			if settings.Model == "" {
				return nil
			}
			return []SessionOption{{ID: "model", Value: settings.Model}}
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	driver.spawn = fakeSpawn(agent)

	conversation, err := driver.Start(context.Background(), ports.ChatStartConfig{
		WorkspacePath: t.TempDir(), SystemPrompt: "AO instructions",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer conversation.Close()
	if got := conversation.ProviderConversationID(); got != "claude-session-1" {
		t.Fatalf("provider conversation id = %q", got)
	}
	agent.mu.Lock()
	meta := agent.newParams.Meta
	agent.mu.Unlock()
	if meta["systemPrompt"] == nil {
		t.Fatal("session/new did not receive provider metadata")
	}

	// Consume controller.ready from session setup.
	_ = nextEvent(t, conversation.Events())
	ref, err := conversation.SendTurn(context.Background(), ports.ChatUserMessage{
		Text: "change it", Settings: ports.ChatTurnSettings{
			Model: "test-model", Approval: ports.PermissionModeAcceptEdits,
		},
	})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	select {
	case event := <-conversation.Events():
		t.Fatalf("event %q arrived before StartDeferredTurn; it could race durable binding", event.Kind)
	case <-time.After(30 * time.Millisecond):
	}
	agent.mu.Lock()
	mode, model := agent.mode, agent.options["model"]
	agent.mu.Unlock()
	if mode != "acceptEdits" || model != "test-model" {
		t.Fatalf("ACP settings = mode %q, model %q", mode, model)
	}
	deferred := conversation.(ports.ChatDeferredTurnStarter)
	if err := deferred.StartDeferredTurn(ref.ProviderTurnID); err != nil {
		t.Fatalf("StartDeferredTurn: %v", err)
	}

	var approvalID string
	for approvalID == "" {
		event := nextEvent(t, conversation.Events())
		if event.ProviderTurnID != "" && event.ProviderTurnID != ref.ProviderTurnID {
			t.Fatalf("event turn id = %q, want %q", event.ProviderTurnID, ref.ProviderTurnID)
		}
		if event.Kind == ports.ChatEventApprovalRequested {
			approvalID = event.RequestID
			if len(event.Decisions) != 2 || event.Decisions[0].ID != "allow" {
				t.Fatalf("approval decisions = %#v", event.Decisions)
			}
		}
	}
	if err := conversation.ResolveRequest(context.Background(), approvalID, ports.ChatDecision{ID: "allow"}); err != nil {
		t.Fatalf("ResolveRequest: %v", err)
	}

	var completed bool
	for !completed {
		event := nextEvent(t, conversation.Events())
		if event.Kind == ports.ChatEventTurnCompleted {
			completed = true
			if event.TurnState != domain.TurnStateCompleted {
				t.Fatalf("turn state = %q", event.TurnState)
			}
		}
	}
}

func TestACPDriverExposesAndMutatesAdvertisedConfigOptions(t *testing.T) {
	initial := []acpsdk.SessionConfigOption{
		selectConfigOption("model", "Model", "model", "sonnet", "sonnet", "opus"),
		booleanConfigOption("fast", "Fast mode", true),
	}
	agent := &fakeAgent{
		newConfig: initial,
		setConfig: []acpsdk.SessionConfigOption{
			selectConfigOption("model", "Model", "model", "opus", "sonnet", "opus"),
			selectConfigOption("effort", "Effort", "thought_level", "high", "low", "high"),
			booleanConfigOption("fast", "Fast mode", true),
		},
	}
	driver := New(Config{
		Harness:      domain.HarnessClaudeCode,
		Capabilities: ports.ChatCapabilities{ports.ChatCapabilityStreaming: true},
		Probe:        func(context.Context) error { return nil },
		Launch: func(context.Context, string, map[string]string) (Launch, error) {
			return Launch{Command: "fake"}, nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	driver.spawn = fakeSpawn(agent)

	conv, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir()})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer conv.Close()
	configurer := conv.(ports.ChatConfigOptionController)
	if !conv.Capabilities()[ports.ChatCapabilityConfigOptions] {
		t.Fatal("config_options capability was not advertised")
	}

	options, err := configurer.ListConfigOptions(context.Background())
	if err != nil {
		t.Fatalf("ListConfigOptions: %v", err)
	}
	if len(options) != 2 || options[0].Current.Select != "sonnet" {
		t.Fatalf("initial options = %#v", options)
	}
	if options[1].Current.Boolean == nil || !*options[1].Current.Boolean {
		t.Fatalf("boolean option = %#v", options[1])
	}

	if _, err := configurer.SetConfigOption(context.Background(), "model", ports.ChatConfigOptionValue{Select: "unknown"}); !errors.Is(err, ports.ErrChatConfigOptionInvalid) {
		t.Fatalf("invalid selection error = %v", err)
	}
	options, err = configurer.SetConfigOption(context.Background(), "model", ports.ChatConfigOptionValue{Select: "opus"})
	if err != nil {
		t.Fatalf("SetConfigOption: %v", err)
	}
	if len(options) != 3 || options[0].Current.Select != "opus" || options[1].Category != "thought_level" {
		t.Fatalf("replacement options = %#v", options)
	}
	agent.mu.Lock()
	gotValue, calls := agent.options["model"], agent.setCalls
	agent.mu.Unlock()
	if gotValue != "opus" || calls != 1 {
		t.Fatalf("agent received model = %q across %d calls", gotValue, calls)
	}
}

func TestACPDriverExposesDynamicAvailableCommandsAsSkills(t *testing.T) {
	agent := &fakeAgent{}
	driver := New(Config{
		Harness:      domain.HarnessClaudeCode,
		Capabilities: ports.ChatCapabilities{ports.ChatCapabilityStreaming: true},
		Probe:        func(context.Context) error { return nil },
		Launch: func(context.Context, string, map[string]string) (Launch, error) {
			return Launch{Command: "fake"}, nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	driver.spawn = fakeSpawn(agent)

	conv, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir()})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer conv.Close()
	lister := conv.(ports.ChatSkillLister)

	if err := agent.conn.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(conv.ProviderConversationID()),
		Update: acpsdk.SessionUpdate{AvailableCommandsUpdate: &acpsdk.SessionAvailableCommandsUpdate{
			SessionUpdate: "available_commands_update",
			AvailableCommands: []acpsdk.AvailableCommand{{
				Name: "review", Description: "Review a pull request",
				Input: &acpsdk.AvailableCommandInput{Unstructured: &acpsdk.UnstructuredCommandInput{Hint: "<number>"}},
			}},
		}},
	}); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	skills := awaitSkillCount(t, lister, 1)
	if len(skills) != 1 || skills[0] != (ports.ChatSkill{
		Name: "review", DisplayName: "review", Description: "Review a pull request",
		InputHint: "<number>", Source: "agent",
	}) {
		t.Fatalf("skills = %#v", skills)
	}
	if !conv.Capabilities()[ports.ChatCapabilitySkills] {
		t.Fatal("skills capability was not advertised after the command catalog arrived")
	}

	// ACP updates are snapshots. An empty update removes commands that are no
	// longer available but keeps the feature known, so the UI can render no menu.
	if err := agent.conn.SessionUpdate(context.Background(), acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(conv.ProviderConversationID()),
		Update: acpsdk.SessionUpdate{AvailableCommandsUpdate: &acpsdk.SessionAvailableCommandsUpdate{
			SessionUpdate:     "available_commands_update",
			AvailableCommands: []acpsdk.AvailableCommand{},
		}},
	}); err != nil {
		t.Fatalf("empty SessionUpdate: %v", err)
	}
	skills = awaitSkillCount(t, lister, 0)
	if len(skills) != 0 {
		t.Fatalf("skills after replacement = %#v, want empty", skills)
	}
}

func awaitSkillCount(t *testing.T, lister ports.ChatSkillLister, want int) []ports.ChatSkill {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		skills, err := lister.ListSkills(context.Background())
		if err != nil {
			t.Fatalf("ListSkills: %v", err)
		}
		if len(skills) == want {
			return skills
		}
		if time.Now().After(deadline) {
			t.Fatalf("skills = %#v, want %d", skills, want)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestACPDriverMapsAdvertisedSteeringOntoAO(t *testing.T) {
	agent := &fakeAgent{steering: true}
	driver := New(Config{
		Harness:      domain.HarnessClaudeCode,
		Capabilities: ports.ChatCapabilities{ports.ChatCapabilityStreaming: true},
		Probe:        func(context.Context) error { return nil },
		Launch: func(context.Context, string, map[string]string) (Launch, error) {
			return Launch{Command: "fake"}, nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	driver.spawn = fakeSpawn(agent)

	opened, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir()})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer opened.Close()
	if !opened.Capabilities()[ports.ChatCapabilitySteer] {
		t.Fatal("steer capability was not derived from ACP initialize metadata")
	}
	conv := opened.(*conversation)
	conv.mu.Lock()
	conv.activeTurn = "turn-1"
	conv.mu.Unlock()

	ref, err := conv.Steer(context.Background(), "turn-1", ports.ChatUserMessage{Text: "focus on the API"})
	if err != nil {
		t.Fatalf("Steer: %v", err)
	}
	if ref.ProviderTurnID != "turn-1" {
		t.Fatalf("steered turn = %q, want turn-1", ref.ProviderTurnID)
	}
	agent.mu.Lock()
	text, meta := agent.steerText, agent.steerMeta
	agent.mu.Unlock()
	if text != "focus on the API" {
		t.Fatalf("steer text = %q", text)
	}
	steering, _ := meta["steering"].(map[string]any)
	if steering["idleBehavior"] != "promptRequired" {
		t.Fatalf("steering meta = %#v", meta)
	}

	agent.mu.Lock()
	agent.steerOut = "promptRequired"
	agent.mu.Unlock()
	if _, err := conv.Steer(context.Background(), "turn-1", ports.ChatUserMessage{Text: "too late"}); !errors.Is(err, ports.ErrChatNoSteerableTurn) {
		t.Fatalf("late steer error = %v, want ErrChatNoSteerableTurn", err)
	}
	if _, err := conv.Steer(context.Background(), "other-turn", ports.ChatUserMessage{Text: "wrong turn"}); !errors.Is(err, ports.ErrChatNoSteerableTurn) {
		t.Fatalf("wrong-turn steer error = %v, want ErrChatNoSteerableTurn", err)
	}
}

func selectConfigOption(id, name, category, current string, values ...string) acpsdk.SessionConfigOption {
	categoryValue := acpsdk.SessionConfigOptionCategory(category)
	choices := make(acpsdk.SessionConfigSelectOptionsUngrouped, 0, len(values))
	for _, value := range values {
		choices = append(choices, acpsdk.SessionConfigSelectOption{
			Value: acpsdk.SessionConfigValueId(value), Name: value,
		})
	}
	return acpsdk.SessionConfigOption{Select: &acpsdk.SessionConfigOptionSelect{
		Id: acpsdk.SessionConfigId(id), Name: name, Category: &categoryValue,
		CurrentValue: acpsdk.SessionConfigValueId(current),
		Options:      acpsdk.SessionConfigSelectOptions{Ungrouped: &choices},
		Type:         "select",
	}}
}

func booleanConfigOption(id, name string, current bool) acpsdk.SessionConfigOption {
	return acpsdk.SessionConfigOption{Boolean: &acpsdk.SessionConfigOptionBoolean{
		Id: acpsdk.SessionConfigId(id), Name: name, CurrentValue: current, Type: "boolean",
	}}
}

func fakeSpawn(agent *fakeAgent) spawnFunc {
	return func(Launch, string) (*process, error) {
		clientToAgentR, clientToAgentW := io.Pipe()
		agentToClientR, agentToClientW := io.Pipe()
		agent.conn = acpsdk.NewAgentSideConnection(agent, agentToClientW, clientToAgentR)
		var once sync.Once
		return &process{
			stdin: clientToAgentW, stdout: agentToClientR,
			stop: func() error {
				once.Do(func() {
					_ = clientToAgentW.Close()
					_ = clientToAgentR.Close()
					_ = agentToClientW.Close()
					_ = agentToClientR.Close()
				})
				return nil
			},
		}, nil
	}
}

func nextEvent(t *testing.T, events <-chan ports.ChatEvent) ports.ChatEvent {
	t.Helper()
	select {
	case event, ok := <-events:
		if !ok {
			t.Fatal("event stream closed")
		}
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for event")
		return ports.ChatEvent{}
	}
}
