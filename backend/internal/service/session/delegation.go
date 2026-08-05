package session

import (
	"context"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// DelegateTaskInput describes a task AO should spawn as a worker session. Empty
// RequestedAgent means the spawn uses the project's worker-agent default.
type DelegateTaskInput struct {
	ProjectID      domain.ProjectID
	Brief          string
	RequestedAgent domain.AgentHarness
	Model          string
}

// DelegateTaskOutcome identifies the spawned worker and, when present, the
// orchestrator that received the follow-up title request.
type DelegateTaskOutcome struct {
	OrchestratorID domain.SessionID
	WorkerID       domain.SessionID
}

// DelegateTask spawns the worker directly, matching `ao spawn`, and leaves the
// display name empty so the read model temporarily uses the worker id. If an
// orchestrator is active, AO asks it to rename the worker from the task brief.
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

	worker, _, _, err := s.manager.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   in.ProjectID,
		Kind:        domain.KindWorker,
		Harness:     in.RequestedAgent,
		Prompt:      in.Brief,
		AgentConfig: ports.AgentConfig{Model: strings.TrimSpace(in.Model)},
	})
	if err != nil {
		return DelegateTaskOutcome{}, toAPIError(err)
	}

	out := DelegateTaskOutcome{WorkerID: worker.ID}
	active := true
	orchestrators, err := s.List(ctx, ListFilter{
		ProjectID:        in.ProjectID,
		Active:           &active,
		OrchestratorOnly: true,
	})
	if err != nil {
		return out, err
	}
	if len(orchestrators) == 0 {
		return out, nil
	}

	orchestrator := newestSession(orchestrators)
	out.OrchestratorID = orchestrator.ID
	if err := s.manager.Send(ctx, orchestrator.ID, taskTitleDelegationMessage(worker.ID, in)); err != nil {
		return out, err
	}
	return out, nil
}

func taskTitleDelegationMessage(workerID domain.SessionID, in DelegateTaskInput) string {
	var b strings.Builder
	b.WriteString("AO TASK TITLE UPDATE\n")
	b.WriteString("A worker was already spawned directly with the user's task. Do not spawn another worker or orchestrator, and do not implement the task in this orchestrator session.\n")
	b.WriteString("Choose a concise task title from the brief and run:\n\n")
	b.WriteString("ao session rename ")
	b.WriteString(string(workerID))
	b.WriteString(" \"<title, max 20 chars>\"\n\n")
	b.WriteString("Worker session id: ")
	b.WriteString(string(workerID))
	b.WriteString("\nTask brief:\n")
	b.WriteString(in.Brief)
	if model := strings.TrimSpace(in.Model); model != "" {
		b.WriteString("\nRequested model: ")
		b.WriteString(model)
	}
	return b.String()
}
