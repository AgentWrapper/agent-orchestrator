package daemon

import (
	"context"
	"log/slog"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/metrics"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestStartMetricsObserverDisabledWhenIntervalZero(t *testing.T) {
	dataDir := t.TempDir()
	store, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	cfg := config.Config{DataDir: dataDir, Metrics: config.MetricsConfig{Interval: 0}}
	obs, done := startMetricsObserver(context.Background(), cfg, store, "tmux", nil, slog.Default())
	if obs != nil {
		t.Fatalf("observer must be nil when disabled, got %T", obs)
	}
	// done must already be closed.
	select {
	case <-done:
	default:
		t.Fatal("done channel must be closed when observer disabled")
	}
	if metricsProvider(obs) != nil {
		t.Fatal("metricsProvider must map a nil observer to a nil interface")
	}
}

func TestStartMetricsObserverEnabled(t *testing.T) {
	dataDir := t.TempDir()
	store, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	cfg := config.Config{DataDir: dataDir, Metrics: config.MetricsConfig{Interval: config.DefaultMetricsInterval}}
	obs, done := startMetricsObserver(ctx, cfg, store, "tmux", nil, slog.Default())
	if obs == nil {
		t.Fatal("observer must be non-nil when enabled")
	}
	if metricsProvider(obs) == nil {
		t.Fatal("metricsProvider must expose an enabled observer")
	}
	cancel()
	<-done // loop drains on ctx cancel
}

type recordingSink struct{ events []ports.TelemetryEvent }

func (r *recordingSink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	r.events = append(r.events, ev)
}
func (r *recordingSink) Close(context.Context) error { return nil }

func TestTelemetryAlertSinkEmitsResourceAlert(t *testing.T) {
	rec := &recordingSink{}
	s := telemetryAlertSink{sink: rec}

	s.EmitAlert(context.Background(), metrics.AlertTransition{
		Firing: true,
		Alert:  metrics.Alert{Kind: metrics.AlertDiskLow, Severity: metrics.SeverityWarn, Value: 5, Threshold: 10, Message: "low"},
	})
	s.EmitAlert(context.Background(), metrics.AlertTransition{
		Firing: false,
		Alert:  metrics.Alert{Kind: metrics.AlertDiskLow, Severity: metrics.SeverityWarn},
	})

	if len(rec.events) != 2 {
		t.Fatalf("want 2 emitted events, got %d", len(rec.events))
	}
	firing := rec.events[0]
	if firing.Name != "resource_alert" || firing.Source != "metrics" {
		t.Errorf("event name/source wrong: %+v", firing)
	}
	if firing.Level != ports.TelemetryLevelWarn {
		t.Errorf("firing level = %v, want warn", firing.Level)
	}
	if firing.Payload["kind"] != "disk_low" || firing.Payload["state"] != "firing" {
		t.Errorf("firing payload wrong: %+v", firing.Payload)
	}
	cleared := rec.events[1]
	if cleared.Level != ports.TelemetryLevelInfo || cleared.Payload["state"] != "cleared" {
		t.Errorf("cleared event wrong: level=%v payload=%+v", cleared.Level, cleared.Payload)
	}
}

func TestTelemetryAlertSinkNilSinkNoPanic(t *testing.T) {
	s := telemetryAlertSink{sink: nil}
	// Must not panic.
	s.EmitAlert(context.Background(), metrics.AlertTransition{Firing: true, Alert: metrics.Alert{Kind: metrics.AlertZombies}})
}
