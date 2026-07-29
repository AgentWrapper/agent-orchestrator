package cloud

import (
	"context"
	"fmt"
)

// SandboxProvider abstracts the sandbox substrate so AO is not tied to one
// vendor. Daytona is the default implementation; a new backend (e2b, Fly,
// Modal, Firecracker, a self-hosted runner, …) is added by implementing this
// interface — the Supervisor depends ONLY on this, never on a concrete client.
//
// The data types it uses (Sandbox, CreateSandboxRequest, ExecuteRequest/…,
// SignedPreviewURL) are provider-neutral: a new provider maps them onto its own
// API. Provider-specific handles (e.g. Daytona's ToolboxProxyURL) ride along as
// opaque fields on Sandbox and are only meaningful to the provider that set them.
type SandboxProvider interface {
	// Name identifies the backend (for logs/telemetry), e.g. "daytona", "e2b".
	Name() string

	// Lifecycle.
	Create(ctx context.Context, req CreateSandboxRequest) (*Sandbox, error)
	Get(ctx context.Context, id string) (*Sandbox, error)
	Start(ctx context.Context, id string) error
	Delete(ctx context.Context, id string) error
	List(ctx context.Context) ([]Sandbox, error)

	// In-sandbox operations.
	Exec(ctx context.Context, box Sandbox, req ExecuteRequest) (*ExecuteResponse, error)
	UploadFile(ctx context.Context, box Sandbox, remotePath string, data []byte) error

	// SignedPreview mints a time-limited URL to reach a port inside the sandbox
	// (the token is embedded so browsers/WS work without a header).
	SignedPreview(ctx context.Context, id string, port, ttlSeconds int) (*SignedPreviewURL, error)
}

// ProviderFactory builds a SandboxProvider from a single credential (an API key,
// service-account JSON, etc.). Swapping the sandbox vendor = swapping this one
// function in SupervisorConfig; nothing else in the supervisor changes.
type ProviderFactory func(credential string) (SandboxProvider, error)

// DaytonaProviderFactory is the default substrate: Daytona hosted cloud.
func DaytonaProviderFactory(credential string) (SandboxProvider, error) {
	if credential == "" {
		return nil, fmt.Errorf("cloud: sandbox provider credential not configured")
	}
	return NewDaytonaClient(credential, ""), nil
}

// Compile-time proof that the Daytona client satisfies the neutral interface.
var _ SandboxProvider = (*DaytonaClient)(nil)
