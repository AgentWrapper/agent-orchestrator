package ports

import "context"

// CredentialStore persists write-only secrets outside application storage.
type CredentialStore interface {
	Put(ctx context.Context, ref string, secret []byte) error
	Get(ctx context.Context, ref string) ([]byte, bool, error)
	Delete(ctx context.Context, ref string) error
}
