package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentconfig"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/modelhealth"
)

type modelHealthConfig struct {
	Interval time.Duration
}

type modelHealthProber struct {
	svc *agentsvc.Service
}

func (p modelHealthProber) CheckModels(ctx context.Context, pins []modelhealth.Pin) ([]modelhealth.Verdict, error) {
	req := agentsvc.ModelAvailabilityRequest{Force: true, Pins: make([]agentsvc.ModelPin, 0, len(pins))}
	for _, pin := range pins {
		req.Pins = append(req.Pins, agentsvc.ModelPin{Harness: pin.Harness, Model: pin.Model})
	}
	availability, err := p.svc.ModelAvailability(ctx, req)
	if err != nil {
		return nil, err
	}
	byHarness := map[string]map[string]agentsvc.ModelAvailability{}
	for _, h := range availability.Harnesses {
		models := map[string]agentsvc.ModelAvailability{}
		for _, m := range h.Models {
			models[m.Model] = m
		}
		byHarness[h.ID] = models
	}
	out := make([]modelhealth.Verdict, 0, len(pins))
	for _, pin := range pins {
		row, ok := byHarness[string(pin.Harness)][strings.TrimSpace(pin.Model)]
		if !ok {
			out = append(out, modelhealth.Verdict{Pin: pin, Status: agentsvc.ModelStatusUnknown, Reason: "model missing from availability response"})
			continue
		}
		out = append(out, modelhealth.Verdict{Pin: pin, Status: row.Status, Reason: row.Reason})
	}
	return out, nil
}

func configuredModelPins(ctx context.Context, projects projectConfigLister, log *slog.Logger) ([]modelhealth.Pin, error) {
	if projects == nil {
		return nil, nil
	}
	summaries, err := projects.List(ctx)
	if err != nil {
		if log != nil {
			log.Warn("model-health: listing projects for model pins failed", "err", err)
		}
		return nil, fmt.Errorf("list projects for model pins: %w", err)
	}
	var pins []modelhealth.Pin
	for _, summary := range summaries {
		res, err := projects.Get(ctx, summary.ID)
		if err != nil {
			if log != nil {
				log.Warn("model-health: reading project config for model pins failed", "project", summary.ID, "err", err)
			}
			return nil, fmt.Errorf("get project %s for model pins: %w", summary.ID, err)
		}
		if res.Project == nil || res.Project.Config == nil {
			continue
		}
		pins = append(pins, modelPinsFromProject(summary.ID, res.Project.Config.WithDefaults())...)
	}
	return dedupeModelPins(pins), nil
}

func modelPinsFromProject(projectID domain.ProjectID, cfg domain.ProjectConfig) []modelhealth.Pin {
	resolved := agentconfig.ConfiguredModelPins(cfg)
	pins := make([]modelhealth.Pin, 0, len(resolved))
	for _, pin := range resolved {
		pins = append(pins, modelhealth.Pin{ProjectID: projectID, Scope: pin.Scope, Harness: pin.Harness, Model: pin.Model})
	}
	return pins
}

func dedupeModelPins(in []modelhealth.Pin) []modelhealth.Pin {
	seen := map[string]struct{}{}
	out := make([]modelhealth.Pin, 0, len(in))
	for _, pin := range in {
		key := pin.Key()
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, pin)
	}
	return out
}

func startModelHealth(ctx context.Context, cfg modelHealthConfig, svc *agentsvc.Service, projects projectConfigLister, notifier notificationSink, log *slog.Logger) (*modelhealth.Monitor, <-chan struct{}) {
	monitor := modelhealth.New(modelhealth.Deps{
		Pins:   func(ctx context.Context) ([]modelhealth.Pin, error) { return configuredModelPins(ctx, projects, log) },
		Prober: modelHealthProber{svc: svc},
		Logger: log,
		OnTransition: func(tr modelhealth.Transition) {
			notifyModelHealthTransition(ctx, notifier, tr, log)
		},
	})
	if cfg.Interval <= 0 {
		if log != nil {
			log.Info("model-health monitor disabled (AO_MODEL_REVALIDATION_INTERVAL=0)")
		}
		closed := make(chan struct{})
		close(closed)
		return monitor, closed
	}
	done := observe.StartPollLoop(ctx, cfg.Interval, monitor.Check, log, "model health")
	return monitor, done
}

func notifyModelHealthTransition(ctx context.Context, notifier notificationSink, tr modelhealth.Transition, log *slog.Logger) {
	if notifier == nil {
		return
	}
	pin := tr.Current.Pin
	intent := ports.NotificationIntent{
		SessionID:    modelNotificationSessionID(pin),
		ProjectID:    pin.ProjectID,
		ModelHarness: pin.Harness,
		Model:        pin.Model,
		ModelScope:   pin.Scope,
		Reason:       tr.Current.Reason,
	}
	if tr.Current.Status == agentsvc.ModelStatusUnreachable {
		intent.Type = domain.NotificationModelUnreachable
	} else if tr.Prev.Status == agentsvc.ModelStatusUnreachable && tr.Current.Status == agentsvc.ModelStatusReachable {
		intent.Type = domain.NotificationModelRecovered
	} else {
		return
	}
	if err := notifier.Notify(ctx, intent); err != nil && log != nil {
		log.Warn("model-health: notification failed", "err", err)
	}
}

var modelNotificationRe = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func modelNotificationSessionID(pin modelhealth.Pin) domain.SessionID {
	key := modelNotificationRe.ReplaceAllString(pin.Key(), "-")
	key = strings.Trim(key, "-")
	if key == "" {
		key = string(pin.ProjectID)
	}
	return domain.SessionID(key)
}
