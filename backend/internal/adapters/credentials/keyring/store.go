// Package keyring stores credentials in the operating system credential vault.
package keyring

import (
	"context"
	"errors"

	zkeyring "github.com/zalando/go-keyring"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const serviceName = "agent-orchestrator"

type vaultBackend interface {
	Set(service, user, password string) error
	Get(service, user string) (string, error)
	Delete(service, user string) error
}

type systemBackend struct{}

func (systemBackend) Set(service, user, password string) error {
	return zkeyring.Set(service, user, password)
}

func (systemBackend) Get(service, user string) (string, error) {
	return zkeyring.Get(service, user)
}

func (systemBackend) Delete(service, user string) error {
	return zkeyring.Delete(service, user)
}

// Store implements the credential port using the native OS credential vault.
type Store struct {
	backend vaultBackend
}

var _ ports.CredentialStore = (*Store)(nil)

// New returns a credential store backed by the native OS credential vault.
func New() *Store {
	return newStore(systemBackend{})
}

func newStore(backend vaultBackend) *Store {
	return &Store{backend: backend}
}

// Put stores secret under ref without writing it to application storage.
func (s *Store) Put(ctx context.Context, ref string, secret []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.backend.Set(serviceName, ref, string(secret)); err != nil {
		return vaultOperationError{operation: "put", cause: err}
	}
	return nil
}

// Get returns a copy of the secret stored under ref.
func (s *Store) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	secret, err := s.backend.Get(serviceName, ref)
	if errors.Is(err, zkeyring.ErrNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, vaultOperationError{operation: "get", cause: err}
	}
	return []byte(secret), true, nil
}

// Delete removes ref. Removing a missing credential is idempotent.
func (s *Store) Delete(ctx context.Context, ref string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	err := s.backend.Delete(serviceName, ref)
	if errors.Is(err, zkeyring.ErrNotFound) {
		return nil
	}
	if err != nil {
		return vaultOperationError{operation: "delete", cause: err}
	}
	return nil
}

type vaultOperationError struct {
	operation string
	cause     error
}

func (e vaultOperationError) Error() string {
	return "credential store: " + e.operation + " failed"
}

func (e vaultOperationError) Unwrap() error {
	return e.cause
}
