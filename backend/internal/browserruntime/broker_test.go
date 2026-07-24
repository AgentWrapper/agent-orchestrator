package browserruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"
)

func TestBrokerExecuteRoundTrip(t *testing.T) {
	broker := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	if err := enc.Encode(wireMessage{Type: "hello", Version: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}
	waitConnected(t, broker)

	resultCh := make(chan Result, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := broker.Execute(context.Background(), "session-1", "snapshot", map[string]interface{}{"interactive": true})
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()

	var command wireMessage
	if err := dec.Decode(&command); err != nil {
		t.Fatal(err)
	}
	if command.Type != "command" || command.SessionID != "session-1" || command.Action != "snapshot" {
		t.Fatalf("command = %#v", command)
	}
	if err := enc.Encode(wireMessage{
		Type:      "result",
		RequestID: command.RequestID,
		OK:        true,
		Result:    json.RawMessage(`{"text":"button Save [ref=e1]"}`),
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errCh:
		t.Fatal(err)
	case result := <-resultCh:
		value := result.Value.(map[string]interface{})
		if value["text"] != "button Save [ref=e1]" {
			t.Fatalf("result = %#v", result.Value)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for result")
	}
}

func TestBrokerMapsRuntimeError(t *testing.T) {
	broker := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	_ = enc.Encode(wireMessage{Type: "hello", Version: ProtocolVersion})
	waitConnected(t, broker)

	errCh := make(chan error, 1)
	go func() {
		_, err := broker.Execute(context.Background(), "session-1", "click", map[string]interface{}{"ref": "e1"})
		errCh <- err
	}()
	var command wireMessage
	if err := dec.Decode(&command); err != nil {
		t.Fatal(err)
	}
	_ = enc.Encode(wireMessage{
		Type:      "result",
		RequestID: command.RequestID,
		Error:     &CommandError{Code: "STALE_REFERENCE", Message: "snapshot again"},
	})

	select {
	case err := <-errCh:
		var commandErr CommandError
		if !errors.As(err, &commandErr) || commandErr.Code != "STALE_REFERENCE" {
			t.Fatalf("error = %#v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for error")
	}
}

func TestBrokerUnavailableWithoutElectron(t *testing.T) {
	broker := New(nil)
	if _, err := broker.Execute(context.Background(), "session-1", "snapshot", nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

func waitConnected(t *testing.T, broker *Broker) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !broker.Status().Connected {
		if time.Now().After(deadline) {
			t.Fatal("browser runtime did not connect")
		}
		time.Sleep(time.Millisecond)
	}
}
