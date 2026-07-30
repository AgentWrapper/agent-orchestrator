package cloud

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/daytona"
	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

const sandboxAOPath = "/usr/local/bin/ao"

type cloudRuntimeStack struct {
	sessions *sessionsvc.Service
	activity *lifecycle.Manager
	runtime  *daytona.Runtime
	bridge   *daytonaActivityBridge
	term     *terminal.Manager
}

func newCloudRuntimeStack(cfg Config, store *postgres.Store, issuer *auth.Issuer, events *cdc.Broadcaster, log *slog.Logger) (*cloudRuntimeStack, error) {
	if strings.TrimSpace(cfg.Runtime) == "" {
		return nil, nil
	}
	if cfg.Runtime != "daytona" {
		return nil, fmt.Errorf("unsupported AO_CLOUD_RUNTIME %q", cfg.Runtime)
	}
	if strings.TrimSpace(cfg.PublicAPIBase) == "" {
		return nil, errors.New("AO_CLOUD_API_BASE is required when AO_CLOUD_RUNTIME=daytona")
	}
	client, err := daytona.NewClient(daytona.ClientOptions{APIKey: cfg.Daytona.APIKey, APIURL: cfg.Daytona.APIURL})
	if err != nil {
		return nil, err
	}
	rt, err := daytona.New(daytona.Options{Client: client})
	if err != nil {
		return nil, err
	}
	agents, err := newCloudAgentResolver(issuer, cfg.PublicAPIBase)
	if err != nil {
		return nil, err
	}
	messenger := cloudRuntimeMessenger{store: store, runtime: rt}
	lcm := lifecycle.New(store, messenger)
	bridge := newDaytonaActivityBridge(client, lcm, log)
	ws, err := daytona.NewWorkspace(daytona.WorkspaceOptions{
		Client:             client,
		Snapshot:           cfg.Daytona.Snapshot,
		Target:             cfg.Daytona.Target,
		CPU:                cfg.Daytona.CPU,
		MemoryGiB:          cfg.Daytona.MemoryGiB,
		DiskGiB:            cfg.Daytona.DiskGiB,
		AutoStopMinutes:    cfg.Daytona.AutoStopMinutes,
		AutoArchiveMinutes: cfg.Daytona.AutoArchiveMinutes,
		WorkspaceRoot:      cfg.Daytona.WorkspaceRoot,
		BootEnv:            daytonaBaseEnv(),
		SessionBootEnv: func(ctx context.Context, wc ports.WorkspaceConfig) (map[string]string, error) {
			orgID, err := tenancy.OrgIDFromContext(ctx)
			if err != nil {
				return nil, err
			}
			token, _, err := issuer.IssueSessionToken(orgID, string(wc.SessionID), 24*time.Hour)
			if err != nil {
				return nil, err
			}
			return map[string]string{
				"AO_API_BASE":  cfg.PublicAPIBase,
				"AO_API_TOKEN": token,
			}, nil
		},
		ResolveRepo: func(ctx context.Context, wc ports.WorkspaceConfig) (daytona.RepoRemote, error) {
			project, ok, err := store.GetProject(ctx, string(wc.ProjectID))
			if err != nil {
				return daytona.RepoRemote{}, err
			}
			if !ok {
				return daytona.RepoRemote{}, fmt.Errorf("project %s not found", wc.ProjectID)
			}
			url := strings.TrimSpace(project.RepoOriginURL)
			if url == "" {
				url = strings.TrimSpace(project.Path)
			}
			if url == "" {
				return daytona.RepoRemote{}, fmt.Errorf("project %s has no clone URL", wc.ProjectID)
			}
			return daytona.RepoRemote{
				URL:           url,
				DefaultBranch: project.Config.DefaultBranch,
				Username:      cfg.Daytona.GitUsername,
				Password:      cfg.Daytona.GitPassword,
			}, nil
		},
		Logger: log,
	})
	if err != nil {
		return nil, err
	}
	mgr := sessionmanager.New(sessionmanager.Deps{
		Runtime:   rt,
		Agents:    agents,
		Workspace: ws,
		Store:     store,
		Messenger: messenger,
		Lifecycle: lcm,
		DataDir:   cfg.DataDir,
		LookPath:  cloudLookPath,
		Executable: func() (string, error) {
			return sandboxAOPath, nil
		},
		Logger: log,
	})
	lcm.SetCompletionTerminator(mgr)
	commander := cloudSessionManager{base: mgr, bridge: bridge}
	term := terminal.NewManager(cloudTerminalSource{store: store, runtime: rt}, events, log)
	return &cloudRuntimeStack{
		sessions: sessionsvc.NewWithDeps(sessionsvc.Deps{
			Manager:       commander,
			Store:         store,
			DataDir:       cfg.DataDir,
			SignalCapable: func(h domain.AgentHarness) bool { return h == domain.HarnessClaudeCode },
		}),
		activity: lcm,
		runtime:  rt,
		bridge:   bridge,
		term:     term,
	}, nil
}

type cloudTerminalStore interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListAllSessions(context.Context) ([]domain.SessionRecord, error)
}

type cloudTerminalSource struct {
	store   cloudTerminalStore
	runtime interface {
		ports.Attacher
		IsAlive(context.Context, ports.RuntimeHandle) (bool, error)
	}
}

func (s cloudTerminalSource) Attach(ctx context.Context, handle ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	if _, ok, err := s.authorizedSession(ctx, handle); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("cloud terminal: runtime handle %s is not available in this org", handle.ID)
	}
	return s.runtime.Attach(ctx, handle, rows, cols)
}

func (s cloudTerminalSource) IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error) {
	rec, ok, err := s.authorizedSession(ctx, handle)
	if err != nil {
		return false, err
	}
	if !ok || rec.IsTerminated {
		return false, nil
	}
	return s.runtime.IsAlive(ctx, handle)
}

func (s cloudTerminalSource) authorizedSession(ctx context.Context, handle ports.RuntimeHandle) (domain.SessionRecord, bool, error) {
	if s.store == nil {
		return domain.SessionRecord{}, false, errors.New("cloud terminal: session store is not configured")
	}
	if s.runtime == nil {
		return domain.SessionRecord{}, false, errors.New("cloud terminal: runtime is not configured")
	}
	if strings.TrimSpace(handle.ID) == "" {
		return domain.SessionRecord{}, false, errors.New("cloud terminal: runtime handle is required")
	}
	if rec, ok, err := s.store.GetSession(ctx, domain.SessionID(handle.ID)); err != nil {
		return domain.SessionRecord{}, false, err
	} else if ok && rec.Metadata.RuntimeHandleID == handle.ID {
		return rec, true, nil
	}
	recs, err := s.store.ListAllSessions(ctx)
	if err != nil {
		return domain.SessionRecord{}, false, err
	}
	for _, rec := range recs {
		if rec.Metadata.RuntimeHandleID == handle.ID {
			return rec, true, nil
		}
	}
	return domain.SessionRecord{}, false, nil
}

func daytonaBaseEnv() map[string]string {
	env := map[string]string{}
	for _, key := range []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			env[key] = value
		}
	}
	return env
}

func cloudLookPath(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", os.ErrNotExist
	}
	if strings.Contains(name, "/") {
		return name, nil
	}
	switch name {
	case "tmux":
		return "/usr/bin/tmux", nil
	case "node":
		return "/usr/local/bin/node", nil
	default:
		return "/usr/local/bin/" + name, nil
	}
}

type cloudRuntimeMessenger struct {
	store   *postgres.Store
	runtime interface {
		SendMessage(context.Context, ports.RuntimeHandle, string) error
	}
}

func (m cloudRuntimeMessenger) Send(ctx context.Context, id domain.SessionID, message string) error {
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("session %s: %w", id, sessionmanager.ErrNotFound)
	}
	if rec.IsTerminated {
		return fmt.Errorf("session %s: %w", id, sessionmanager.ErrTerminated)
	}
	handleID := rec.Metadata.RuntimeHandleID
	if handleID == "" {
		return fmt.Errorf("session %s: %w", id, sessionmanager.ErrIncompleteHandle)
	}
	return m.runtime.SendMessage(ctx, ports.RuntimeHandle{ID: handleID}, message)
}

type cloudAgentResolver struct {
	base          ports.AgentResolver
	issuer        *auth.Issuer
	publicAPIBase string
}

func newCloudAgentResolver(issuer *auth.Issuer, publicAPIBase string) (ports.AgentResolver, error) {
	reg, err := agentregistry.Build()
	if err != nil {
		return nil, err
	}
	return cloudAgentResolver{base: registryResolver{reg: reg}, issuer: issuer, publicAPIBase: publicAPIBase}, nil
}

func (r cloudAgentResolver) Agent(harness domain.AgentHarness) (ports.Agent, bool) {
	agent, ok := r.base.Agent(harness)
	if !ok {
		return nil, false
	}
	if harness == domain.HarnessClaudeCode {
		return cloudClaudeAgent{Agent: agent, issuer: r.issuer, publicAPIBase: r.publicAPIBase}, true
	}
	return cloudNoLocalPrepAgent{Agent: agent}, true
}

type registryResolver struct {
	reg *adapters.Registry
}

func (r registryResolver) Agent(harness domain.AgentHarness) (ports.Agent, bool) {
	adapter, ok := r.reg.Get(string(harness))
	if !ok {
		return nil, false
	}
	agent, ok := adapter.(ports.Agent)
	return agent, ok
}

type cloudNoLocalPrepAgent struct {
	ports.Agent
}

func (a cloudNoLocalPrepAgent) GetAgentHooks(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	return ctx.Err()
}

type cloudClaudeAgent struct {
	ports.Agent
	issuer        *auth.Issuer
	publicAPIBase string
}

func (a cloudClaudeAgent) GetAgentHooks(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	return ctx.Err()
}

func (a cloudClaudeAgent) AugmentRuntimeEnv(env map[string]string, _ string) {
	for _, key := range []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			env[key] = value
		}
	}
	if value := strings.TrimSpace(os.Getenv("AO_CLOUD_ACTIVITY_ACTIVE_GRACE_SECONDS")); value != "" {
		env["AO_CLOUD_ACTIVITY_ACTIVE_GRACE_SECONDS"] = value
	}
	orgID := strings.TrimSpace(env["AO_CLOUD_ORG_ID"])
	sessionID := strings.TrimSpace(env[sessionmanager.EnvSessionID])
	if a.issuer == nil || strings.TrimSpace(a.publicAPIBase) == "" || orgID == "" || sessionID == "" {
		return
	}
	env["AO_CLOUD_ACTIVITY_SPOOL"] = cloudActivitySpoolPath(sessionID)
	token, _, err := a.issuer.IssueSessionToken(orgID, sessionID, 24*time.Hour)
	if err != nil {
		return
	}
	env["AO_API_BASE"] = a.publicAPIBase
	env["AO_API_TOKEN"] = token
}

func (a cloudClaudeAgent) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	claude := []string{"claude"}
	appendCloudClaudePermissionFlags(&claude, cfg.Permissions)
	if cfg.SystemPrompt != "" {
		claude = append(claude, "--append-system-prompt", cfg.SystemPrompt)
	}
	if cfg.Prompt != "" {
		claude = append(claude, "-p", cfg.Prompt)
	}
	script := cloudActivityShellPrelude() +
		"ao_cloud_emit_activity active user-prompt-submit; " +
		"printf '{}' | ao hooks claude-code user-prompt-submit >/tmp/ao-hooks-user-prompt-submit.log 2>&1 || true; " +
		"if [ -n \"${AO_CLOUD_ACTIVITY_ACTIVE_GRACE_SECONDS:-}\" ]; then sleep \"$AO_CLOUD_ACTIVITY_ACTIVE_GRACE_SECONDS\" 2>/dev/null || true; fi; " +
		cloudShellJoin(claude) + "; status=$?; " +
		"ao_cloud_emit_activity idle stop; " +
		"printf '{}' | ao hooks claude-code stop >/tmp/ao-hooks-stop.log 2>&1 || true; " +
		"exit $status"
	return []string{"sh", "-lc", script}, nil
}

func (a cloudClaudeAgent) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	sessionID := strings.TrimSpace(cfg.Session.Metadata[ports.MetadataKeyAgentSessionID])
	if sessionID == "" {
		return nil, false, nil
	}
	cmd := []string{"claude"}
	appendCloudClaudePermissionFlags(&cmd, cfg.Permissions)
	if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}
	cmd = append(cmd, "--resume", sessionID)
	return cmd, true, nil
}

func (a cloudClaudeAgent) EmitsSubmitActivity() bool  { return true }
func (a cloudClaudeAgent) EmitsBlockedActivity() bool { return true }

func appendCloudClaudePermissionFlags(cmd *[]string, permissions ports.PermissionMode) {
	switch ports.NormalizePermissionMode(permissions) {
	case ports.PermissionModeAcceptEdits:
		*cmd = append(*cmd, "--permission-mode", "acceptEdits")
	case ports.PermissionModeAuto:
		*cmd = append(*cmd, "--permission-mode", "auto")
	case ports.PermissionModeBypassPermissions:
		*cmd = append(*cmd, "--permission-mode", "bypassPermissions")
	}
}

func cloudShellJoin(argv []string) string {
	parts := make([]string, 0, len(argv))
	for _, arg := range argv {
		parts = append(parts, cloudShellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func cloudShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

type cloudSessionManager struct {
	base   *sessionmanager.Manager
	bridge *daytonaActivityBridge
}

func (m cloudSessionManager) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.SessionRecord, int, int, error) {
	rec, promptBytes, systemPromptBytes, err := m.base.Spawn(ctx, cfg)
	if err == nil && m.bridge != nil {
		m.bridge.Start(ctx, rec)
	}
	return rec, promptBytes, systemPromptBytes, err
}

func (m cloudSessionManager) RestoreWithMode(ctx context.Context, id domain.SessionID) (sessionmanager.RestoreResult, error) {
	res, err := m.base.RestoreWithMode(ctx, id)
	if err == nil && m.bridge != nil {
		m.bridge.Start(ctx, res.Session)
	}
	return res, err
}

func (m cloudSessionManager) ResumeAgentWithMode(ctx context.Context, id domain.SessionID) (sessionmanager.RestoreResult, error) {
	res, err := m.base.ResumeAgentWithMode(ctx, id)
	if err == nil && m.bridge != nil {
		m.bridge.Start(ctx, res.Session)
	}
	return res, err
}

func (m cloudSessionManager) Kill(ctx context.Context, id domain.SessionID) (bool, error) {
	return m.base.Kill(ctx, id)
}

func (m cloudSessionManager) RetireForReplacement(ctx context.Context, id domain.SessionID) error {
	return m.base.RetireForReplacement(ctx, id)
}

func (m cloudSessionManager) Send(ctx context.Context, id domain.SessionID, message string) error {
	return m.base.Send(ctx, id, message)
}

func (m cloudSessionManager) Cleanup(ctx context.Context, project domain.ProjectID) (sessionmanager.CleanupResult, error) {
	return m.base.Cleanup(ctx, project)
}

func (m cloudSessionManager) RollbackSpawn(ctx context.Context, id domain.SessionID) (deleted, killed bool, err error) {
	return m.base.RollbackSpawn(ctx, id)
}
