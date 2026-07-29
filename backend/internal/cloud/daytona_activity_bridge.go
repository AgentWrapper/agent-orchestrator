package cloud

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/daytona"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	cloudActivitySpoolPrefix = "/tmp/ao-cloud-activity-"
	cloudActivitySpoolSuffix = ".ndjson"
)

type daytonaActivityClient interface {
	ListSandboxes(ctx context.Context, labels map[string]string) ([]daytona.Sandbox, error)
	Exec(ctx context.Context, sandboxID string, req daytona.ExecRequest) (daytona.ExecResult, error)
}

type activitySignalApplier interface {
	ApplyActivitySignal(ctx context.Context, id domain.SessionID, s ports.ActivitySignal) error
}

type daytonaActivityBridge struct {
	client daytonaActivityClient
	apply  activitySignalApplier
	log    *slog.Logger
	now    func() time.Time
}

func newDaytonaActivityBridge(client daytonaActivityClient, apply activitySignalApplier, log *slog.Logger) *daytonaActivityBridge {
	if client == nil || apply == nil {
		return nil
	}
	if log == nil {
		log = slog.Default()
	}
	return &daytonaActivityBridge{
		client: client,
		apply:  apply,
		log:    log,
		now:    time.Now,
	}
}

func cloudActivitySpoolPath(sessionID string) string {
	return cloudActivitySpoolPrefix + sessionID + cloudActivitySpoolSuffix
}

func cloudActivityShellPrelude() string {
	return "ao_cloud_activity_spool=${AO_CLOUD_ACTIVITY_SPOOL:-/tmp/ao-cloud-activity-${AO_SESSION_ID}.ndjson}; " +
		"ao_cloud_emit_activity(){ state=$1; event=$2; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); " +
		"printf '{\"state\":\"%s\",\"event\":\"%s\",\"launchId\":\"%s\",\"timestamp\":\"%s\"}\\n' \"$state\" \"$event\" \"${AO_RUNTIME_LAUNCH_ID:-}\" \"$ts\" >> \"$ao_cloud_activity_spool\" 2>/dev/null || true; }; "
}

func (b *daytonaActivityBridge) Start(ctx context.Context, rec domain.SessionRecord) {
	if b == nil || rec.ID == "" || rec.Metadata.RuntimeHandleID == "" {
		return
	}
	scope, _ := tenancy.ScopeFromContext(ctx)
	go b.run(context.Background(), scope, rec.ID, rec.Metadata.RuntimeHandleID, rec.Metadata.RuntimeLaunchID)
}

func (b *daytonaActivityBridge) run(ctx context.Context, scope tenancy.Scope, id domain.SessionID, handleID, launchID string) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	if scope.OrgID != "" {
		ctx = tenancy.WithScope(ctx, scope)
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	seen := map[string]bool{}
	for {
		done, err := b.poll(ctx, id, handleID, launchID, seen)
		if err != nil {
			b.log.Debug("daytona activity bridge poll failed", "sessionID", id, "error", err)
		}
		if done {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (b *daytonaActivityBridge) poll(ctx context.Context, id domain.SessionID, handleID, launchID string, seen map[string]bool) (bool, error) {
	list, err := b.client.ListSandboxes(ctx, map[string]string{daytona.LabelSession: handleID})
	if err != nil {
		return false, err
	}
	var sb daytona.Sandbox
	for _, candidate := range list {
		if candidate.State != daytona.StateDestroyed && candidate.State != daytona.StateDestroying {
			sb = candidate
			break
		}
	}
	if sb.ID == "" {
		return false, nil
	}
	res, err := b.client.Exec(ctx, sb.ID, daytona.ExecRequest{
		Command:        "test -f " + cloudShellQuote(cloudActivitySpoolPath(string(id))) + " && cat " + cloudShellQuote(cloudActivitySpoolPath(string(id))) + " || true",
		TimeoutSeconds: 5,
	})
	if err != nil {
		return false, err
	}
	if res.ExitCode != 0 {
		return false, nil
	}
	done := false
	scanner := bufio.NewScanner(strings.NewReader(res.Result))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || seen[line] {
			continue
		}
		seen[line] = true
		sig, ok := parseCloudActivityEvent(line)
		if !ok {
			continue
		}
		if launchID != "" && sig.LaunchID != "" && sig.LaunchID != launchID {
			continue
		}
		if err := b.apply.ApplyActivitySignal(ctx, id, sig); err != nil {
			return false, err
		}
		if sig.State == domain.ActivityIdle || sig.State == domain.ActivityExited {
			done = true
		}
	}
	if err := scanner.Err(); err != nil {
		return false, err
	}
	return done, nil
}

type cloudActivityEvent struct {
	State     string `json:"state"`
	Event     string `json:"event"`
	LaunchID  string `json:"launchId"`
	Timestamp string `json:"timestamp"`
}

func parseCloudActivityEvent(line string) (ports.ActivitySignal, bool) {
	var ev cloudActivityEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return ports.ActivitySignal{}, false
	}
	state := domain.ActivityState(strings.TrimSpace(ev.State))
	switch state {
	case domain.ActivityActive, domain.ActivityIdle, domain.ActivityWaitingInput, domain.ActivityBlocked, domain.ActivityExited:
	default:
		return ports.ActivitySignal{}, false
	}
	var ts time.Time
	if raw := strings.TrimSpace(ev.Timestamp); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err == nil {
			ts = parsed
		}
	}
	return ports.ActivitySignal{
		Valid:     true,
		State:     state,
		Event:     ev.Event,
		LaunchID:  ev.LaunchID,
		Timestamp: ts,
	}, true
}
