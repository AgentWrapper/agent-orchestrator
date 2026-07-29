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
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

const sandboxAOPath = "/usr/local/bin/ao"

type cloudRuntimeStack struct {
	sessions *sessionsvc.Service
	activity *lifecycle.Manager
	runtime  *daytona.Runtime
}

func newCloudRuntimeStack(cfg Config, store *postgres.Store, issuer *auth.Issuer, log *slog.Logger) (*cloudRuntimeStack, error) {
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
	agents, err := newCloudAgentResolver()
	if err != nil {
		return nil, err
	}
	messenger := cloudRuntimeMessenger{store: store, runtime: rt}
	lcm := lifecycle.New(store, messenger)
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
	return &cloudRuntimeStack{
		sessions: sessionsvc.NewWithDeps(sessionsvc.Deps{
			Manager:       mgr,
			Store:         store,
			DataDir:       cfg.DataDir,
			SignalCapable: func(h domain.AgentHarness) bool { return h == domain.HarnessClaudeCode },
		}),
		activity: lcm,
		runtime:  rt,
	}, nil
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
	base ports.AgentResolver
}

func newCloudAgentResolver() (ports.AgentResolver, error) {
	reg, err := agentregistry.Build()
	if err != nil {
		return nil, err
	}
	return cloudAgentResolver{base: registryResolver{reg: reg}}, nil
}

func (r cloudAgentResolver) Agent(harness domain.AgentHarness) (ports.Agent, bool) {
	agent, ok := r.base.Agent(harness)
	if !ok {
		return nil, false
	}
	if harness == domain.HarnessClaudeCode {
		return cloudClaudeAgent{Agent: agent}, true
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
}

func (a cloudClaudeAgent) GetAgentHooks(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	return ctx.Err()
}

func (a cloudClaudeAgent) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := []string{"claude"}
	appendCloudClaudePermissionFlags(&cmd, cfg.Permissions)
	if cfg.SystemPrompt != "" {
		cmd = append(cmd, "--append-system-prompt", cfg.SystemPrompt)
	}
	if cfg.Prompt != "" {
		cmd = append(cmd, "--", cfg.Prompt)
	}
	return cmd, nil
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
