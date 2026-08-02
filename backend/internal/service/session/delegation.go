package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// DelegateTaskInput describes a task the active project orchestrator should
// turn into a worker session. Empty RequestedAgent means the orchestrator
// should use the project's worker-agent default.
type DelegateTaskInput struct {
	ProjectID      domain.ProjectID
	Brief          string
	RequestedAgent domain.AgentHarness
	Model          string
}

// DelegateTaskOutcome identifies the orchestrator that accepted a delegation.
type DelegateTaskOutcome struct {
	OrchestratorID domain.SessionID
}

type taskDelegationMessage struct {
	Type  string              `json:"type"`
	Brief string              `json:"brief"`
	Agent taskDelegationAgent `json:"agent"`
	Model string              `json:"model,omitempty"`
}

type taskDelegationAgent struct {
	Intent  string              `json:"intent"`
	Harness domain.AgentHarness `json:"harness,omitempty"`
}

// DelegateTask resolves the newest active orchestrator for the project and
// sends it a structured delegation through the same guarded delivery path as
// ao send. The orchestrator, not the daemon, chooses the worker name and final
// prompt and performs the spawn.
func (s *Service) DelegateTask(ctx context.Context, in DelegateTaskInput) (DelegateTaskOutcome, error) {
	if _, err := s.requireProject(ctx, in.ProjectID); err != nil {
		return DelegateTaskOutcome{}, err
	}
	if strings.TrimSpace(in.Brief) == "" {
		return DelegateTaskOutcome{}, apierr.Invalid("TASK_REQUIRED", "Task is required", nil)
	}
	if in.RequestedAgent != "" && !in.RequestedAgent.IsKnown() {
		return DelegateTaskOutcome{}, apierr.Invalid("UNKNOWN_HARNESS", "Unknown requested agent", nil)
	}

	active := true
	orchestrators, err := s.List(ctx, ListFilter{
		ProjectID:        in.ProjectID,
		Active:           &active,
		OrchestratorOnly: true,
	})
	if err != nil {
		return DelegateTaskOutcome{}, err
	}
	if len(orchestrators) == 0 {
		return DelegateTaskOutcome{}, apierr.Conflict(
			"ACTIVE_ORCHESTRATOR_REQUIRED",
			"Start an orchestrator for this project before starting a task.",
			map[string]any{"projectId": in.ProjectID},
		)
	}

	agent := taskDelegationAgent{Intent: "project_default"}
	if in.RequestedAgent != "" {
		agent = taskDelegationAgent{Intent: "requested", Harness: in.RequestedAgent}
	}
	payload, err := json.Marshal(taskDelegationMessage{
		Type:  "task_delegation",
		Brief: in.Brief,
		Agent: agent,
		Model: strings.TrimSpace(in.Model),
	})
	if err != nil {
		return DelegateTaskOutcome{}, fmt.Errorf("encode task delegation: %w", err)
	}

	orchestrator := newestSession(orchestrators)
	message := "AO TASK DELEGATION\nChoose the worker name and final prompt, then spawn the worker. Do not implement this task in the orchestrator session.\n" + string(payload)
	if err := s.manager.Send(ctx, orchestrator.ID, message); err != nil {
		return DelegateTaskOutcome{}, toAPIError(err)
	}
	return DelegateTaskOutcome{OrchestratorID: orchestrator.ID}, nil
}
