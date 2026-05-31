package project

import "github.com/aoagents/agent-orchestrator/backend/internal/domain"

// Project entities and the behaviour-config shapes they expose. These live in
// the project package (not domain/) because they are owned solely by the
// projects surface — only project identity (domain.ProjectID) is shared
// vocabulary with sessions/lifecycle/workspace, so that one type stays in
// domain. Keeping the entities, the Manager interface (project.go), and the
// transport DTOs (dto.go) together is the feature-package layout the backend
// is migrating toward.

// Summary is the row shape returned by GET /api/v1/projects. It mirrors the TS
// ProjectInfo (packages/web/src/lib/project-name.ts) so the existing dashboard
// list view reads the Go daemon's response unchanged. ResolveError is set only
// for degraded projects (registry entry survives but config failed to load),
// so the list shows them with a warning instead of dropping them silently.
type Summary struct {
	ID            domain.ProjectID `json:"id"`
	Name          string           `json:"name"`
	SessionPrefix string           `json:"sessionPrefix"`
	ResolveError  string           `json:"resolveError,omitempty"`
}

// Project is the full read-model returned by GET /api/v1/projects/{id} when the
// project resolves cleanly. It joins the registry identity fields with the
// project's behaviour config.
type Project struct {
	ID            domain.ProjectID           `json:"id"`
	Name          string                     `json:"name"`
	Path          string                     `json:"path"`
	Repo          string                     `json:"repo"` // "owner/name" or ""
	DefaultBranch string                     `json:"defaultBranch"`
	Agent         string                     `json:"agent,omitempty"`
	Runtime       string                     `json:"runtime,omitempty"`
	Tracker       *TrackerConfig             `json:"tracker,omitempty"`
	SCM           *SCMConfig                 `json:"scm,omitempty"`
	Reactions     map[string]*ReactionConfig `json:"reactions,omitempty"`
}

// Degraded is returned in place of Project when the project's config failed to
// load. The frontend uses ResolveError to render a recovery UI; the
// /projects/{id}/repair endpoint fixes a recoverable subset (e.g. legacy
// wrapped-config format).
type Degraded struct {
	ID           domain.ProjectID `json:"id"`
	Name         string           `json:"name"`
	Path         string           `json:"path"`
	ResolveError string           `json:"resolveError"`
}

// Behaviour-config shapes ported from the TS Zod schemas (packages/core/src/
// config.ts). Only the fields the projects API actually exposes are modelled;
// the passthrough/unknown-key round-trip the legacy schemas allowed lands with
// the handler implementation (and the SQLite persistence work), not in this
// interface-only PR.

// TrackerConfig mirrors TrackerConfigSchema.
type TrackerConfig struct {
	Plugin  string `json:"plugin,omitempty"`
	Package string `json:"package,omitempty"`
	Path    string `json:"path,omitempty"`
}

// SCMConfig mirrors SCMConfigSchema; Webhook nests its own optional block.
type SCMConfig struct {
	Plugin  string            `json:"plugin,omitempty"`
	Package string            `json:"package,omitempty"`
	Path    string            `json:"path,omitempty"`
	Webhook *SCMWebhookConfig `json:"webhook,omitempty"`
}

// SCMWebhookConfig — pointer Enabled distinguishes unset from explicit false.
type SCMWebhookConfig struct {
	Enabled         *bool  `json:"enabled,omitempty"`
	Path            string `json:"path,omitempty"`
	SecretEnvVar    string `json:"secretEnvVar,omitempty"`
	SignatureHeader string `json:"signatureHeader,omitempty"`
	EventHeader     string `json:"eventHeader,omitempty"`
	DeliveryHeader  string `json:"deliveryHeader,omitempty"`
	MaxBodyBytes    int    `json:"maxBodyBytes,omitempty"`
}

// ReactionConfig mirrors ReactionConfigSchema. EscalateAfter is either ms
// (number) or a duration string ("30m") in the TS schema, so it stays open as
// `any` until handler validation lands.
type ReactionConfig struct {
	Auto           *bool  `json:"auto,omitempty"`
	Action         string `json:"action,omitempty"` // send-to-agent | notify | auto-merge
	Message        string `json:"message,omitempty"`
	Priority       string `json:"priority,omitempty"` // urgent | action | warning | info
	Retries        *int   `json:"retries,omitempty"`
	EscalateAfter  any    `json:"escalateAfter,omitempty"`
	Threshold      string `json:"threshold,omitempty"`
	IncludeSummary *bool  `json:"includeSummary,omitempty"`
}
