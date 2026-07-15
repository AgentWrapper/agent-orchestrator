package suggestion

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	MaxTitleLength = 120
	MaxNoteLength  = 4000
)

// Suggestion is the API-facing deferred-work item.
type Suggestion struct {
	ID        string                    `json:"id"`
	ProjectID domain.ProjectID          `json:"projectId"`
	Title     string                    `json:"title" maxLength:"120"`
	Note      string                    `json:"note,omitempty" maxLength:"4000"`
	Priority  domain.SuggestionPriority `json:"priority" enum:"later,normal,important"`
	Status    domain.SuggestionStatus   `json:"status" enum:"backlog,in_progress,done,dismissed"`
	SessionID domain.SessionID          `json:"sessionId,omitempty"`
	CreatedAt time.Time                 `json:"createdAt"`
	UpdatedAt time.Time                 `json:"updatedAt"`
}

type CreateInput struct {
	Title    string                    `json:"title" minLength:"1" maxLength:"120"`
	Note     string                    `json:"note,omitempty" maxLength:"4000"`
	Priority domain.SuggestionPriority `json:"priority,omitempty" enum:"later,normal,important"`
}

type UpdateInput struct {
	Title    *string                    `json:"title,omitempty" minLength:"1" maxLength:"120"`
	Note     *string                    `json:"note,omitempty" maxLength:"4000"`
	Priority *domain.SuggestionPriority `json:"priority,omitempty" enum:"later,normal,important"`
	Status   *domain.SuggestionStatus   `json:"status,omitempty" enum:"backlog,in_progress,done,dismissed"`
}

type StartResult struct {
	Suggestion Suggestion       `json:"suggestion"`
	SessionID  domain.SessionID `json:"sessionId"`
}

type Store interface {
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	CreateSuggestion(ctx context.Context, rec domain.SuggestionRecord) (domain.SuggestionRecord, error)
	ListSuggestions(ctx context.Context, projectID domain.ProjectID) ([]domain.SuggestionRecord, error)
	GetSuggestion(ctx context.Context, projectID domain.ProjectID, id string) (domain.SuggestionRecord, bool, error)
	UpdateSuggestion(ctx context.Context, rec domain.SuggestionRecord) (domain.SuggestionRecord, bool, error)
}

type SessionStarter interface {
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, error)
}

type Manager struct {
	store    Store
	sessions SessionStarter
	clock    func() time.Time
	newID    func() string
}

type Deps struct {
	Store    Store
	Sessions SessionStarter
	Clock    func() time.Time
	NewID    func() string
}

func New(d Deps) *Manager {
	if d.Clock == nil {
		d.Clock = time.Now
	}
	if d.NewID == nil {
		d.NewID = func() string { return "sg_" + uuid.NewString() }
	}
	return &Manager{store: d.Store, sessions: d.Sessions, clock: d.Clock, newID: d.NewID}
}

func (m *Manager) List(ctx context.Context, projectID domain.ProjectID) ([]Suggestion, error) {
	if err := m.requireProject(ctx, projectID); err != nil {
		return nil, err
	}
	rows, err := m.store.ListSuggestions(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]Suggestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, fromRecord(row))
	}
	return out, nil
}

func (m *Manager) Create(ctx context.Context, projectID domain.ProjectID, in CreateInput) (Suggestion, error) {
	if err := m.requireProject(ctx, projectID); err != nil {
		return Suggestion{}, err
	}
	title, note, priority, err := normalize(in.Title, in.Note, in.Priority)
	if err != nil {
		return Suggestion{}, err
	}
	now := m.clock().UTC()
	rec, err := m.store.CreateSuggestion(ctx, domain.SuggestionRecord{
		ID: m.newID(), ProjectID: projectID, Title: title, Note: note, Priority: priority,
		Status: domain.SuggestionBacklog, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		return Suggestion{}, err
	}
	return fromRecord(rec), nil
}

func (m *Manager) Update(ctx context.Context, projectID domain.ProjectID, id string, in UpdateInput) (Suggestion, error) {
	rec, err := m.get(ctx, projectID, id)
	if err != nil {
		return Suggestion{}, err
	}
	if in.Title != nil {
		rec.Title = strings.TrimSpace(*in.Title)
	}
	if in.Note != nil {
		rec.Note = strings.TrimSpace(*in.Note)
	}
	if in.Priority != nil {
		rec.Priority = *in.Priority
	}
	if in.Status != nil {
		rec.Status = *in.Status
		if rec.Status == domain.SuggestionBacklog {
			rec.SessionID = ""
		}
	}
	if _, _, _, err := normalize(rec.Title, rec.Note, rec.Priority); err != nil || !rec.Status.Valid() {
		if err != nil {
			return Suggestion{}, err
		}
		return Suggestion{}, apierr.Invalid("INVALID_SUGGESTION_STATUS", "Suggestion status is invalid", nil)
	}
	rec.UpdatedAt = m.clock().UTC()
	updated, ok, err := m.store.UpdateSuggestion(ctx, rec)
	if err != nil {
		return Suggestion{}, err
	}
	if !ok {
		return Suggestion{}, apierr.NotFound("SUGGESTION_NOT_FOUND", "Unknown suggestion")
	}
	return fromRecord(updated), nil
}

func (m *Manager) Start(ctx context.Context, projectID domain.ProjectID, id string) (StartResult, error) {
	if m.sessions == nil {
		return StartResult{}, errors.New("suggestion: session service is required")
	}
	rec, err := m.get(ctx, projectID, id)
	if err != nil {
		return StartResult{}, err
	}
	if rec.Status != domain.SuggestionBacklog {
		return StartResult{}, apierr.Conflict("SUGGESTION_NOT_READY", "Only backlog suggestions can be started", nil)
	}
	session, err := m.sessions.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   projectID,
		Kind:        domain.KindWorker,
		Prompt:      workerPrompt(rec),
		DisplayName: suggestionDisplayName(rec.Title),
	})
	if err != nil {
		return StartResult{}, err
	}
	rec.Status = domain.SuggestionInProgress
	rec.SessionID = session.ID
	rec.UpdatedAt = m.clock().UTC()
	updated, ok, err := m.store.UpdateSuggestion(ctx, rec)
	if err != nil {
		return StartResult{}, fmt.Errorf("link suggestion to session %s: %w", session.ID, err)
	}
	if !ok {
		return StartResult{}, apierr.NotFound("SUGGESTION_NOT_FOUND", "Unknown suggestion")
	}
	return StartResult{Suggestion: fromRecord(updated), SessionID: session.ID}, nil
}

func (m *Manager) get(ctx context.Context, projectID domain.ProjectID, id string) (domain.SuggestionRecord, error) {
	if err := m.requireProject(ctx, projectID); err != nil {
		return domain.SuggestionRecord{}, err
	}
	if strings.TrimSpace(id) == "" {
		return domain.SuggestionRecord{}, apierr.Invalid("SUGGESTION_ID_REQUIRED", "Suggestion id is required", nil)
	}
	rec, ok, err := m.store.GetSuggestion(ctx, projectID, id)
	if err != nil {
		return domain.SuggestionRecord{}, err
	}
	if !ok {
		return domain.SuggestionRecord{}, apierr.NotFound("SUGGESTION_NOT_FOUND", "Unknown suggestion")
	}
	return rec, nil
}

func (m *Manager) requireProject(ctx context.Context, projectID domain.ProjectID) error {
	if m == nil || m.store == nil {
		return errors.New("suggestion: store is required")
	}
	if projectID == "" {
		return apierr.Invalid("PROJECT_ID_REQUIRED", "projectId is required", nil)
	}
	if _, ok, err := m.store.GetProject(ctx, string(projectID)); err != nil {
		return err
	} else if !ok {
		return apierr.NotFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	return nil
}

func normalize(title, note string, priority domain.SuggestionPriority) (string, string, domain.SuggestionPriority, error) {
	title = strings.TrimSpace(title)
	note = strings.TrimSpace(note)
	if priority == "" {
		priority = domain.SuggestionPriorityNormal
	}
	if title == "" || utf8.RuneCountInString(title) > MaxTitleLength {
		return "", "", "", apierr.Invalid("INVALID_SUGGESTION_TITLE", "Suggestion title must be 1 to 120 characters", nil)
	}
	if utf8.RuneCountInString(note) > MaxNoteLength {
		return "", "", "", apierr.Invalid("INVALID_SUGGESTION_NOTE", "Suggestion note must be 4000 characters or fewer", nil)
	}
	if !priority.Valid() {
		return "", "", "", apierr.Invalid("INVALID_SUGGESTION_PRIORITY", "Suggestion priority is invalid", nil)
	}
	return title, note, priority, nil
}

func workerPrompt(rec domain.SuggestionRecord) string {
	note := "No additional note was provided."
	if rec.Note != "" {
		note = rec.Note
	}
	return fmt.Sprintf(`Work on this deferred project suggestion: %s

%s

This is a non-blocking grand-workflow improvement, not a current implementation requirement. Evaluate it against the repository and active architecture. Make a scoped improvement when appropriate; otherwise return a concrete recommendation explaining what should happen later and why. Do not disrupt unrelated active work.`, rec.Title, note)
}

func suggestionDisplayName(title string) string {
	runes := []rune(strings.TrimSpace(title))
	if len(runes) > 20 {
		runes = runes[:20]
	}
	return string(runes)
}

func fromRecord(rec domain.SuggestionRecord) Suggestion {
	return Suggestion{
		ID: rec.ID, ProjectID: rec.ProjectID, Title: rec.Title, Note: rec.Note, Priority: rec.Priority,
		Status: rec.Status, SessionID: rec.SessionID, CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
	}
}
