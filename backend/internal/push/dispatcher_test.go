package push

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

type fakeSubscriber struct {
	ch chan domain.NotificationRecord
}

func (f *fakeSubscriber) Subscribe(domain.ProjectID) (<-chan domain.NotificationRecord, func()) {
	return f.ch, func() {}
}

type fakeDeviceStore struct {
	mu      sync.Mutex
	devices []mobilebridge.PushDevice
	deleted []string
}

func (f *fakeDeviceStore) List() []mobilebridge.PushDevice {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]mobilebridge.PushDevice(nil), f.devices...)
}

func (f *fakeDeviceStore) Delete(token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, token)
	return nil
}

type fakeSender struct {
	mu       sync.Mutex
	gotMsgs  []Message
	tickets  []Ticket
	sendErr  error
	sentCond *sync.Cond
	sent     bool
}

func newFakeSender(tickets []Ticket) *fakeSender {
	f := &fakeSender{tickets: tickets}
	f.sentCond = sync.NewCond(&f.mu)
	return f
}

func (f *fakeSender) Send(_ context.Context, messages []Message) ([]Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gotMsgs = append(f.gotMsgs, messages...)
	f.sent = true
	f.sentCond.Broadcast()
	if f.sendErr != nil {
		return nil, f.sendErr
	}
	return f.tickets, nil
}

func (f *fakeSender) waitSent(t *testing.T) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		f.mu.Lock()
		for !f.sent {
			f.sentCond.Wait()
		}
		f.mu.Unlock()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for send")
	}
}

func TestDispatcherSendsToAllDevicesWithDataBlob(t *testing.T) {
	sub := &fakeSubscriber{ch: make(chan domain.NotificationRecord, 1)}
	store := &fakeDeviceStore{devices: []mobilebridge.PushDevice{
		{Token: "ExponentPushToken[a]"},
		{Token: "ExponentPushToken[b]"},
	}}
	sender := newFakeSender([]Ticket{{Status: "ok"}, {Status: "ok"}})
	d := NewDispatcher(sub, store, sender, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)

	sub.ch <- domain.NotificationRecord{
		ID:        "ntf_1",
		SessionID: "sess_9",
		ProjectID: "proj_7",
		PRURL:     "https://example.com/pr/3",
		Type:      domain.NotificationNeedsInput,
		Title:     "sess needs input",
		Body:      "The agent is waiting for your response.",
	}
	sender.waitSent(t)

	sender.mu.Lock()
	defer sender.mu.Unlock()
	if len(sender.gotMsgs) != 2 {
		t.Fatalf("messages = %d, want 2", len(sender.gotMsgs))
	}
	m := sender.gotMsgs[0]
	if m.Title != "sess needs input" || m.Body == "" {
		t.Fatalf("message copy = %+v", m)
	}
	if m.Priority != "high" || m.Sound != "default" || m.ChannelID != "default" {
		t.Fatalf("channel/priority/sound = %+v", m)
	}
	if m.Data["type"] != "needs_input" || m.Data["sessionId"] != "sess_9" ||
		m.Data["projectId"] != "proj_7" || m.Data["prUrl"] != "https://example.com/pr/3" ||
		m.Data["notificationId"] != "ntf_1" {
		t.Fatalf("data blob = %+v", m.Data)
	}
}

func TestDispatcherPrunesDeadTokens(t *testing.T) {
	sub := &fakeSubscriber{ch: make(chan domain.NotificationRecord, 1)}
	store := &fakeDeviceStore{devices: []mobilebridge.PushDevice{
		{Token: "ExponentPushToken[live]"},
		{Token: "ExponentPushToken[dead]"},
	}}
	// Second ticket reports the token is gone.
	dead := Ticket{Status: "error"}
	dead.Details.Error = "DeviceNotRegistered"
	sender := newFakeSender([]Ticket{{Status: "ok"}, dead})
	d := NewDispatcher(sub, store, sender, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)

	sub.ch <- domain.NotificationRecord{ID: "ntf_1", Type: domain.NotificationNeedsInput, Title: "t", Body: "b"}
	sender.waitSent(t)

	// Give dispatch() a beat to finish the prune after Send returned.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		n := len(store.deleted)
		store.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.deleted) != 1 || store.deleted[0] != "ExponentPushToken[dead]" {
		t.Fatalf("deleted = %v, want [ExponentPushToken[dead]]", store.deleted)
	}
}

func TestDispatcherNoDevicesIsNoop(t *testing.T) {
	sub := &fakeSubscriber{ch: make(chan domain.NotificationRecord, 1)}
	store := &fakeDeviceStore{}
	sender := newFakeSender(nil)
	d := NewDispatcher(sub, store, sender, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)

	sub.ch <- domain.NotificationRecord{ID: "ntf_1", Type: domain.NotificationNeedsInput, Title: "t", Body: "b"}
	// No devices → sender must never be called. Give the loop a moment.
	time.Sleep(100 * time.Millisecond)
	sender.mu.Lock()
	defer sender.mu.Unlock()
	if sender.sent {
		t.Fatal("sender was called despite no registered devices")
	}
}
