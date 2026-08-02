package codexappserver

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Conversation history operations: rollback, fork, and the thread title.
//
// Each wire shape below was measured against a live `codex app-server` 0.146.0
// rather than read off the generated schema, because two of them do not do what
// their names suggest:
//
//   - thread/rollback takes {threadId, numTurns} and drops numTurns turns from the
//     END of the thread. It takes no turn id at all, which is why rolling back to a
//     turn the user pointed at has to read the thread's own turn list and count
//     backwards from it.
//   - thread/fork takes {threadId, lastTurnId?} and answers with a NEW thread id.
//     Omitting cwd makes the fork inherit the source thread's working directory,
//     which is the only directory whose files match the history being copied.
//
// The provider's refusals are as load-bearing as its successes, so they are
// recorded here too. All three arrive as code -32600:
//
//	rollback mid-turn      "Cannot rollback while a turn is in progress."
//	rollback numTurns < 1  "numTurns must be >= 1"
//	fork through live turn "lastTurnId '...' identifies an in-progress turn"
//	blank title            "thread name must not be empty"
//	unloaded thread        "thread not found: <id>"
//
// thread/rollback is annotated DEPRECATED in the protocol schema, and the
// provider's own `undo` experimental feature already reports stage "removed". It
// works on 0.146.0. When it goes, the replacement is thread/fork with lastTurnId,
// which yields a different thread id — something ChatRollbacker cannot report, so
// that day needs a port change and not a swap of the call in here.

// Asserted so a refactor cannot silently drop one of these: the service
// feature-detects each interface, and a missing method would read as "the provider
// cannot do this" with nothing anywhere to notice.
var (
	_ ports.ChatRollbacker = (*conversation)(nil)
	_ ports.ChatForker     = (*conversation)(nil)
	_ ports.ChatRenamer    = (*conversation)(nil)
)

// providerRefusal marks a request the provider rejected on its own terms, as
// opposed to one that never got through.
//
// The distinction has to survive the trip out of this package: a refusal is a
// conflict the user can act on ("stop the turn first"), while a transport failure
// is an internal error. Reporting the first as the second is how a perfectly
// ordinary "not right now" reaches someone as "Internal server error".
//
// It travels as a behaviour rather than a sentinel because the layer that needs to
// classify it — the Chat service — must not import an adapter, and this adapter
// must not own service vocabulary. A one-method interface satisfied structurally
// is what lets both stay put.
type providerRefusal struct{ err error }

func (e *providerRefusal) Error() string { return e.err.Error() }
func (e *providerRefusal) Unwrap() error { return e.err }

// ChatRefusal reports that the provider declined the request and the conversation
// is otherwise healthy.
func (e *providerRefusal) ChatRefusal() bool { return true }

// refuse builds a refusal AO decided on itself, for the cases where the provider
// would refuse anyway and saying so locally keeps the message about the caller's
// input instead of about the protocol.
func refuse(format string, args ...any) error {
	return &providerRefusal{err: fmt.Errorf(format, args...)}
}

// asRefusal reclassifies a provider error when the provider itself said no.
//
// app-server answers -32600 for anything it considers invalid or not permitted at
// this moment, and that is the only class where the connection is fine and the
// request is the thing at fault. Everything else — a dead process, a decode
// failure, a context deadline — stays an error.
func asRefusal(err error) error {
	var rpcErr *rpcError
	if errors.As(err, &rpcErr) && rpcErr.Code == -32600 {
		return &providerRefusal{err: err}
	}
	return err
}

// providerTurn is the subset of a thread's turn list AO reads.
type providerTurn struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// Rollback discards the named turn and every turn after it, provider-side.
//
// Inclusive of the named turn on purpose: this is undo, and the thing a person
// wants back is the state from before they sent the message they are pointing at.
// Keeping that turn would leave the exchange they are trying to take back in the
// agent's memory, which is the one outcome that makes the button pointless.
//
// It changes what the agent remembers. AO's rows have to follow, and that is the
// caller's job — see the Chat controller.
func (c *conversation) Rollback(ctx context.Context, providerTurnID string) error {
	if strings.TrimSpace(providerTurnID) == "" {
		return errors.New("rollback needs a provider turn id")
	}

	// Serialized with turn dispatch: the count computed below is only valid for the
	// turn list it was read from, and a turn starting in between would shift every
	// position in it.
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	turns, err := c.readTurns(ctx)
	if err != nil {
		return err
	}

	discard := 0
	for i, turn := range turns {
		if turn.ID == providerTurnID {
			discard = len(turns) - i
			break
		}
	}
	if discard == 0 {
		// Either the turn was already discarded or it belongs to history this thread
		// no longer holds. Refusing beats guessing: any count AO invented here would
		// discard turns the user never named.
		return refuse("turn %q is not in the provider's history", providerTurnID)
	}

	if err := c.conn.request(ctx, "thread/rollback", map[string]any{
		"threadId": c.threadID,
		"numTurns": discard,
	}, nil); err != nil {
		return asRefusal(fmt.Errorf("thread/rollback: %w", err))
	}
	return nil
}

// readTurns is the provider's own turn list for this thread, oldest first.
//
// Read from the provider rather than counted from AO's rows because the two sets
// legitimately differ: AO records a turn whose dispatch the provider rejected, and
// a turn from before a resume may be absent here. thread/rollback counts in the
// provider's terms, so counting in AO's would discard the wrong number of turns.
func (c *conversation) readTurns(ctx context.Context) ([]providerTurn, error) {
	var resp struct {
		Thread struct {
			Turns []providerTurn `json:"turns"`
		} `json:"thread"`
	}
	if err := c.conn.request(ctx, "thread/read", map[string]any{
		"threadId":     c.threadID,
		"includeTurns": true,
	}, &resp); err != nil {
		return nil, asRefusal(fmt.Errorf("thread/read: %w", err))
	}
	return resp.Thread.Turns, nil
}

// Fork branches this conversation into a second provider conversation, so an
// alternative approach can be tried without destroying the original.
//
// The whole history is copied: ChatForker names no turn, and a fork that silently
// truncated would be a rollback wearing the wrong name.
func (c *conversation) Fork(ctx context.Context) (string, error) {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	var resp struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	// cwd is deliberately absent so the fork inherits the source thread's working
	// directory. A fork pointed at a different tree would remember editing files
	// that are not there.
	if err := c.conn.request(ctx, "thread/fork", map[string]any{
		"threadId": c.threadID,
	}, &resp); err != nil {
		return "", asRefusal(fmt.Errorf("thread/fork: %w", err))
	}
	if resp.Thread.ID == "" {
		return "", errors.New("thread/fork returned no thread id")
	}
	return resp.Thread.ID, nil
}

// SetTitle names the thread provider-side.
//
// Nothing is written to AO's rows here. The provider answers a bare {} and then
// emits thread/name/updated, and that notification is the single path by which a
// title reaches AO — including when the name was set by some other client
// entirely. Writing it optimistically as well would give AO two sources for one
// fact and no way to tell which one lost.
func (c *conversation) SetTitle(ctx context.Context, title string) error {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return refuse("thread title must not be empty")
	}

	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	if err := c.conn.request(ctx, "thread/name/set", map[string]any{
		"threadId": c.threadID,
		"name":     trimmed,
	}, nil); err != nil {
		return asRefusal(fmt.Errorf("thread/name/set: %w", err))
	}
	return nil
}
