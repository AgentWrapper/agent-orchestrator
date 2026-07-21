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
	mu         sync.Mutex
	gotMsgs    []Message
	tickets    []Ticket
	sendErr    error
	sentCond   *sync.Cond
	sent       bool
	gotIDs     []string           // ids passed to GetReceipts
	receipts   map[string]Receipt // returned by GetReceipts
	receiptErr error
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

func (f *fakeSender) GetReceipts(_ context.Context, ids []string) (map[string]Receipt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gotIDs = append(f.gotIDs, ids...)
	return f.receipts, f.receiptErr
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

func TestDispatcherSweepPrunesOnReceipt(t *testing.T) {
	store := &fakeDeviceStore{devices: []mobilebridge.PushDevice{{Token: "ExponentPushToken[dead]"}}}
	sender := newFakeSender(nil)
	dead := Receipt{Status: "error"}
	dead.Details.Error = "DeviceNotRegistered"
	sender.receipts = map[string]Receipt{"tk1": dead}
	d := NewDispatcher(&fakeSubscriber{ch: make(chan domain.NotificationRecord)}, store, sender, nil)

	base := time.Now()
	d.clock = func() time.Time { return base }
	// A ticket sent 16 minutes ago is due for a receipt check.
	d.trackAccepted([]sentTicket{{id: "tk1", token: "ExponentPushToken[dead]", sentAt: base.Add(-16 * time.Minute)}})
	d.sweepReceipts(context.Background())

	sender.mu.Lock()
	queried := append([]string(nil), sender.gotIDs...)
	sender.mu.Unlock()
	if len(queried) != 1 || queried[0] != "tk1" {
		t.Fatalf("queried ids = %v, want [tk1]", queried)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.deleted) != 1 || store.deleted[0] != "ExponentPushToken[dead]" {
		t.Fatalf("deleted = %v, want [ExponentPushToken[dead]]", store.deleted)
	}
}

func TestDispatcherSweepSkipsFreshAndDropsExpired(t *testing.T) {
	store := &fakeDeviceStore{}
	sender := newFakeSender(nil)
	d := NewDispatcher(&fakeSubscriber{ch: make(chan domain.NotificationRecord)}, store, sender, nil)

	base := time.Now()
	d.clock = func() time.Time { return base }
	d.trackAccepted([]sentTicket{
		{id: "fresh", token: "ExponentPushToken[a]", sentAt: base.Add(-1 * time.Minute)}, // too new to check
		{id: "expired", token: "ExponentPushToken[b]", sentAt: base.Add(-2 * time.Hour)}, // past max age → dropped
	})
	d.sweepReceipts(context.Background())

	sender.mu.Lock()
	nQueried := len(sender.gotIDs)
	sender.mu.Unlock()
	if nQueried != 0 {
		t.Fatalf("queried %d ids, want 0 (fresh kept, expired dropped un-queried)", nQueried)
	}
	d.mu.Lock()
	pending := len(d.pending)
	d.mu.Unlock()
	if pending != 1 {
		t.Fatalf("pending = %d, want 1 (only the fresh ticket remains)", pending)
	}
}
