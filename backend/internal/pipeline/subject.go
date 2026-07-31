package pipeline

import "fmt"

// SubjectKind names what a run is about. A trigger names a subject, and the
// subject determines the default workspace and which ambient variables
// resolve (spec section 4).
type SubjectKind string

// Every subject kind.
const (
	SubjectSession SubjectKind = "session"
	SubjectPR      SubjectKind = "pr"
	SubjectProject SubjectKind = "project"
)

// Subject is the thing a run is about.
//
// A PR subject may or may not have a session, and both are normal:
// sessionless is first-class, because a pipeline watching someone else's PR
// must work with no session anywhere in the picture.
type Subject struct {
	Kind      SubjectKind `json:"kind"`
	ProjectID string      `json:"projectId"`
	// SessionID is set for session subjects, and for PR subjects that have a
	// local session tracking the PR.
	SessionID string `json:"sessionId,omitempty"`
	// PR is set for PR subjects only.
	PR *PRRef `json:"pr,omitempty"`
}

// PRRef identifies the pull request a PR subject is about.
type PRRef struct {
	Number     int    `json:"number"`
	Repo       string `json:"repo"` // owner/name
	URL        string `json:"url,omitempty"`
	HeadSHA    string `json:"headSha,omitempty"`
	HeadBranch string `json:"headBranch,omitempty"`
	BaseBranch string `json:"baseBranch,omitempty"`
	// FromFork drives the identity-only rule: a fork PR never gets a
	// credential injected anywhere in the run, because PR contents are
	// untrusted input to an LLM with shell access (spec section 8).
	FromFork bool `json:"fromFork,omitempty"`
}

// HasSession reports whether the subject resolves to a local session. This is
// the one thing that decides whether `workspace: session` is possible.
func (s Subject) HasSession() bool { return s.SessionID != "" }

// FromForkPR reports whether the subject is a pull request from a fork, the
// one condition that forces identity-only env for the whole run (spec section
// 8, decision D17).
func (s Subject) FromForkPR() bool { return s.PR != nil && s.PR.FromFork }

// DefaultScope is the subject's natural concurrency scope, used when the
// pipeline declares none (spec section 10).
func (s Subject) DefaultScope() ConcurrencyScope {
	switch s.Kind {
	case SubjectPR:
		return ConcurrencyScopePR
	case SubjectSession:
		return ConcurrencyScopeSession
	default:
		return ConcurrencyScopeProject
	}
}

// ScopeIdentity resolves the identity half of the effective concurrency key
// (the other half is the literal group name). An unset scope resolves to the
// subject's natural scope first, so callers can pass the declared value
// through unchanged.
//
// It returns "" when the subject has no identity at the requested scope, for
// instance a project subject asked for a PR identity. The supervisor treats an
// empty identity as ungrouped, so such a run serializes against nothing.
func (s Subject) ScopeIdentity(scope ConcurrencyScope) string {
	if scope == ConcurrencyScopeUnset {
		scope = s.DefaultScope()
	}
	switch scope {
	case ConcurrencyScopePR:
		if s.PR == nil {
			return ""
		}
		return fmt.Sprintf("%s#%d", s.PR.Repo, s.PR.Number)
	case ConcurrencyScopeSession:
		return s.SessionID
	case ConcurrencyScopeProject:
		return s.ProjectID
	default:
		return ""
	}
}

// describe names the subject the way a human-facing failure reason should,
// e.g. "PR #412".
func (s Subject) describe() string {
	if s.Kind == SubjectPR && s.PR != nil {
		return fmt.Sprintf("PR #%d", s.PR.Number)
	}
	if s.Kind == "" {
		return "the subject"
	}
	return fmt.Sprintf("this %s subject", s.Kind)
}
