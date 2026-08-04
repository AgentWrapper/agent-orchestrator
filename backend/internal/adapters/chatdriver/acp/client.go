package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// AO deliberately advertises neither client-side filesystem nor terminal
// capabilities. Claude's ACP adapter uses Claude Code's native tools inside the
// worktree; routing those operations through Electron or the daemon would create
// a second execution/security model beside AO's existing one.
func (c *conversation) ReadTextFile(context.Context, acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, errClientCapability
}

func (c *conversation) WriteTextFile(context.Context, acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, errClientCapability
}

func (c *conversation) CreateTerminal(context.Context, acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, errClientCapability
}

func (c *conversation) KillTerminal(context.Context, acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, errClientCapability
}

func (c *conversation) TerminalOutput(context.Context, acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, errClientCapability
}

func (c *conversation) ReleaseTerminal(context.Context, acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, errClientCapability
}

func (c *conversation) WaitForTerminalExit(context.Context, acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, errClientCapability
}

func (c *conversation) RequestPermission(
	ctx context.Context,
	params acpsdk.RequestPermissionRequest,
) (acpsdk.RequestPermissionResponse, error) {
	if len(params.Options) == 0 {
		return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
	}
	requestID := uuid.NewString()
	options := make(map[string]acpsdk.PermissionOption, len(params.Options))
	decisions := make([]ports.ChatDecisionOption, 0, len(params.Options))
	for _, option := range params.Options {
		id := string(option.OptionId)
		options[id] = option
		raw, _ := json.Marshal(option)
		decisions = append(decisions, ports.ChatDecisionOption{ID: id, Label: option.Name, Raw: raw})
	}
	request := &parkedPermission{options: options, result: make(chan string, 1)}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
	}
	c.pending[requestID] = request
	turnID := c.activeTurn
	c.mu.Unlock()

	summary := "Permission required"
	if params.ToolCall.Title != nil && strings.TrimSpace(*params.ToolCall.Title) != "" {
		summary = *params.ToolCall.Title
	}
	c.emit(ports.ChatEvent{
		Kind:           ports.ChatEventApprovalRequested,
		ProviderTurnID: turnID,
		ProviderItemID: string(params.ToolCall.ToolCallId),
		ActivityKind:   activityKindFromTool(pointerValue(params.ToolCall.Kind)),
		ActivityStatus: domain.ActivityStatusPending,
		Summary:        summary,
		RequestID:      requestID,
		Decisions:      decisions,
	})

	timer := timeAfter(approvalWait)
	select {
	case selected := <-request.result:
		if selected == "" {
			return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
		}
		return acpsdk.RequestPermissionResponse{
			Outcome: acpsdk.NewRequestPermissionOutcomeSelected(acpsdk.PermissionOptionId(selected)),
		}, nil
	case <-ctx.Done():
		c.discardPermission(requestID)
		c.emit(ports.ChatEvent{Kind: ports.ChatEventApprovalResolved, RequestID: requestID})
		return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
	case <-timer:
		c.discardPermission(requestID)
		c.emit(ports.ChatEvent{Kind: ports.ChatEventApprovalResolved, RequestID: requestID})
		return acpsdk.RequestPermissionResponse{Outcome: acpsdk.NewRequestPermissionOutcomeCancelled()}, nil
	}
}

// timeAfter is a variable so permission timeout behavior can be tested without
// sleeping for the production interval.
var timeAfter = func(duration time.Duration) <-chan time.Time { return time.After(duration) }

func (c *conversation) discardPermission(requestID string) {
	c.mu.Lock()
	delete(c.pending, requestID)
	c.mu.Unlock()
}

func (c *conversation) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	c.mu.Lock()
	sessionID := c.sessionID
	turnID := c.activeTurn
	c.mu.Unlock()
	if sessionID != "" && string(params.SessionId) != sessionID {
		return fmt.Errorf("ACP update for unexpected session %q", params.SessionId)
	}

	update := params.Update
	switch {
	case update.AgentMessageChunk != nil:
		id := messageID(update.AgentMessageChunk.MessageId, "assistant", turnID)
		if delta := contentText(update.AgentMessageChunk.Content); delta != "" {
			c.mu.Lock()
			c.messages[id] += delta
			c.mu.Unlock()
			c.emit(ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: turnID, ProviderItemID: id, Delta: delta})
		}
	case update.AgentThoughtChunk != nil:
		id := messageID(update.AgentThoughtChunk.MessageId, "thought", turnID)
		if delta := contentText(update.AgentThoughtChunk.Content); delta != "" {
			c.mu.Lock()
			_, existed := c.thoughts[id]
			c.thoughts[id] += delta
			c.mu.Unlock()
			if !existed {
				c.emit(ports.ChatEvent{Kind: ports.ChatEventActivityStarted, ProviderTurnID: turnID,
					ProviderItemID: id, ActivityKind: domain.ActivityKindReasoning,
					ActivityStatus: domain.ActivityStatusRunning, Summary: "Reasoning"})
			}
			c.emit(ports.ChatEvent{Kind: ports.ChatEventReasoningDelta, ProviderTurnID: turnID, ProviderItemID: id, Delta: delta})
		}
	case update.ToolCall != nil:
		tool := &toolState{
			id: string(update.ToolCall.ToolCallId), title: update.ToolCall.Title,
			kind: update.ToolCall.Kind, status: update.ToolCall.Status,
			locations: update.ToolCall.Locations, content: update.ToolCall.Content,
			rawInput: update.ToolCall.RawInput, rawOutput: update.ToolCall.RawOutput,
		}
		c.mu.Lock()
		c.tools[tool.id] = tool
		c.mu.Unlock()
		c.emit(c.toolEvent(turnID, tool, toolTerminal(tool.status)))
		c.emitDiffs(turnID, tool.content)
	case update.ToolCallUpdate != nil:
		tool := c.mergeToolUpdate(update.ToolCallUpdate)
		c.emit(c.toolEvent(turnID, tool, toolTerminal(tool.status)))
		c.emitDiffs(turnID, tool.content)
	case update.Plan != nil:
		c.emit(ports.ChatEvent{Kind: ports.ChatEventPlanUpdated, ProviderTurnID: turnID, Plan: normalizePlan(update.Plan.Entries)})
	case update.SessionInfoUpdate != nil && update.SessionInfoUpdate.Title != nil:
		c.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: *update.SessionInfoUpdate.Title})
	case update.ConfigOptionUpdate != nil:
		// The update is a complete replacement, not a delta. Model changes can
		// rebuild effort and fast-mode choices, including removing an option.
		c.replaceConfigOptions(update.ConfigOptionUpdate.ConfigOptions)
	case update.AvailableCommandsUpdate != nil:
		// Like config options, ACP command updates replace the entire catalog. The
		// provider may discover project commands after session setup or remove one
		// when its configuration changes, so retaining absent entries is wrong.
		c.replaceAvailableCommands(update.AvailableCommandsUpdate.AvailableCommands)
	case update.UsageUpdate != nil:
		c.emit(ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
			ContextUsed: int64(update.UsageUpdate.Used), ContextWindow: int64(update.UsageUpdate.Size),
			ContextKnown: true,
		}})
	}
	return nil
}

func contentText(content acpsdk.ContentBlock) string {
	if content.Text == nil {
		return ""
	}
	return content.Text.Text
}

func messageID(id *string, prefix, turnID string) string {
	if id != nil && *id != "" {
		return *id
	}
	return prefix + "-" + turnID
}

func (c *conversation) mergeToolUpdate(update *acpsdk.SessionToolCallUpdate) *toolState {
	id := string(update.ToolCallId)
	c.mu.Lock()
	defer c.mu.Unlock()
	tool := c.tools[id]
	if tool == nil {
		tool = &toolState{id: id}
		c.tools[id] = tool
	}
	if update.Title != nil {
		tool.title = *update.Title
	}
	if update.Kind != nil {
		tool.kind = *update.Kind
	}
	if update.Status != nil {
		tool.status = *update.Status
	}
	if update.Locations != nil {
		tool.locations = update.Locations
	}
	if update.Content != nil {
		tool.content = update.Content
	}
	if update.RawInput != nil {
		tool.rawInput = update.RawInput
	}
	if update.RawOutput != nil {
		tool.rawOutput = update.RawOutput
	}
	copy := *tool
	return &copy
}

func (c *conversation) toolEvent(turnID string, tool *toolState, completed bool) ports.ChatEvent {
	detail, _ := json.Marshal(map[string]any{
		"protocol": "acp", "toolKind": tool.kind, "locations": tool.locations,
		"input": tool.rawInput, "output": tool.rawOutput, "content": tool.content,
	})
	status := activityStatusFromTool(tool.status)
	kind := ports.ChatEventActivityStarted
	if completed {
		kind = ports.ChatEventActivityCompleted
	}
	summary := strings.TrimSpace(tool.title)
	if summary == "" {
		summary = "Agent tool"
	}
	return ports.ChatEvent{
		Kind: kind, ProviderTurnID: turnID, ProviderItemID: tool.id,
		ActivityKind: activityKindFromTool(tool.kind), ActivityStatus: status,
		Summary: summary, Detail: detail,
	}
}

func activityKindFromTool(kind acpsdk.ToolKind) domain.ActivityKind {
	switch kind {
	case acpsdk.ToolKindExecute:
		return domain.ActivityKindCommand
	case acpsdk.ToolKindEdit, acpsdk.ToolKindDelete, acpsdk.ToolKindMove:
		return domain.ActivityKindFileChange
	case acpsdk.ToolKindThink:
		return domain.ActivityKindReasoning
	default:
		return domain.ActivityKindMCPTool
	}
}

func activityStatusFromTool(status acpsdk.ToolCallStatus) domain.ActivityStatus {
	switch status {
	case acpsdk.ToolCallStatusCompleted:
		return domain.ActivityStatusCompleted
	case acpsdk.ToolCallStatusFailed:
		return domain.ActivityStatusFailed
	case acpsdk.ToolCallStatusPending:
		return domain.ActivityStatusPending
	default:
		return domain.ActivityStatusRunning
	}
}

func toolTerminal(status acpsdk.ToolCallStatus) bool {
	return status == acpsdk.ToolCallStatusCompleted || status == acpsdk.ToolCallStatusFailed
}

func (c *conversation) emitDiffs(turnID string, content []acpsdk.ToolCallContent) {
	files := make([]ports.ChatDiffFile, 0)
	for _, item := range content {
		if item.Diff == nil {
			continue
		}
		status := "modified"
		deletions := 0
		if item.Diff.OldText == nil {
			status = "added"
		} else {
			deletions = lineCount(*item.Diff.OldText)
			if item.Diff.NewText == "" {
				status = "deleted"
			}
		}
		files = append(files, ports.ChatDiffFile{
			Path: item.Diff.Path, Status: status,
			Additions: lineCount(item.Diff.NewText), Deletions: deletions,
		})
	}
	if len(files) > 0 {
		c.emit(ports.ChatEvent{Kind: ports.ChatEventTurnDiff, ProviderTurnID: turnID, Diff: &ports.ChatTurnDiff{Files: files}})
	}
}

func lineCount(value string) int {
	if value == "" {
		return 0
	}
	return strings.Count(value, "\n") + 1
}

func normalizePlan(entries []acpsdk.PlanEntry) *domain.ConversationPlan {
	plan := &domain.ConversationPlan{Steps: make([]domain.ConversationPlanStep, 0, len(entries))}
	for _, entry := range entries {
		status := domain.PlanStepPending
		switch entry.Status {
		case acpsdk.PlanEntryStatusInProgress:
			status = domain.PlanStepInProgress
		case acpsdk.PlanEntryStatusCompleted:
			status = domain.PlanStepCompleted
		}
		plan.Steps = append(plan.Steps, domain.ConversationPlanStep{Text: entry.Content, Status: status})
	}
	return plan
}

func pointerValue[T any](value *T) T {
	if value == nil {
		var zero T
		return zero
	}
	return *value
}
