package sessionmanager

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// AffectedSession describes a running worker session whose launched permission
// mode differs from the project's current effective mode.
type AffectedSession struct {
	SessionID domain.SessionID
	Title     string
	Kind      domain.SessionKind
	FromMode  domain.PermissionMode
	ToMode    domain.PermissionMode
}

// RelaunchOutcome reports what happened for one session in a batch relaunch.
type RelaunchOutcome struct {
	SessionID domain.SessionID
	OK        bool
	Error     string
}

// normalizePermission maps the empty string (unset) to the default mode.
func normalizePermission(p domain.PermissionMode) domain.PermissionMode {
	if p == "" {
		return domain.PermissionModeDefault
	}
	return p
}

// AffectedByPermissionChange returns the running worker sessions for a project
// whose launched permission mode differs from the project's current effective
// mode. Terminated sessions, the orchestrator, and sessions without a
// restorable workspace are excluded.
func (m *Manager) AffectedByPermissionChange(ctx context.Context, projectID domain.ProjectID) ([]AffectedSession, error) {
	project, err := m.loadProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	recs, err := m.store.ListSessions(ctx, projectID)
	if err != nil {
		return nil, err
	}
	var affected []AffectedSession
	for _, rec := range recs {
		if rec.IsTerminated {
			continue
		}
		if rec.Kind == domain.KindOrchestrator {
			continue
		}
		if rec.Metadata.WorkspacePath == "" || rec.Metadata.Branch == "" {
			continue
		}
		current := effectiveAgentConfig(rec.Kind, project.Config)
		if normalizePermission(rec.Metadata.Permissions) == normalizePermission(current.Permissions) {
			continue
		}
		title := rec.DisplayName
		if title == "" {
			title = string(rec.ID)
		}
		affected = append(affected, AffectedSession{
			SessionID: rec.ID,
			Title:     title,
			Kind:      rec.Kind,
			FromMode:  normalizePermission(rec.Metadata.Permissions),
			ToMode:    normalizePermission(current.Permissions),
		})
	}
	return affected, nil
}

// RelaunchForPermissionChange kills then restores each running worker session
// whose permission mode differs from the project's current effective mode.
// Each session is processed sequentially. Kill errors skip the Restore step
// but do not abort the batch; Restore errors are recorded and the loop
// continues. The orchestrator is never touched.
func (m *Manager) RelaunchForPermissionChange(ctx context.Context, projectID domain.ProjectID) ([]RelaunchOutcome, error) {
	affected, err := m.AffectedByPermissionChange(ctx, projectID)
	if err != nil {
		return nil, err
	}
	outcomes := make([]RelaunchOutcome, 0, len(affected))
	for _, a := range affected {
		id := a.SessionID
		if _, killErr := m.Kill(ctx, id); killErr != nil {
			outcomes = append(outcomes, RelaunchOutcome{SessionID: id, OK: false, Error: killErr.Error()})
			continue
		}
		if _, restoreErr := m.RestoreWithMode(ctx, id); restoreErr != nil {
			outcomes = append(outcomes, RelaunchOutcome{SessionID: id, OK: false, Error: restoreErr.Error()})
			continue
		}
		outcomes = append(outcomes, RelaunchOutcome{SessionID: id, OK: true})
	}
	return outcomes, nil
}
