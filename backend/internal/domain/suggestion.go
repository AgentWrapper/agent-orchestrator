package domain

import (
	"errors"
	"strings"
	"time"
)

// SuggestionPriority indicates how strongly a deferred workflow idea should be considered.
type SuggestionPriority string

const (
	SuggestionPriorityLater     SuggestionPriority = "later"
	SuggestionPriorityNormal    SuggestionPriority = "normal"
	SuggestionPriorityImportant SuggestionPriority = "important"
)

func (p SuggestionPriority) Valid() bool {
	switch p {
	case SuggestionPriorityLater, SuggestionPriorityNormal, SuggestionPriorityImportant:
		return true
	default:
		return false
	}
}

// SuggestionStatus tracks a suggestion from the deferred backlog into optional work.
type SuggestionStatus string

const (
	SuggestionBacklog    SuggestionStatus = "backlog"
	SuggestionInProgress SuggestionStatus = "in_progress"
	SuggestionDone       SuggestionStatus = "done"
	SuggestionDismissed  SuggestionStatus = "dismissed"
)

func (s SuggestionStatus) Valid() bool {
	switch s {
	case SuggestionBacklog, SuggestionInProgress, SuggestionDone, SuggestionDismissed:
		return true
	default:
		return false
	}
}

// SuggestionRecord is one durable, project-scoped grand-workflow idea.
type SuggestionRecord struct {
	ID        string
	ProjectID ProjectID
	Title     string
	Note      string
	Priority  SuggestionPriority
	Status    SuggestionStatus
	SessionID SessionID
	CreatedAt time.Time
	UpdatedAt time.Time
}

var ErrInvalidSuggestion = errors.New("invalid suggestion")

func (r SuggestionRecord) Validate() error {
	if strings.TrimSpace(r.ID) == "" || r.ProjectID == "" || strings.TrimSpace(r.Title) == "" || r.CreatedAt.IsZero() || r.UpdatedAt.IsZero() {
		return ErrInvalidSuggestion
	}
	if !r.Priority.Valid() || !r.Status.Valid() {
		return ErrInvalidSuggestion
	}
	return nil
}
