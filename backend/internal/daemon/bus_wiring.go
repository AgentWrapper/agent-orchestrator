package daemon

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/busclient"
	"github.com/aoagents/agent-orchestrator/backend/internal/busproto"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// busSessions is the slice of the session Service the bus executor drives. It's
// the same surface the HTTP controllers use, so a routed send/kill/spawn behaves
// exactly like a local one. A narrow interface keeps the adapter testable.
//
// SendLocal (not Send) is used for inbound routed commands: the hub already
// resolved that this daemon owns the session, so delivery must stay local and
// never bounce back out over the bus.
type busSessions interface {
	SendLocal(ctx context.Context, id domain.SessionID, message string) error
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error)
	List(ctx context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error)
}

// busExecutor adapts the session Service to busclient.Executor: it runs commands
// the hub routes to this daemon and enumerates the sessions it owns.
type busExecutor struct{ svc busSessions }

func (e busExecutor) Send(ctx context.Context, sessionID, message string) error {
	return e.svc.SendLocal(ctx, domain.SessionID(sessionID), message)
}

func (e busExecutor) Kill(ctx context.Context, sessionID string) error {
	_, err := e.svc.Kill(ctx, domain.SessionID(sessionID))
	return err
}

// busSpawnSpec is the JSON payload of a routed spawn command. It mirrors the
// fields a cloud spawn already carries so an orchestrator can fan workers out
// across locations through the bus.
type busSpawnSpec struct {
	Kind        string `json:"kind"`
	Harness     string `json:"harness"`
	ProjectID   string `json:"projectId"`
	IssueID     string `json:"issueId"`
	Branch      string `json:"branch"`
	Prompt      string `json:"prompt"`
	DisplayName string `json:"displayName"`
}

func (e busExecutor) Spawn(ctx context.Context, spec json.RawMessage) (string, error) {
	var s busSpawnSpec
	if len(spec) > 0 {
		if err := json.Unmarshal(spec, &s); err != nil {
			return "", err
		}
	}
	kind := domain.SessionKind(s.Kind)
	if kind == "" {
		kind = domain.KindWorker
	}
	sess, _, _, err := e.svc.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   domain.ProjectID(s.ProjectID),
		IssueID:     domain.IssueID(s.IssueID),
		Kind:        kind,
		Harness:     domain.AgentHarness(s.Harness),
		Branch:      s.Branch,
		Prompt:      s.Prompt,
		DisplayName: s.DisplayName,
	})
	if err != nil {
		return "", err
	}
	return string(sess.ID), nil
}

func (e busExecutor) OwnedSessions(ctx context.Context) ([]busproto.SessionRef, error) {
	active := true
	sessions, err := e.svc.List(ctx, sessionsvc.ListFilter{Active: &active})
	if err != nil {
		return nil, err
	}
	refs := make([]busproto.SessionRef, 0, len(sessions))
	for _, s := range sessions {
		refs = append(refs, busproto.SessionRef{
			SessionID: string(s.ID),
			Kind:      string(s.Kind),
			ProjectID: string(s.ProjectID),
		})
	}
	return refs, nil
}

var _ busclient.Executor = busExecutor{}

// startBusClient wires and starts the federated-bus client when a control plane
// is configured. It's a no-op returning nil otherwise, so a bare local daemon is
// unaffected. The client's Run loop exits when ctx is cancelled at shutdown.
func startBusClient(ctx context.Context, cfg config.Config, svc busSessions, log *slog.Logger) *busclient.Client {
	if !cfg.Bus.Enabled() {
		return nil
	}
	client := busclient.New(busclient.Config{
		ControlPlaneURL: cfg.Bus.ControlPlaneURL,
		Token:           cfg.Bus.Token,
		Tenant:          cfg.Bus.Tenant,
		DaemonID:        cfg.Bus.DaemonID,
		AgentHost:       cfg.Bus.AgentHost,
	}, busExecutor{svc: svc}, log)
	go func() {
		if err := client.Run(ctx); err != nil && ctx.Err() == nil {
			log.Warn("bus client stopped", "err", err)
		}
	}()
	log.Info("federated bus client started", "daemonId", cfg.Bus.DaemonID, "agentHost", cfg.Bus.AgentHost)
	return client
}
