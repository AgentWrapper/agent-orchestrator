// Package claudecode drives Claude Code through `claude --print
// --output-format stream-json --input-format stream-json` over stdio and
// normalizes its frames into AO's provider-neutral Chat events.
//
// Transport: newline-delimited JSON, one long-lived child process serving many
// turns. It is NOT JSON-RPC, which is why this package carries its own transport
// rather than reusing codexappserver's:
//
//	client -> server   {"type":"user","message":{...}}                       a turn
//	client -> server   {"type":"control_request","request_id":S,"request":{"subtype":…}}
//	server -> client   {"type":"control_response","response":{"subtype":"success"|"error",…}}
//	server -> client   {"type":"control_request","request_id":S,"request":{"subtype":"can_use_tool",…}}
//	server -> client   {"type":"assistant"|"user"|"system"|"stream_event"|"result"|…}
//
// The correlation key is a client-chosen STRING in a `request_id` field, not a
// numeric `id`, and the same `control_request` envelope carries traffic in both
// directions. Nothing but the line framing and the pending-request bookkeeping is
// shared with the Codex transport, so folding the two together would mean an
// envelope abstraction plus per-provider codecs — more moving parts than the two
// readable transports it replaced, and a shape change in one provider's wire
// would then be able to break the other.
//
// Everything here was measured against claude 2.1.220 and cross-checked against
// the TypeScript SDK's own type declarations, which are authoritative for wire
// shapes AO does not exercise.
package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
)

// frame is the discriminator AO reads off every inbound line. The payload stays
// raw: only the normalizer knows what a given type means, and decoding twice is
// cheaper than a union struct that has to grow a field per provider addition.
type frame struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	// RequestID is set on both directions of the control channel.
	RequestID string `json:"request_id"`
	// Request is the inner payload of a server->client control_request.
	Request json.RawMessage `json:"request"`
	// Response is the envelope of a control_response, not the result inside it.
	Response json.RawMessage `json:"response"`
}

// controlEnvelope is the `response` object of a control_response. The result the
// caller wanted is nested one level deeper, and is absent for the subtypes that
// answer with nothing at all (rename_session, set_model).
type controlEnvelope struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response"`
	Error     string          `json:"error"`
}

// controlError is a refusal the CLI answered with. Kept as its own type so a
// caller can tell "the CLI said no" from "the CLI never answered": the first is a
// conflict the user can act on, the second means the process is gone.
type controlError struct {
	Subtype string
	Message string
}

func (e *controlError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("claude control error (%s): %s", e.Subtype, e.Message)
}

// notification is any inbound frame that is not part of the control channel:
// assistant and user messages, stream deltas, system bookkeeping, turn results.
type notification struct {
	Type    string
	Subtype string
	Raw     json.RawMessage
}

// controlRequestHandler answers a server->client control_request. Returning an
// error sends an error subtype back, which the CLI treats as a refusal to answer
// rather than as a decision.
type controlRequestHandler func(context.Context, serverRequest) (any, error)

// serverRequest is a control_request the CLI sent us. Approvals arrive this way
// and the CLI blocks its tool call on the reply.
type serverRequest struct {
	ID      string
	Subtype string
	Params  json.RawMessage
}

// ErrConnClosed reports use of a connection whose process has exited.
var ErrConnClosed = errors.New("claude stream connection closed")

// conn is one live stdio connection to a claude process.
//
// Transport only: framing, request/response correlation, and fan-out. It knows
// nothing about turns or sessions, so it can be tested over an in-memory pipe
// with no child process.
type conn struct {
	w   io.WriteCloser
	log *slog.Logger

	nextID atomic.Int64

	// writeMu serializes writes. It is never held while waiting for a response.
	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[string]chan controlEnvelope
	closed  bool

	// notifications is bounded. Overflow is dropped and logged rather than
	// allowed to block the reader, which would deadlock the CLI.
	notifications chan notification

	onControlRequest controlRequestHandler

	// done closes when the read loop exits, so a caller waiting on a response
	// learns the process died instead of blocking forever.
	done chan struct{}
	// readErr is set before done closes when the loop failed for a reason other
	// than clean EOF.
	readErr error
}

// notificationBuffer is generous because Claude is chatty in a way Codex is not:
// with --include-partial-messages a single sentence is a dozen frames, and one
// trivial turn also carries three hook start/response pairs.
const notificationBuffer = 8192

func newConn(w io.WriteCloser, r io.Reader, log *slog.Logger, onReq controlRequestHandler) *conn {
	c := &conn{
		w:                w,
		log:              log,
		pending:          make(map[string]chan controlEnvelope),
		notifications:    make(chan notification, notificationBuffer),
		onControlRequest: onReq,
		done:             make(chan struct{}),
	}
	go c.readLoop(r)
	return c
}

// notifs is the stream the caller consumes. Closed when the connection ends.
func (c *conn) notifs() <-chan notification { return c.notifications }

// wait returns a channel closed when the connection ends.
func (c *conn) wait() <-chan struct{} { return c.done }

// err reports why the read loop stopped, or nil for a clean end.
func (c *conn) err() error {
	select {
	case <-c.done:
		return c.readErr
	default:
		return nil
	}
}

func (c *conn) readLoop(r io.Reader) {
	defer func() {
		c.mu.Lock()
		c.closed = true
		pending := c.pending
		c.pending = map[string]chan controlEnvelope{}
		c.mu.Unlock()

		// Unblock every in-flight request so no caller hangs on a dead process.
		for _, ch := range pending {
			close(ch)
		}
		close(c.notifications)
		close(c.done)
	}()

	// A generous starting buffer because a single frame is genuinely large here:
	// a `result` carries the whole final message, and a tool_result carries a
	// command's entire output.
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := readFrame(br)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				c.readErr = err
			}
			return
		}
		if len(line) == 0 {
			continue
		}

		var f frame
		if err := json.Unmarshal(line, &f); err != nil {
			// One unparseable frame must not kill the connection: the CLI may add
			// fields or emit something this build does not model.
			c.log.Warn("claude frame not parseable", "error", err)
			continue
		}

		switch f.Type {
		case "control_request":
			// Every control_request on stdout is server->client; AO never reads
			// back what it wrote.
			go c.answer(serverRequest{ID: f.RequestID, Subtype: controlSubtype(f.Request), Params: f.Request})
		case "control_response":
			c.deliver(f.Response)
		case "control_cancel_request":
			// The CLI withdrew a request it had asked us to answer. Nothing to do at
			// this layer: the handler's own context ends when the conversation does,
			// and a reply to a withdrawn id is discarded by the CLI. Named here so a
			// reader does not mistake it for an unhandled inbound request.
			c.log.Debug("claude cancelled a control request", "id", f.RequestID)
		default:
			select {
			case c.notifications <- notification{Type: f.Type, Subtype: f.Subtype, Raw: line}:
			default:
				c.log.Warn("dropped claude frame: buffer full", "type", f.Type, "subtype", f.Subtype)
			}
		}
	}
}

// controlSubtype reads the discriminator out of a control_request's inner
// payload. An unparseable payload yields "", which the handler refuses.
func controlSubtype(raw json.RawMessage) string {
	var inner struct {
		Subtype string `json:"subtype"`
	}
	if err := json.Unmarshal(raw, &inner); err != nil {
		return ""
	}
	return inner.Subtype
}

// readFrame reads one newline-delimited frame with no length cap, so a large
// tool result cannot truncate the stream mid-JSON.
func readFrame(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			if len(buf) > 0 && errors.Is(err, io.EOF) {
				return trimEOL(buf), nil
			}
			return nil, err
		}
		return trimEOL(buf), nil
	}
}

func trimEOL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

func (c *conn) deliver(raw json.RawMessage) {
	var env controlEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.log.Warn("claude control_response not parseable", "error", err)
		return
	}
	if env.RequestID == "" {
		c.log.Warn("claude control_response carried no request id")
		return
	}

	c.mu.Lock()
	ch, ok := c.pending[env.RequestID]
	delete(c.pending, env.RequestID)
	c.mu.Unlock()

	if !ok {
		// A response for a request we already gave up on. Expected after a context
		// timeout; not an error.
		c.log.Debug("claude response for unknown request id", "id", env.RequestID)
		return
	}
	ch <- env
}

// answer runs the server-request handler and writes the reply. It runs on its own
// goroutine so a slow decision (a user staring at an approval card) does not
// stall the read loop and starve streaming deltas.
func (c *conn) answer(req serverRequest) {
	result, err := c.onControlRequest(context.Background(), req)

	envelope := map[string]any{"request_id": req.ID}
	if err != nil {
		envelope["subtype"] = "error"
		envelope["error"] = err.Error()
	} else {
		envelope["subtype"] = "success"
		envelope["response"] = result
	}
	if werr := c.write(map[string]any{"type": "control_response", "response": envelope}); werr != nil {
		c.log.Error("failed to answer claude control request", "subtype", req.Subtype, "error", werr)
	}
}

func (c *conn) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	b = append(b, '\n')

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.w.Write(b); err != nil {
		return fmt.Errorf("write frame: %w", err)
	}
	return nil
}

// request sends a client->server control_request and waits for its response. The
// caller's context bounds the wait; a late response is discarded by deliver.
//
// out is filled from the INNER `response` object, not the envelope, and is left
// untouched when the CLI answered with nothing — several subtypes acknowledge
// with a bare success.
func (c *conn) request(ctx context.Context, subtype string, params map[string]any, out any) error {
	// A client-chosen string, not a number. The CLI echoes it verbatim, so the
	// prefix makes an AO request identifiable in a captured transcript.
	id := "ao-" + subtype + "-" + strconv.FormatInt(c.nextID.Add(1), 10)
	ch := make(chan controlEnvelope, 1)

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return fmt.Errorf("%s: %w", subtype, ErrConnClosed)
	}
	c.pending[id] = ch
	c.mu.Unlock()

	inner := map[string]any{"subtype": subtype}
	for k, v := range params {
		inner[k] = v
	}
	if err := c.write(map[string]any{
		"type":       "control_request",
		"request_id": id,
		"request":    inner,
	}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("%s: %w", subtype, err)
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("%s: %w", subtype, ctx.Err())

	case env, ok := <-ch:
		if !ok {
			return fmt.Errorf("%s: %w", subtype, ErrConnClosed)
		}
		if env.Subtype != "success" {
			return fmt.Errorf("%s: %w", subtype, &controlError{Subtype: env.Subtype, Message: env.Error})
		}
		if out != nil && len(env.Response) > 0 {
			if err := json.Unmarshal(env.Response, out); err != nil {
				return fmt.Errorf("%s: decode result: %w", subtype, err)
			}
		}
		return nil
	}
}

// send writes a frame that expects no reply. A user message is the only one AO
// sends: the CLI acknowledges a turn by starting it, not by answering.
func (c *conn) send(v any) error { return c.write(v) }
