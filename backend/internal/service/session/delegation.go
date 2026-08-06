package session

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const delegatedTaskTitleLimit = 20

// DelegateTaskInput describes a task AO should spawn as a worker session. Empty
// RequestedAgent means the spawn uses the project's worker-agent default.
type DelegateTaskInput struct {
	ProjectID      domain.ProjectID
	Brief          string
	RequestedAgent domain.AgentHarness
	Model          string
	RequestedMode  domain.SessionMode
}

// DelegateTaskOutcome identifies the spawned worker and, when present, the
// orchestrator that received the follow-up title request.
type DelegateTaskOutcome struct {
	OrchestratorID domain.SessionID
	WorkerID       domain.SessionID
}

// DelegateTask spawns the worker directly, matching `ao spawn`, with a
// provisional display name derived from the task brief. If a running
// orchestrator is available, AO best-effort asks it to refine that title.
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
	if in.RequestedMode != "" && !in.RequestedMode.Valid() {
		return DelegateTaskOutcome{}, apierr.Invalid("INVALID_SESSION_MODE", "mode must be chat or tui", nil)
	}

	worker, _, _, err := s.manager.Spawn(ctx, ports.SpawnConfig{
		ProjectID:     in.ProjectID,
		Kind:          domain.KindWorker,
		Harness:       in.RequestedAgent,
		Prompt:        in.Brief,
		DisplayName:   delegatedTaskDisplayName(in.Brief),
		AgentConfig:   ports.AgentConfig{Model: strings.TrimSpace(in.Model)},
		RequestedMode: in.RequestedMode,
	})
	if err != nil {
		return DelegateTaskOutcome{}, toAPIError(err)
	}

	out := DelegateTaskOutcome{WorkerID: worker.ID}
	active := true
	// The worker spawn is the commit point. Discovering a title-refinement
	// recipient after that point is deliberately best effort.
	orchestrators, _ := s.List(ctx, ListFilter{
		ProjectID:        in.ProjectID,
		Active:           &active,
		OrchestratorOnly: true,
	})

	running := orchestrators[:0]
	for _, orchestrator := range orchestrators {
		if orchestrator.Activity.State != domain.ActivityExited {
			running = append(running, orchestrator)
		}
	}
	if len(running) == 0 {
		return out, nil
	}

	orchestrator := newestSession(running)
	if s.manager.Send(ctx, orchestrator.ID, taskTitleDelegationMessage(worker.ID, in)) == nil {
		out.OrchestratorID = orchestrator.ID
	}
	return out, nil
}

func delegatedTaskDisplayName(brief string) string {
	title := strings.Join(strings.Fields(brief), " ")
	if utf8.RuneCountInString(title) <= delegatedTaskTitleLimit {
		return title
	}
	return strings.TrimSpace(string([]rune(title)[:delegatedTaskTitleLimit]))
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
