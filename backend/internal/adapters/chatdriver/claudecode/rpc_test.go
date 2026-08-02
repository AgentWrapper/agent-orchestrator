package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// fakeCLI stands in for the claude child process over in-memory pipes, so the
// transport is tested without spawning anything.
type fakeCLI struct {
	t *testing.T
	// frames receives every frame the client wrote.
	frames chan sentFrame
	// toClient is written by the test to push frames at the client.
	toClient io.WriteCloser
}

func newFakeCLI(t *testing.T, onReq controlRequestHandler) (*conn, *fakeCLI) {
	t.Helper()

	clientReads, serverWrites := io.Pipe()
	serverReads, clientWrites := io.Pipe()

	fake := &fakeCLI{
		t:        t,
		frames:   make(chan sentFrame, 32),
		toClient: serverWrites,
	}

	// Drain what the client sends so writes never block, recording each frame.
	go func() {
		br := bufio.NewReader(serverReads)
		for {
			line, err := readFrame(br)
			if err != nil {
				close(fake.frames)
				return
			}
			if len(line) == 0 {
				continue
			}
			var f sentFrame
			if err := json.Unmarshal(line, &f); err != nil {
				continue
			}
			f.Raw = string(line)
			f.Subtype = controlSubtype(f.Request)
			fake.frames <- f
		}
	}()

	c := newConn(clientWrites, clientReads, slog.New(slog.DiscardHandler), onReq)
	t.Cleanup(func() {
		_ = serverWrites.Close()
		_ = clientWrites.Close()
	})
	return c, fake
}

// Replies below are all single lines. readFrame is line-delimited, so a
// pretty-printed reply would leave the client waiting on a newline that never
// arrives: the test would hang forever instead of failing.
func (f *fakeCLI) push(raw string) {
	f.t.Helper()
	if _, err := io.WriteString(f.toClient, raw+"\n"); err != nil {
		f.t.Fatalf("push: %v", err)
	}
}

func (f *fakeCLI) next() sentFrame {
	f.t.Helper()
	select {
	case frame, ok := <-f.frames:
		if !ok {
			f.t.Fatal("client stream closed")
		}
		return frame
	case <-time.After(5 * time.Second):
		f.t.Fatal("timed out waiting for a client frame")
		return sentFrame{}
	}
}

func refuseAll(context.Context, serverRequest) (any, error) {
	return nil, errors.New("no handler in this test")
}

// The correlation key is a client-chosen STRING in request_id, not a numeric id.
// A response is matched on it and the result the caller wanted is nested one level
// inside the envelope.
func TestRequestCorrelatesOnTheStringRequestID(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)

	type result struct {
		Version string `json:"version"`
	}
	done := make(chan error, 1)
	var got result
	go func() { done <- c.request(context.Background(), "get_binary_version", nil, &got) }()

	sent := fake.next()
	if sent.Type != "control_request" || sent.Subtype != "get_binary_version" {
		t.Fatalf("sent %s", sent.Raw)
	}
	if sent.RequestID == "" {
		t.Fatal("request carried no request_id")
	}

	fake.push(`{"type":"control_response","response":{"subtype":"success","request_id":` +
		quote(sent.RequestID) + `,"response":{"version":"2.1.220","buildTime":"2026-07-24T22:17:45Z"}}}`)

	if err := <-done; err != nil {
		t.Fatalf("request: %v", err)
	}
	if got.Version != "2.1.220" {
		t.Fatalf("version = %q", got.Version)
	}
}

// Several subtypes acknowledge with a bare success and no inner response object.
// Treating that as a decode failure would break rename_session and set_model.
func TestRequestAcceptsABareSuccess(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)

	done := make(chan error, 1)
	var out struct {
		Untouched string `json:"untouched"`
	}
	go func() { done <- c.request(context.Background(), "rename_session", map[string]any{"title": "x"}, &out) }()

	sent := fake.next()
	fake.push(`{"type":"control_response","response":{"subtype":"success","request_id":` + quote(sent.RequestID) + `}}`)

	if err := <-done; err != nil {
		t.Fatalf("request: %v", err)
	}
}

// A refusal the CLI answered with is a different thing from a process that never
// answered: the first is a conflict the user can act on.
func TestRequestSurfacesAControlError(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)

	done := make(chan error, 1)
	go func() {
		done <- c.request(context.Background(), "set_permission_mode", map[string]any{"mode": "bypassPermissions"}, nil)
	}()

	sent := fake.next()
	fake.push(`{"type":"control_response","response":{"subtype":"error","request_id":` + quote(sent.RequestID) +
		`,"error":"Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"}}`)

	err := <-done
	var controlErr *controlError
	if !errors.As(err, &controlErr) {
		t.Fatalf("error = %v, want a controlError", err)
	}
	if !strings.Contains(controlErr.Message, "dangerously-skip-permissions") {
		t.Fatalf("message = %q", controlErr.Message)
	}
}

// A caller waiting on a response must learn the process died rather than block
// forever.
func TestRequestFailsWhenTheProcessGoesAway(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)

	done := make(chan error, 1)
	go func() { done <- c.request(context.Background(), "list_models", nil, nil) }()
	fake.next()
	_ = fake.toClient.Close()

	select {
	case err := <-done:
		if !errors.Is(err, ErrConnClosed) {
			t.Fatalf("error = %v, want ErrConnClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a request outlived the process it was waiting on")
	}
}

// One unparseable frame must not kill the connection: the CLI may add fields or
// emit something this build does not model.
func TestUnparseableFrameDoesNotKillTheConnection(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)

	fake.push(`{"type":"assistant",`)
	fake.push(`{"type":"result","subtype":"success","is_error":false}`)

	select {
	case n, ok := <-c.notifs():
		if !ok {
			t.Fatal("notification stream closed after a bad frame")
		}
		if n.Type != "result" {
			t.Fatalf("first surviving frame = %q", n.Type)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a bad frame swallowed the connection")
	}
}

// A slow decision — a user staring at an approval card — must not stall the read
// loop, or streaming deltas starve behind it.
func TestSlowControlRequestHandlerDoesNotStallTheReader(t *testing.T) {
	release := make(chan struct{})
	handled := make(chan struct{})

	c, fake := newFakeCLI(t, func(context.Context, serverRequest) (any, error) {
		close(handled)
		<-release
		return map[string]any{"behavior": "allow"}, nil
	})

	fake.push(`{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"t1"}}`)
	<-handled

	// Frames sent while the handler is parked still arrive.
	fake.push(`{"type":"result","subtype":"success","is_error":false}`)
	select {
	case n := <-c.notifs():
		if n.Type != "result" {
			t.Fatalf("frame = %q", n.Type)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the reader stalled behind a parked handler")
	}

	close(release)
	reply := fake.next()
	if !strings.Contains(reply.Raw, `"request_id":"req-1"`) {
		t.Fatalf("reply = %s", reply.Raw)
	}
}

// The reply envelope shape is the CLI's, not one AO invented: subtype and
// request_id sit on the envelope, and the answer nests inside it.
func TestControlRequestReplyShape(t *testing.T) {
	_, fake := newFakeCLI(t, func(context.Context, serverRequest) (any, error) {
		return map[string]any{"behavior": "deny", "message": "no"}, nil
	})

	fake.push(`{"type":"control_request","request_id":"req-2","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"t2"}}`)

	reply := fake.next()
	if reply.Type != "control_response" {
		t.Fatalf("reply type = %q", reply.Type)
	}
	var envelope controlEnvelope
	if err := json.Unmarshal(reply.Response, &envelope); err != nil {
		t.Fatalf("reply envelope: %v (%s)", err, reply.Raw)
	}
	if envelope.Subtype != "success" || envelope.RequestID != "req-2" {
		t.Fatalf("envelope = %+v", envelope)
	}
	if !strings.Contains(string(envelope.Response), `"behavior":"deny"`) {
		t.Fatalf("inner response = %s", envelope.Response)
	}
}

// A handler that refuses answers with the error subtype, which the CLI reads as
// "this client will not decide" rather than as a decision.
func TestRefusedControlRequestAnswersWithTheErrorSubtype(t *testing.T) {
	_, fake := newFakeCLI(t, refuseAll)

	fake.push(`{"type":"control_request","request_id":"req-3","request":{"subtype":"something_new"}}`)

	reply := fake.next()
	var envelope controlEnvelope
	if err := json.Unmarshal(reply.Response, &envelope); err != nil {
		t.Fatalf("reply envelope: %v", err)
	}
	if envelope.Subtype != "error" || envelope.Error == "" {
		t.Fatalf("envelope = %+v", envelope)
	}
}

// A single frame is genuinely large here: a tool_result carries a command's whole
// output, and the read buffer is a megabyte. A frame that spans it must arrive
// whole, because a truncated one is unparseable and would be dropped silently.
func TestReadFrameHandlesFramesLargerThanTheBuffer(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)

	big := strings.Repeat("x", 2<<20)
	// Written from a goroutine because the pipe blocks until the client reads, and
	// with io.WriteString rather than push so no assertion runs off the test's own
	// goroutine.
	go func() {
		_, _ = io.WriteString(fake.toClient,
			`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"`+big+`"}]}}`+"\n")
	}()

	select {
	case n, ok := <-c.notifs():
		if !ok {
			t.Fatal("notification stream closed on a large frame")
		}
		var p messageEnvelope
		if err := json.Unmarshal(n.Raw, &p); err != nil {
			t.Fatalf("large frame did not survive the reader: %v", err)
		}
		if len(p.Message.Content) != 1 || len(toolResultText(p.Message.Content[0].Content)) != len(big) {
			t.Fatalf("large frame was truncated")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out on a large frame")
	}
}

func TestClosedConnectionRejectsNewRequests(t *testing.T) {
	c, fake := newFakeCLI(t, refuseAll)
	_ = fake.toClient.Close()

	// Wait for the read loop to notice.
	select {
	case <-c.wait():
	case <-time.After(5 * time.Second):
		t.Fatal("the read loop did not end after the process went away")
	}

	if err := c.request(context.Background(), "list_models", nil, nil); !errors.Is(err, ErrConnClosed) {
		t.Fatalf("error = %v, want ErrConnClosed", err)
	}
}
