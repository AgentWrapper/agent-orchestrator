// Package sessionguard owns the one invariant every write into a live
// session's pane must satisfy: re-read the session immediately before writing
// and refuse when the paste could land somewhere only the user may act. The
// runtime appends Enter after every paste, so a write into a session paused on
// a permission/approval dialog would answer the decision on the user's behalf
// — an unrecoverable action, unlike a skipped message which callers re-attempt
// or surface. Every pane-writing path (user sends, post-send Enter nudges,
// lifecycle reaction nudges) funnels through this guard so the stale-state
// check lives in one tested place instead of being re-derived per call-site.
package sessionguard

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// SessionReader is the single store read the guard needs: the session's
// current liveness and activity state.
type SessionReader interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
}

// Outcome reports what a guarded write did. Anything other than Sent means the
// message did NOT reach the pane; callers that record delivery must not stamp
// a suppressed write as delivered.
type Outcome int

const (
	// SuppressedUnknown: the pre-write session read failed, so the state is
	// unknown and the guard failed closed. Deliberately the zero value — a
	// forgotten assignment must never read as a successful send.
	SuppressedUnknown Outcome = iota
	// Sent: the message was written to the session's pane (a messenger failure
	// surfaces as Sent plus a non-nil error: the write was attempted).
	Sent
	// SuppressedNotFound: no session row exists for the id.
	SuppressedNotFound
	// SuppressedTerminated: the session is terminated; its pane is gone or
	// about to be reaped.
	SuppressedTerminated
	// SuppressedAwaitingUser: the session awaits the human — blocked on a
	// permission decision (Deliver and Nudge), or waiting at the prompt for
	// the next instruction (Nudge only).
	SuppressedAwaitingUser
)

// String names the outcome for logs.
func (o Outcome) String() string {
	switch o {
	case Sent:
		return "sent"
	case SuppressedNotFound:
		return "suppressed_not_found"
	case SuppressedTerminated:
		return "suppressed_terminated"
	case SuppressedAwaitingUser:
		return "suppressed_awaiting_user"
	default:
		return "suppressed_unknown"
	}
}

// Guard is the guarded pane-write primitive shared by the session manager and
// lifecycle. It takes no locks of its own, so callers may hold theirs across a
// call (lifecycle's sendOnce calls it under react.mu). It implements
// ports.AgentMessenger (via Send) so it can transparently replace a raw
// messenger wherever only the error matters.
type Guard struct {
	store     SessionReader
	messenger ports.AgentMessenger
	logger    *slog.Logger
}

var _ ports.AgentMessenger = (*Guard)(nil)

// New builds a Guard over the store it re-reads and the messenger it writes
// through. A nil logger falls back to slog.Default().
func New(store SessionReader, messenger ports.AgentMessenger, logger *slog.Logger) *Guard {
	if logger == nil {
		logger = slog.Default()
	}
	return &Guard{store: store, messenger: messenger, logger: logger}
}

// Send makes Guard a drop-in ports.AgentMessenger decorator: it applies the
// Deliver policy (refuse only a blocked session) and folds the Outcome away,
// returning just the error. This is the form the initial-prompt delivery paths
// (Spawn/Restore) want — they hand a freshly-spawned session its prompt, where
// blocked is impossible, so a suppression there is a no-op they need not
// distinguish. Callers that must act on WHY a write was suppressed (Send's 409
// mapping, reaction nudges' don't-stamp-delivered) call Deliver/Nudge directly
// for the Outcome. Wrapping the raw messenger in a Guard lets both Manager
// structs keep a single ports.AgentMessenger field that is already guarded.
func (g *Guard) Send(ctx context.Context, id domain.SessionID, msg string) error {
	_, err := g.Deliver(ctx, id, msg)
	return err
}

// Deliver writes a user-initiated message (or its Enter-only re-submit: an
// empty msg) into the session. It refuses only when the session is blocked on
// a pending decision — waiting_input does NOT suppress, because an agent
// sitting at an idle prompt is exactly where a user message (or the Enter that
// submits its unsent draft) belongs.
func (g *Guard) Deliver(ctx context.Context, id domain.SessionID, msg string) (Outcome, error) {
	return g.send(ctx, id, msg, func(state domain.ActivityState) bool {
		return state == domain.ActivityBlocked
	})
}

// Nudge writes an AO-initiated (unsolicited) message into the session. It
// refuses whenever the session awaits the human in any form — blocked on a
// decision or waiting at the prompt — because an automated paste+Enter there
// either answers a dialog or submits text the user never saw.
func (g *Guard) Nudge(ctx context.Context, id domain.SessionID, msg string) (Outcome, error) {
	return g.send(ctx, id, msg, func(state domain.ActivityState) bool {
		return state.NeedsInput()
	})
}

// send re-reads the session immediately before pasting so the window between
// "state looked safe" and "bytes hit the pane" is as small as this process can
// make it. It is not atomic against the agent itself — a dialog can still
// appear mid-paste — but the just-in-time read is the strongest guarantee
// available without scraping the terminal. Fail closed: a store error
// suppresses the write rather than pressing Enter on an unknown state.
func (g *Guard) send(ctx context.Context, id domain.SessionID, msg string, refuse func(domain.ActivityState) bool) (Outcome, error) {
	rec, ok, err := g.store.GetSession(ctx, id)
	if err != nil {
		return SuppressedUnknown, fmt.Errorf("guard %s: read session: %w", id, err)
	}
	if !ok {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", "not_found")
		return SuppressedNotFound, nil
	}
	// ActivityExited is refused alongside IsTerminated as defense-in-depth:
	// every exited writer today also sets IsTerminated, but a pane whose agent
	// exited execs an interactive shell, so a paste+Enter there would run the
	// message as shell commands — the invariant must not depend on writer
	// discipline alone.
	if rec.IsTerminated || rec.Activity.State == domain.ActivityExited {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", "terminated")
		return SuppressedTerminated, nil
	}
	if refuse(rec.Activity.State) {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", "awaiting_user", "state", string(rec.Activity.State))
		return SuppressedAwaitingUser, nil
	}
	if err := g.messenger.Send(ctx, id, msg); err != nil {
		return Sent, fmt.Errorf("guard %s: send: %w", id, err)
	}
	return Sent, nil
}
