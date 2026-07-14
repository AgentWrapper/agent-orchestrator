package push

import (
	"context"
	"io"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// Subscriber is the notification fan-out source the dispatcher listens on,
// satisfied by *notify.Hub. Empty projectID receives all projects.
type Subscriber interface {
	Subscribe(projectID domain.ProjectID) (<-chan domain.NotificationRecord, func())
}

// DeviceStore is the registered-device view the dispatcher needs: enumerate
// targets and prune dead tokens. Satisfied by *mobilebridge.DeviceRegistry.
type DeviceStore interface {
	List() []mobilebridge.PushDevice
	Delete(token string) error
}

// Sender delivers Expo messages and returns one ticket per message in order.
// Satisfied by *ExpoClient.
type Sender interface {
	Send(ctx context.Context, messages []Message) ([]Ticket, error)
}

// androidChannelID is the single high-importance channel the client registers so
// needs-input notifications actually buzz.
const androidChannelID = "default"

// Dispatcher subscribes to the notification hub and, per new notification, sends
// an OS push to every registered device via Expo, pruning tokens Expo reports as
// dead. It is an additive hub subscriber: SSE and the persistence path are
// untouched, and a slow/failing Expo call can never stall a notification insert.
type Dispatcher struct {
	sub     Subscriber
	devices DeviceStore
	sender  Sender
	log     *slog.Logger
}

// NewDispatcher constructs a Dispatcher. A nil logger is tolerated (discarded).
func NewDispatcher(sub Subscriber, devices DeviceStore, sender Sender, log *slog.Logger) *Dispatcher {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Dispatcher{sub: sub, devices: devices, sender: sender, log: log}
}

// Run subscribes and dispatches until ctx is cancelled. It blocks, so callers run
// it in a goroutine. It unsubscribes on return.
func (d *Dispatcher) Run(ctx context.Context) {
	ch, unsubscribe := d.sub.Subscribe("")
	defer unsubscribe()
	for {
		select {
		case <-ctx.Done():
			return
		case rec, ok := <-ch:
			if !ok {
				return
			}
			d.dispatch(ctx, rec)
		}
	}
}

// dispatch sends one notification record to every registered device and prunes
// any token Expo reports as no longer registered.
func (d *Dispatcher) dispatch(ctx context.Context, rec domain.NotificationRecord) {
	devices := d.devices.List()
	if len(devices) == 0 {
		return
	}
	messages := make([]Message, 0, len(devices))
	for _, dev := range devices {
		messages = append(messages, messageFor(rec, dev.Token))
	}
	tickets, err := d.sender.Send(ctx, messages)
	if err != nil {
		d.log.Warn("push send failed", "err", err, "notification", rec.ID, "devices", len(messages))
		return
	}
	// Tickets are 1:1 with messages, in order. Prune dead tokens.
	for i, t := range tickets {
		if i >= len(messages) {
			break
		}
		if t.IsDeviceNotRegistered() {
			token := messages[i].To
			if delErr := d.devices.Delete(token); delErr != nil {
				d.log.Warn("prune dead push token failed", "err", delErr)
			} else {
				d.log.Info("pruned dead push token")
			}
		}
	}
}

// messageFor builds the Expo message for one device from a notification record.
// The data blob carries exactly what the app needs to deep-link on tap and to
// mark the record read; nothing secret beyond the human-readable title/body.
func messageFor(rec domain.NotificationRecord, token string) Message {
	return Message{
		To:        token,
		Title:     rec.Title,
		Body:      rec.Body,
		Sound:     "default",
		Priority:  "high",
		ChannelID: androidChannelID,
		Data: map[string]any{
			"type":           string(rec.Type),
			"sessionId":      string(rec.SessionID),
			"projectId":      string(rec.ProjectID),
			"prUrl":          rec.PRURL,
			"notificationId": rec.ID,
		},
	}
}
