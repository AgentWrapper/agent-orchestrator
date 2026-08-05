// Package sandbox defines the provider-neutral cloud execution boundary.
package sandbox

import (
	"context"
	"errors"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// ErrNotFound indicates that a provider environment does not exist.
var ErrNotFound = errors.New("sandbox environment not found")

// ID uniquely identifies a provider sandbox.
type ID string

// Spec describes a sandbox to create.
type Spec struct {
	Name              string
	SessionID         clouddomain.SessionID
	ResourceProfile   clouddomain.ResourceProfile
	Snapshot          string
	Image             string
	Environment       map[string]string
	Labels            map[string]string
	AutoStopMinutes   int
	AutoDeleteMinutes int
}

// Environment is the provider-neutral view of a sandbox.
type Environment struct {
	ID           ID
	Name         string
	State        string
	DesiredState string
	Target       string
	Resource     clouddomain.ResourceProfile
}

// WorkerBootstrap contains the worker executable and launch environment.
type WorkerBootstrap struct {
	Binary      []byte
	Destination string
	Environment map[string]string
}

// Bootstrapper installs and starts an AO worker in an existing sandbox.
type Bootstrapper interface {
	BootstrapWorker(context.Context, ID, WorkerBootstrap) error
}

// Recreator re-establishes compute with a fresh worker launch while preserving
// the sandbox's provider-managed workspace storage.
type Recreator interface {
	Recreate(context.Context, ID, Spec) (Environment, error)
}

// Provider manages the lifecycle of cloud sandbox environments.
type Provider interface {
	Create(context.Context, Spec) (Environment, error)
	Get(context.Context, ID) (Environment, error)
	FindBySession(context.Context, clouddomain.SessionID) (Environment, bool, error)
	Start(context.Context, ID) error
	Stop(context.Context, ID) error
	Pause(context.Context, ID) error
	Resume(context.Context, ID) error
	Delete(context.Context, ID) error
}
