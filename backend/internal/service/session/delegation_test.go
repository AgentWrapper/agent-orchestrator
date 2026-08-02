package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

func TestDelegateTaskSendsStructuredMessageToNewestActiveOrchestrator(t *testing.T) {
	tests := []struct {
		name           string
		brief          string
		agent          domain.AgentHarness
		model          string
		wantIntent     string
		wantHarness    domain.AgentHarness
		wantModel      string
		wantAutonomous bool
	}{
		{name: "project default", brief: "  Fix the renderer\nwithout changing the API.  ", wantIntent: "project_default"},
		{name: "requested agent and model", brief: "  Fix the renderer\nwithout changing the API.  ", agent: domain.HarnessCursor, model: "  sonnet-custom  ", wantIntent: "requested", wantHarness: domain.HarnessCursor, wantModel: "sonnet-custom"},
		{name: "orchestrator chooses task", wantIntent: "project_default", wantAutonomous: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := newFakeStore()
			st.projects["ao"] = domain.ProjectRecord{ID: "ao"}
			now := time.Now().UTC()
			st.sessions["orch-old"] = domain.SessionRecord{ID: "orch-old", ProjectID: "ao", Kind: domain.KindOrchestrator, CreatedAt: now.Add(-time.Minute)}
			st.sessions["orch-new"] = domain.SessionRecord{ID: "orch-new", ProjectID: "ao", Kind: domain.KindOrchestrator, CreatedAt: now}
			st.sessions["orch-dead"] = domain.SessionRecord{ID: "orch-dead", ProjectID: "ao", Kind: domain.KindOrchestrator, IsTerminated: true, CreatedAt: now.Add(time.Minute)}
			st.sessions["worker"] = domain.SessionRecord{ID: "worker", ProjectID: "ao", Kind: domain.KindWorker, CreatedAt: now.Add(2 * time.Minute)}
			cmd := &fakeCommander{}
			svc := &Service{store: st, manager: cmd}

			out, err := svc.DelegateTask(context.Background(), DelegateTaskInput{
				ProjectID: "ao", Brief: tt.brief, RequestedAgent: tt.agent, Model: tt.model,
			})
			if err != nil {
				t.Fatalf("DelegateTask: %v", err)
			}
			if out.OrchestratorID != "orch-new" || len(cmd.sent) != 1 || cmd.sent[0] != "orch-new" {
				t.Fatalf("out = %#v, sent = %#v; want orch-new", out, cmd.sent)
			}
			if !strings.Contains(strings.ToLower(cmd.sentMessages[0]), "choose the worker name and final prompt") {
				t.Fatalf("delegation instructions missing: %q", cmd.sentMessages[0])
			}
			if tt.wantAutonomous && !strings.Contains(cmd.sentMessages[0], "choose the next useful implementation task") {
				t.Fatalf("autonomous task instruction missing: %q", cmd.sentMessages[0])
			}
			payloadStart := strings.LastIndex(cmd.sentMessages[0], "\n") + 1
			payload := cmd.sentMessages[0][payloadStart:]
			var got taskDelegationMessage
			if err := json.Unmarshal([]byte(payload), &got); err != nil {
				t.Fatalf("decode delegation payload: %v; message=%q", err, cmd.sentMessages[0])
			}
			if got.Type != "task_delegation" || got.Brief != tt.brief || got.Agent.Intent != tt.wantIntent || got.Agent.Harness != tt.wantHarness || got.Model != tt.wantModel {
				t.Fatalf("payload = %#v", got)
			}
			if tt.wantAutonomous && strings.Contains(payload, `"brief"`) {
				t.Fatalf("blank brief should be omitted: %s", payload)
			}
		})
	}
}

func TestDelegateTaskRequiresActiveOrchestrator(t *testing.T) {
	st := newFakeStore()
	st.projects["ao"] = domain.ProjectRecord{ID: "ao"}
	st.sessions["orch-dead"] = domain.SessionRecord{ID: "orch-dead", ProjectID: "ao", Kind: domain.KindOrchestrator, IsTerminated: true}
	cmd := &fakeCommander{}

	_, err := (&Service{store: st, manager: cmd}).DelegateTask(context.Background(), DelegateTaskInput{ProjectID: "ao", Brief: "Fix it"})
	var apiError *apierr.Error
	if !errors.As(err, &apiError) || apiError.Kind != apierr.KindConflict || apiError.Code != "ACTIVE_ORCHESTRATOR_REQUIRED" {
		t.Fatalf("err = %v, want conflict ACTIVE_ORCHESTRATOR_REQUIRED", err)
	}
	if len(cmd.sent) != 0 {
		t.Fatalf("sent = %#v, want none", cmd.sent)
	}
}
