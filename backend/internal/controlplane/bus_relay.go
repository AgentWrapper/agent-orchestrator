package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
)

// proxyFetcher is the slice of the supervisor the relay needs: a server-side
// call INTO a sandbox via its signed preview URL. An interface (not the concrete
// *cloud.Supervisor) so the relay is unit-testable and decoupled.
type proxyFetcher interface {
	ProxyFetch(ctx context.Context, previewURL, method, apiPath string, body any) (int, json.RawMessage, error)
}

// supervisorRelay implements SandboxRelay by mapping bus commands/events onto a
// sandbox daemon's HTTP API, reached through the existing signed-preview relay.
// This is the "control plane can already reach sandboxes via preview URLs" half
// of the federated bus.
type supervisorRelay struct{ p proxyFetcher }

func newSupervisorRelay(p proxyFetcher) *supervisorRelay { return &supervisorRelay{p: p} }

func (r *supervisorRelay) Relay(ctx context.Context, previewURL string, cmd Command) error {
	switch cmd.Op {
	case "send":
		return r.post(ctx, previewURL, "/api/v1/sessions/"+cmd.SessionID+"/send", map[string]any{"message": cmd.Message})
	case "kill":
		return r.post(ctx, previewURL, "/api/v1/sessions/"+cmd.SessionID+"/kill", nil)
	case "spawn":
		var spec any
		if len(cmd.Spec) > 0 {
			spec = json.RawMessage(cmd.Spec)
		}
		return r.post(ctx, previewURL, "/api/v1/sessions", spec)
	default:
		return fmt.Errorf("bus: unknown command op %q", cmd.Op)
	}
}

func (r *supervisorRelay) RelayEvent(ctx context.Context, previewURL string, ev Event) error {
	// Deliver an event to a sandbox-hosted target by injecting it as a message
	// into that session (e.g. a worker's report → the orchestrator's terminal).
	return r.post(ctx, previewURL, "/api/v1/sessions/"+ev.ToSessionID+"/send", map[string]any{"message": eventMessage(ev)})
}

func (r *supervisorRelay) post(ctx context.Context, previewURL, path string, body any) error {
	status, _, err := r.p.ProxyFetch(ctx, previewURL, "POST", path, body)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("bus: sandbox relay %s → HTTP %d", path, status)
	}
	return nil
}

func eventMessage(ev Event) string {
	if len(ev.Data) > 0 {
		return string(ev.Data)
	}
	return ev.Kind
}

var _ SandboxRelay = (*supervisorRelay)(nil)
