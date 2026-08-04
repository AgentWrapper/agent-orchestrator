// Package acp implements AO's provider-neutral Chat driver over the Agent
// Client Protocol. Provider packages supply only discovery, launch, metadata,
// and capability policy; this package owns the ACP lifecycle and translates ACP
// updates into AO's durable conversation vocabulary.
package acp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const handshakeTimeout = 60 * time.Second

// Launch describes one ACP agent process. Command is normally a packaged
// protocol adapter; provider-native executables belong in Env so the adapter
// uses the same user installation as AO's TUI adapter.
type Launch struct {
	Command string
	Args    []string
	Env     map[string]string
}

// Config binds one harness to an ACP agent implementation.
type Config struct {
	Harness      domain.AgentHarness
	Capabilities ports.ChatCapabilities
	Probe        func(context.Context) error
	Launch       func(context.Context, string, map[string]string) (Launch, error)
	// NewSessionMeta carries adapter-defined ACP extensions. It is deliberately
	// scoped to session/new; resume must recover the provider's existing state.
	NewSessionMeta func(ports.ChatStartConfig) map[string]any
	// SessionMode maps AO's approval vocabulary onto this ACP agent's mode ids.
	// Empty means "leave the provider/user default unchanged".
	SessionMode func(ports.PermissionMode) string
	// SessionOptions maps AO's per-turn choices onto ACP config option ids.
	SessionOptions func(ports.ChatTurnSettings) []SessionOption
}

// SessionOption is one ACP session configuration selection.
type SessionOption struct {
	ID    string
	Value string
}

// Driver opens ACP conversations for a single harness.
type Driver struct {
	cfg   Config
	log   *slog.Logger
	spawn spawnFunc
}

var _ ports.ChatDriver = (*Driver)(nil)

// New returns an ACP Chat driver from a provider binding.
func New(cfg Config, log *slog.Logger) *Driver {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Driver{cfg: cfg, log: log, spawn: spawnAgent}
}

func (d *Driver) Harness() domain.AgentHarness { return d.cfg.Harness }

// Probe checks the provider binding without creating an ACP session or worktree.
func (d *Driver) Probe(ctx context.Context) (ports.ChatCapabilities, error) {
	if d.cfg.Probe == nil || d.cfg.Launch == nil {
		return nil, fmt.Errorf("%w: incomplete ACP binding", ports.ErrChatDriverUnavailable)
	}
	if err := d.cfg.Probe(ctx); err != nil {
		return nil, err
	}
	return cloneCapabilities(d.cfg.Capabilities), nil
}

// Start creates a new ACP session in the AO worktree.
func (d *Driver) Start(ctx context.Context, cfg ports.ChatStartConfig) (ports.ChatConversation, error) {
	if !filepath.IsAbs(cfg.WorkspacePath) {
		return nil, fmt.Errorf("workspace path must be absolute, got %q", cfg.WorkspacePath)
	}
	conv, init, err := d.connect(ctx, cfg.WorkspacePath, cfg.Env)
	if err != nil {
		return nil, err
	}
	if init.AgentCapabilities.SessionCapabilities.Resume == nil {
		_ = conv.Close()
		return nil, fmt.Errorf("%w: ACP agent does not support session/resume", ports.ErrChatDriverIncompatible)
	}

	meta := map[string]any(nil)
	if d.cfg.NewSessionMeta != nil {
		meta = d.cfg.NewSessionMeta(cfg)
	}
	openCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	resp, err := conv.conn.NewSession(openCtx, acpsdk.NewSessionRequest{
		Meta:       meta,
		Cwd:        cfg.WorkspacePath,
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		_ = conv.Close()
		return nil, fmt.Errorf("ACP session/new: %w", err)
	}
	if resp.SessionId == "" {
		_ = conv.Close()
		return nil, errors.New("ACP session/new returned no session id")
	}
	conv.start(
		string(resp.SessionId), conversationCapabilities(d.cfg.Capabilities, init),
		d.cfg.SessionMode, d.cfg.SessionOptions, resp.ConfigOptions,
	)
	if err := conv.applyTurnSettings(ctx, ports.ChatTurnSettings{Model: cfg.Model, Approval: cfg.Permissions}); err != nil {
		_ = conv.Close()
		return nil, fmt.Errorf("configure ACP session: %w", err)
	}
	return conv, nil
}

// Resume reconnects to the stored ACP session without replaying AO's rendered
// transcript. The ACP agent remains authoritative for model context.
func (d *Driver) Resume(ctx context.Context, cfg ports.ChatResumeConfig) (ports.ChatConversation, error) {
	if cfg.ProviderConversationID == "" {
		return nil, fmt.Errorf("%w: no stored ACP session id", ports.ErrChatResumeFailed)
	}
	if !filepath.IsAbs(cfg.WorkspacePath) {
		return nil, fmt.Errorf("workspace path must be absolute, got %q", cfg.WorkspacePath)
	}
	conv, init, err := d.connect(ctx, cfg.WorkspacePath, cfg.Env)
	if err != nil {
		return nil, err
	}
	if init.AgentCapabilities.SessionCapabilities.Resume == nil {
		_ = conv.Close()
		return nil, fmt.Errorf("%w: ACP agent does not support session/resume", ports.ErrChatResumeFailed)
	}

	resumeCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	resp, err := conv.conn.ResumeSession(resumeCtx, acpsdk.ResumeSessionRequest{
		SessionId:  acpsdk.SessionId(cfg.ProviderConversationID),
		Cwd:        cfg.WorkspacePath,
		McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		_ = conv.Close()
		return nil, fmt.Errorf("%w: %v", ports.ErrChatResumeFailed, err)
	}
	conv.start(
		cfg.ProviderConversationID, conversationCapabilities(d.cfg.Capabilities, init),
		d.cfg.SessionMode, d.cfg.SessionOptions, resp.ConfigOptions,
	)
	if err := conv.applyTurnSettings(ctx, ports.ChatTurnSettings{Approval: cfg.Permissions}); err != nil {
		_ = conv.Close()
		return nil, fmt.Errorf("%w: configure ACP session: %v", ports.ErrChatResumeFailed, err)
	}
	return conv, nil
}

func (d *Driver) connect(
	ctx context.Context,
	workspace string,
	env map[string]string,
) (*conversation, acpsdk.InitializeResponse, error) {
	launch, err := d.cfg.Launch(ctx, workspace, env)
	if err != nil {
		return nil, acpsdk.InitializeResponse{}, err
	}
	if launch.Command == "" {
		return nil, acpsdk.InitializeResponse{}, fmt.Errorf("%w: ACP launch command is empty", ports.ErrChatDriverUnavailable)
	}
	proc, err := d.spawn(launch, workspace)
	if err != nil {
		return nil, acpsdk.InitializeResponse{}, fmt.Errorf("%w: launch ACP agent: %v", ports.ErrChatDriverUnavailable, err)
	}
	conv := newConversation(proc, d.log)

	initCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	init, err := conv.conn.Initialize(initCtx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo: &acpsdk.Implementation{
			Name:    "agent-orchestrator",
			Title:   pointer("Agent Orchestrator"),
			Version: "0.1.0",
		},
		ClientCapabilities: acpsdk.ClientCapabilities{},
	})
	if err != nil {
		_ = conv.Close()
		return nil, acpsdk.InitializeResponse{}, fmt.Errorf("%w: ACP initialize: %v", ports.ErrChatDriverIncompatible, err)
	}
	return conv, init, nil
}

func cloneCapabilities(in ports.ChatCapabilities) ports.ChatCapabilities {
	out := make(ports.ChatCapabilities, len(in))
	for capability, enabled := range in {
		out[capability] = enabled
	}
	return out
}

func conversationCapabilities(
	configured ports.ChatCapabilities,
	init acpsdk.InitializeResponse,
) ports.ChatCapabilities {
	caps := cloneCapabilities(configured)
	if init.AgentCapabilities.SessionCapabilities.Resume == nil {
		caps[ports.ChatCapabilityResume] = false
	}
	if extensionSupported(init.Meta, "steering") {
		caps[ports.ChatCapabilitySteer] = true
	}
	return caps
}

func extensionSupported(meta map[string]any, name string) bool {
	extension, ok := meta[name].(map[string]any)
	if !ok {
		return false
	}
	supported, _ := extension["supported"].(bool)
	return supported
}

func pointer[T any](value T) *T { return &value }
