package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

type fakeProxy struct {
	calls []struct {
		method, path string
		body         any
	}
	status int
	err    error
}

func (p *fakeProxy) ProxyFetch(_ context.Context, _ string, method, apiPath string, body any) (int, json.RawMessage, error) {
	p.calls = append(p.calls, struct {
		method, path string
		body         any
	}{method, apiPath, body})
	if p.err != nil {
		return 0, nil, p.err
	}
	st := p.status
	if st == 0 {
		st = 200
	}
	return st, nil, nil
}

func TestRelay_SendMapsToSessionSend(t *testing.T) {
	p := &fakeProxy{}
	r := newSupervisorRelay(p)
	if err := r.Relay(context.Background(), "https://preview/x", Command{Op: "send", SessionID: "w1", Message: "go"}); err != nil {
		t.Fatalf("relay: %v", err)
	}
	if len(p.calls) != 1 || p.calls[0].method != "POST" || p.calls[0].path != "/api/v1/sessions/w1/send" {
		t.Fatalf("bad call %+v", p.calls)
	}
}

func TestRelay_KillAndSpawnPaths(t *testing.T) {
	p := &fakeProxy{}
	r := newSupervisorRelay(p)
	_ = r.Relay(context.Background(), "u", Command{Op: "kill", SessionID: "w1"})
	_ = r.Relay(context.Background(), "u", Command{Op: "spawn", Spec: json.RawMessage(`{"kind":"worker"}`)})
	if p.calls[0].path != "/api/v1/sessions/w1/kill" {
		t.Fatalf("kill path %q", p.calls[0].path)
	}
	if p.calls[1].path != "/api/v1/sessions" {
		t.Fatalf("spawn path %q", p.calls[1].path)
	}
}

func TestRelay_UnknownOp(t *testing.T) {
	if err := newSupervisorRelay(&fakeProxy{}).Relay(context.Background(), "u", Command{Op: "nope", SessionID: "w"}); err == nil {
		t.Fatal("want error for unknown op")
	}
}

func TestRelay_Non2xxIsError(t *testing.T) {
	p := &fakeProxy{status: 502}
	if err := newSupervisorRelay(p).Relay(context.Background(), "u", Command{Op: "kill", SessionID: "w"}); err == nil {
		t.Fatal("want error on 502")
	}
}

func TestRelay_ProxyErrorPropagates(t *testing.T) {
	p := &fakeProxy{err: errors.New("dial failed")}
	if err := newSupervisorRelay(p).Relay(context.Background(), "u", Command{Op: "kill", SessionID: "w"}); err == nil {
		t.Fatal("want proxy error to propagate")
	}
}

func TestRelay_EventInjectsAsMessage(t *testing.T) {
	p := &fakeProxy{}
	r := newSupervisorRelay(p)
	if err := r.RelayEvent(context.Background(), "u", Event{ToSessionID: "orch1", Kind: "message", Data: json.RawMessage(`"done"`)}); err != nil {
		t.Fatalf("relay event: %v", err)
	}
	if p.calls[0].path != "/api/v1/sessions/orch1/send" {
		t.Fatalf("event path %q", p.calls[0].path)
	}
}
