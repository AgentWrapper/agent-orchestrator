// Package sandboxresolve selects an AO-managed or user-owned provider
// connection without leaking provider credentials into session domain records.
package sandboxresolve

import (
	"context"
	"encoding/json"
	"fmt"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/daytona"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
)

type providerSecretStore interface {
	ProviderConnectionSecret(context.Context, clouddomain.AccountID, string) ([]byte, []byte, json.RawMessage, string, error)
}

// Resolver selects and configures the sandbox provider for a session.
type Resolver struct {
	store           providerSecretStore
	cipher          *cloudsecrets.Cipher
	defaultAPIURL   string
	defaultTarget   string
	defaultProvider cloudsandbox.Provider
	dockerProvider  cloudsandbox.Provider
	ecsProvider     cloudsandbox.Provider
}

// New creates a sandbox provider resolver.
func New(
	store providerSecretStore,
	cipher *cloudsecrets.Cipher,
	defaultAPIURL, defaultTarget string,
	defaultProvider cloudsandbox.Provider,
	dockerProvider cloudsandbox.Provider,
	ecsProvider cloudsandbox.Provider,
) *Resolver {
	return &Resolver{
		store:           store,
		cipher:          cipher,
		defaultAPIURL:   defaultAPIURL,
		defaultTarget:   defaultTarget,
		defaultProvider: defaultProvider,
		dockerProvider:  dockerProvider,
		ecsProvider:     ecsProvider,
	}
}

// Resolve returns the provider authorized for sandbox.
func (r *Resolver) Resolve(
	ctx context.Context,
	sandbox clouddomain.Sandbox,
) (cloudsandbox.Provider, error) {
	if sandbox.Provider == "docker" {
		if r.dockerProvider == nil {
			return nil, fmt.Errorf("docker sandbox provider is not configured")
		}
		return r.dockerProvider, nil
	}
	if sandbox.Provider == "ecs" {
		if r.ecsProvider == nil {
			return nil, fmt.Errorf("ecs sandbox provider is not configured")
		}
		return r.ecsProvider, nil
	}
	if sandbox.Provider != "daytona" {
		return nil, fmt.Errorf("unsupported sandbox provider %q", sandbox.Provider)
	}
	if sandbox.ProviderConnectionID == "" {
		return r.defaultProvider, nil
	}
	encrypted, nonce, rawConfig, label, err := r.store.ProviderConnectionSecret(
		ctx,
		sandbox.AccountID,
		sandbox.ProviderConnectionID,
	)
	if err != nil {
		return nil, err
	}
	associatedData := string(sandbox.AccountID) + ":daytona:" + label
	secret, err := r.cipher.Decrypt(encrypted, nonce, associatedData)
	if err != nil {
		return nil, err
	}
	config := struct {
		APIURL string `json:"apiUrl"`
		Target string `json:"target"`
	}{
		APIURL: r.defaultAPIURL,
		Target: r.defaultTarget,
	}
	if len(rawConfig) > 0 {
		if err := json.Unmarshal(rawConfig, &config); err != nil {
			return nil, fmt.Errorf("decode provider connection config: %w", err)
		}
	}
	return daytona.New(config.APIURL, string(secret), config.Target, nil), nil
}
