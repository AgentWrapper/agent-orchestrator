package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Conversation history operations: rollback, fork, and the thread title.
//
// The three share one property that shapes everything here: they change the
// provider's own record of the conversation, not AO's view of it. Rollback is the
// sharp one — it changes what the agent REMEMBERS — so AO's durable rows have to
// follow, or the timeline goes on showing prose the agent cannot recall.
//
// Each is optional on the driver and feature-detected, following the Models
// precedent: a provider that cannot do one of these gets a typed refusal the client
// can render as an absent affordance rather than a failed request.

// Typed outcomes for the history operations. Each one distinguishes a permanent
// answer from something worth retrying, because "this agent cannot undo" and "stop
// the agent first" ask completely different things of the person reading it.
var (
	// ErrRollbackUnsupported reports a provider that cannot discard history.
	ErrRollbackUnsupported = errors.New("chat driver cannot roll back history")
	// ErrForkUnsupported reports a provider that cannot branch a conversation.
	ErrForkUnsupported = errors.New("chat driver cannot fork a conversation")
	// ErrRenameUnsupported reports a provider whose thread carries no title.
	ErrRenameUnsupported = errors.New("chat driver cannot set a thread title")
	// ErrTurnRunning refuses a rollback while the agent is working. Retryable once
	// the turn ends, which is why it is separate from every other refusal here.
	ErrTurnRunning = errors.New("cannot roll back while a turn is running")
	// ErrTurnNotRollbackable reports a turn the provider never accepted. There is
	// no provider history to discard, so an undo would only hide AO's own rows and
	// leave the agent remembering more than the timeline shows.
	ErrTurnNotRollbackable = errors.New("turn was never dispatched to the provider")
	// ErrTitleRequired refuses a blank thread title. The provider refuses one too,
	// and reporting it here keeps the error about the caller's input.
	ErrTitleRequired = errors.New("thread title is required")
	// ErrProviderRefused reports something the provider declined on its own terms
	// while the conversation stayed healthy. It is a conflict, never an internal
	// failure: the message it carries is the provider's own explanation.
	ErrProviderRefused = errors.New("the agent refused the request")
)

// providerRefusal is satisfied by driver errors that mean "the provider said no"
// rather than "the call did not get through".
//
// Declared here and satisfied structurally, so this package needs no import of any
// adapter and no adapter needs to know this package's vocabulary. Without the
// distinction every ordinary refusal would surface as a 500.
type providerRefusal interface {
	ChatRefusal() bool
}

// classify folds a driver error into the typed vocabulary above.
func classify(err error) error {
	if err == nil {
		return nil
	}
	var refusal providerRefusal
	if errors.As(err, &refusal) && refusal.ChatRefusal() {
		return fmt.Errorf("%w: %w", ErrProviderRefused, err)
	}
	return err
}

// maxTitleRunes bounds a thread title, matching the automatic-semantic-task-titles
// design's contract. Longer output is treated as generation failure rather than
// truncated into something that reads like a sentence someone cut off.
const maxTitleRunes = 80

// Rollback discards a turn and everything after it, from the agent's memory and
// from AO's timeline.
//
// Refused while a turn is running, and refused BEFORE the provider is asked. The
// provider refuses this too, but relying on that alone would make the outcome a
// race: AO would have already decided to hide rows by the time it learned it could
// not. The controller holds its dispatch lock across the check and the call, so
// within AO the answer cannot change underneath.
func (s *Service) Rollback(ctx context.Context, id domain.SessionID, turnID string) (int, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return 0, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return 0, err
	}
	if _, ok := controller.conv.(ports.ChatRollbacker); !ok {
		return 0, ErrRollbackUnsupported
	}
	return controller.Rollback(ctx, turnID)
}

// ForkConversation branches this session's provider conversation and returns the
// new provider handle.
//
// Deliberately not reachable over HTTP yet, and the reason is not effort. AO's
// schema allows one conversation per session, so a fork has to become a second AO
// session — and a second session gets a fresh worktree, while the provider's own
// documentation is explicit that a fork copies conversation history and does NOT
// revert or copy the file changes the agent made. The forked agent would remember
// editing files that are not in its tree, which is a worse failure than the absent
// feature: it would look like it worked.
//
// Landing a fork therefore needs the spawn path to adopt the source session's
// worktree state, which is a workspace decision and not a chat one. Until then this
// exists so the provider call is written, tested, and honest about what it returns,
// rather than half-wired into a UI that cannot be correct.
func (s *Service) ForkConversation(ctx context.Context, id domain.SessionID) (string, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return "", err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return "", err
	}
	forker, ok := controller.conv.(ports.ChatForker)
	if !ok {
		return "", ErrForkUnsupported
	}
	forked, err := forker.Fork(ctx)
	if err != nil {
		return "", classify(fmt.Errorf("fork conversation for %s: %w", id, err))
	}
	return forked, nil
}

// SetTitle names the provider's thread and returns the normalized title.
//
// Nothing is written to AO's rows here. The provider answers, then emits its own
// rename notification, and the projection applies it — so the title AO stores is
// always one the provider confirmed. Writing it optimistically as well would give
// one fact two authors and no way to tell which lost.
func (s *Service) SetTitle(ctx context.Context, id domain.SessionID, title string) (string, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return "", err
	}
	normalized := NormalizeTitle(title)
	if normalized == "" {
		return "", ErrTitleRequired
	}
	controller, err := s.Controller(id)
	if err != nil {
		return "", err
	}
	renamer, ok := controller.conv.(ports.ChatRenamer)
	if !ok {
		return "", ErrRenameUnsupported
	}
	if err := renamer.SetTitle(ctx, normalized); err != nil {
		return "", classify(fmt.Errorf("set title for %s: %w", id, err))
	}
	return normalized, nil
}

// NormalizeTitle reduces a title to the one-line label AO is willing to show.
//
// The rules come from the automatic-semantic-task-titles design: one line, no
// wrapper punctuation, no trailing punctuation, and a hard length bound. They are
// applied to whatever the provider says rather than trusted, because a title is
// model output and arrives with heading markers, surrounding quotes, and full stops
// often enough that a client would otherwise render them.
//
// Over-length input is truncated at a word boundary rather than rejected: the
// provider already accepted the name, and refusing to display a title AO's own
// session is now carrying would leave the two disagreeing.
func NormalizeTitle(raw string) string {
	title := raw
	if idx := strings.IndexAny(title, "\r\n"); idx >= 0 {
		title = title[:idx]
	}
	title = strings.TrimSpace(title)

	// Markdown heading and list markers, which a model reaches for when asked for a
	// title and told nothing else.
	title = strings.TrimLeft(title, "#*->+ \t")
	// Wrapper punctuation, stripped from both ends so a quoted title is not shown
	// quoted and a backticked one is not shown as code.
	title = strings.Trim(title, "\"'`“”‘’ \t")
	title = strings.Join(strings.Fields(title), " ")
	title = strings.TrimRight(title, ".,;:!。 \t")

	if utf8.RuneCountInString(title) > maxTitleRunes {
		title = truncateAtWord(title, maxTitleRunes)
	}
	// A title made entirely of punctuation is not a title.
	if strings.IndexFunc(title, func(r rune) bool {
		return unicode.IsLetter(r) || unicode.IsDigit(r)
	}) < 0 {
		return ""
	}
	return title
}

// truncateAtWord cuts at the last space inside the limit, falling back to a hard cut
// for a language that does not put spaces between words.
func truncateAtWord(title string, limit int) string {
	runes := []rune(title)
	if len(runes) <= limit {
		return title
	}
	cut := string(runes[:limit])
	if idx := strings.LastIndex(cut, " "); idx > 0 {
		return strings.TrimRight(cut[:idx], " ")
	}
	return strings.TrimRight(cut, " ")
}
