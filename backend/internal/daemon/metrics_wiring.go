package daemon

import (
	"context"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/metrics"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// startMetricsObserver wires the resource metrics observer behind config. A zero
// interval disables it entirely: the returned observer is nil (so the API mounts
// the endpoint as not-implemented) and the done channel is already closed.
//
// Alert transitions are emitted through the telemetry EventSink as
// `resource_alert` events (level warn on firing, info on clear). The evaluator
// only surfaces transitions, so this is deduped on state change, never per tick.
// Forwarding those events to Slack is the alerting sink's concern (#153).
func startMetricsObserver(ctx context.Context, cfg config.Config, store *sqlite.Store, tmuxBinary string, telemetry ports.EventSink, logger *slog.Logger) (*metrics.Observer, <-chan struct{}) {
	if cfg.Metrics.Interval <= 0 {
		logger.Info("metrics observer disabled (AO_METRICS_INTERVAL=0)")
		closed := make(chan struct{})
		close(closed)
		return nil, closed
	}

	obs := metrics.New(metrics.Deps{
		Sessions: store,
		Host:     metrics.NewHostCollector(cfg.DataDir),
		Scopes:   metrics.NewScopeCollector(tmuxBinary),
		Cost:     metrics.NewStoreCostAggregator(store),
		Alerts:   telemetryAlertSink{sink: telemetry},
	}, metrics.Config{
		Tick: cfg.Metrics.Interval,
		Thresholds: metrics.Thresholds{
			DiskFreePercent:     cfg.Metrics.DiskFreePercent,
			MemAvailablePercent: cfg.Metrics.MemAvailablePercent,
			LoadPerCore:         cfg.Metrics.LoadPerCore,
			ZombieSustainTicks:  cfg.Metrics.ZombieSustainTicks,
		},
		Logger: logger,
	})
	return obs, obs.Start(ctx)
}

// metricsProvider adapts the observer to the controller read interface, mapping
// a disabled (nil) observer to a nil interface so the endpoint reports
// not-implemented instead of wrapping a typed-nil pointer.
func metricsProvider(obs *metrics.Observer) controllers.MetricsProvider {
	if obs == nil {
		return nil
	}
	return obs
}

// telemetryAlertSink forwards metrics alert transitions onto the daemon's
// telemetry event bus as `resource_alert` events. Best-effort: a nil sink is a
// no-op so the observer runs even when telemetry capture is off.
type telemetryAlertSink struct {
	sink ports.EventSink
}

// EmitAlert publishes one alert transition as a structured telemetry event.
func (s telemetryAlertSink) EmitAlert(ctx context.Context, t metrics.AlertTransition) {
	if s.sink == nil {
		return
	}
	level := ports.TelemetryLevelWarn
	state := "firing"
	if !t.Firing {
		level = ports.TelemetryLevelInfo
		state = "cleared"
	}
	s.sink.Emit(ctx, ports.TelemetryEvent{
		Name:       "resource_alert",
		Source:     "metrics",
		OccurredAt: time.Now().UTC(),
		Level:      level,
		Payload: map[string]any{
			"kind":      string(t.Alert.Kind),
			"state":     state,
			"severity":  string(t.Alert.Severity),
			"value":     t.Alert.Value,
			"threshold": t.Alert.Threshold,
			"message":   t.Alert.Message,
		},
	})
}
