package sessionmanager

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// mkWorkerRec builds a minimal live worker session record for permission tests.
func mkWorkerRec(id domain.SessionID, projectID domain.ProjectID, perm domain.PermissionMode) domain.SessionRecord {
	return domain.SessionRecord{
		ID:        id,
		ProjectID: projectID,
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/ws/" + string(id),
			Branch:        "ao/" + string(id) + "/root",
			Permissions:   perm,
		},
		Activity: domain.Activity{State: domain.ActivityIdle},
	}
}

func TestAffectedByPermissionChange(t *testing.T) {
	type sessionSetup struct {
		id           domain.SessionID
		kind         domain.SessionKind
		terminated   bool
		workspace    string
		branch       string
		storedPerm   domain.PermissionMode
		displayName  string
	}
	cases := []struct {
		name        string
		projectPerm domain.PermissionMode
		sessions    []sessionSetup
		wantIDs     []domain.SessionID
	}{
		{
			name:        "terminated excluded",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, terminated: true, workspace: "/ws/s-1", branch: "b/s-1", storedPerm: domain.PermissionModeDefault},
			},
			wantIDs: nil,
		},
		{
			name:        "orchestrator excluded",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindOrchestrator, workspace: "/ws/s-1", branch: "b/s-1", storedPerm: domain.PermissionModeDefault},
			},
			wantIDs: nil,
		},
		{
			name:        "non-restorable missing workspace excluded",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, workspace: "", branch: "b/s-1", storedPerm: domain.PermissionModeDefault},
			},
			wantIDs: nil,
		},
		{
			name:        "non-restorable missing branch excluded",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, workspace: "/ws/s-1", branch: "", storedPerm: domain.PermissionModeDefault},
			},
			wantIDs: nil,
		},
		{
			name:        "unchanged mode excluded",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, workspace: "/ws/s-1", branch: "b/s-1", storedPerm: domain.PermissionModeAuto},
			},
			wantIDs: nil,
		},
		{
			name:        "changed mode included",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, workspace: "/ws/s-1", branch: "b/s-1", storedPerm: domain.PermissionModeDefault},
			},
			wantIDs: []domain.SessionID{"s-1"},
		},
		{
			name:        "empty stored treated as default differs from auto",
			projectPerm: domain.PermissionModeAuto,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, workspace: "/ws/s-1", branch: "b/s-1", storedPerm: ""},
			},
			wantIDs: []domain.SessionID{"s-1"},
		},
		{
			name:        "empty stored treated as default same as default excluded",
			projectPerm: domain.PermissionModeDefault,
			sessions: []sessionSetup{
				{id: "s-1", kind: domain.KindWorker, workspace: "/ws/s-1", branch: "b/s-1", storedPerm: ""},
			},
			wantIDs: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			// Set up project with the desired permission mode.
			st.projects["proj"] = domain.ProjectRecord{
				ID: "proj",
				Config: domain.ProjectConfig{
					AgentConfig: domain.AgentConfig{Permissions: tc.projectPerm},
					Worker:      domain.RoleOverride{Harness: domain.HarnessClaudeCode},
				},
			}
			for _, s := range tc.sessions {
				rec := domain.SessionRecord{
					ID:        s.id,
					ProjectID: "proj",
					Kind:      s.kind,
					Harness:   domain.HarnessClaudeCode,
					IsTerminated: s.terminated,
					DisplayName: s.displayName,
					Metadata: domain.SessionMetadata{
						WorkspacePath: s.workspace,
						Branch:        s.branch,
						Permissions:   s.storedPerm,
					},
					Activity: domain.Activity{State: domain.ActivityIdle},
				}
				st.sessions[s.id] = rec
			}
			lookPath := func(string) (string, error) { return "/bin/true", nil }
			m := New(Deps{
				Runtime:   &fakeRuntime{},
				Agents:    fakeAgents{},
				Workspace: &fakeWorkspace{},
				Store:     st,
				Messenger: &fakeMessenger{},
				Lifecycle: &fakeLCM{store: st},
				LookPath:  lookPath,
			})
			affected, err := m.AffectedByPermissionChange(ctx, "proj")
			if err != nil {
				t.Fatalf("AffectedByPermissionChange: %v", err)
			}
			if len(affected) != len(tc.wantIDs) {
				t.Fatalf("len(affected) = %d, want %d; got %v", len(affected), len(tc.wantIDs), affected)
			}
			gotIDs := map[domain.SessionID]bool{}
			for _, a := range affected {
				gotIDs[a.SessionID] = true
			}
			for _, wantID := range tc.wantIDs {
				if !gotIDs[wantID] {
					t.Fatalf("want session %q in affected, but got %v", wantID, affected)
				}
			}
		})
	}
}

func TestNormalizePermission(t *testing.T) {
	cases := []struct {
		in   domain.PermissionMode
		want domain.PermissionMode
	}{
		{"", domain.PermissionModeDefault},
		{domain.PermissionModeDefault, domain.PermissionModeDefault},
		{domain.PermissionModeAuto, domain.PermissionModeAuto},
		{domain.PermissionModeAcceptEdits, domain.PermissionModeAcceptEdits},
		{domain.PermissionModeBypassPermissions, domain.PermissionModeBypassPermissions},
	}
	for _, tc := range cases {
		got := normalizePermission(tc.in)
		if got != tc.want {
			t.Errorf("normalizePermission(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
