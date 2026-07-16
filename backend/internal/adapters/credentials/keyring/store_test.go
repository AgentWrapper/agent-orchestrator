package keyring

import (
	"context"
	"errors"
	"strings"
	"testing"

	zkeyring "github.com/zalando/go-keyring"
)

type memoryBackend struct {
	values    map[string]string
	setErr    error
	getErr    error
	deleteErr error
}

func (b *memoryBackend) Set(service, user, password string) error {
	if b.setErr != nil {
		return b.setErr
	}
	if b.values == nil {
		b.values = make(map[string]string)
	}
	b.values[service+"\x00"+user] = password
	return nil
}

func (b *memoryBackend) Get(service, user string) (string, error) {
	if b.getErr != nil {
		return "", b.getErr
	}
	value, ok := b.values[service+"\x00"+user]
	if !ok {
		return "", zkeyring.ErrNotFound
	}
	return value, nil
}

func (b *memoryBackend) Delete(service, user string) error {
	if b.deleteErr != nil {
		return b.deleteErr
	}
	key := service + "\x00" + user
	if _, ok := b.values[key]; !ok {
		return zkeyring.ErrNotFound
	}
	delete(b.values, key)
	return nil
}

func TestStorePutGetDelete(t *testing.T) {
	ctx := context.Background()
	s := newStore(&memoryBackend{})
	secret := []byte("vault-round-trip-secret")

	if err := s.Put(ctx, "scm/gitlab-work", secret); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, ok, err := s.Get(ctx, "scm/gitlab-work")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if string(got) != string(secret) {
		t.Fatalf("get = %q, want original secret", got)
	}
	got[0] = 'X'
	again, _, err := s.Get(ctx, "scm/gitlab-work")
	if err != nil || string(again) != string(secret) {
		t.Fatalf("caller mutated stored secret: got=%q err=%v", again, err)
	}
	if err := s.Delete(ctx, "scm/gitlab-work"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok, err := s.Get(ctx, "scm/gitlab-work"); err != nil || ok {
		t.Fatalf("get deleted: ok=%v err=%v", ok, err)
	}
	if err := s.Delete(ctx, "scm/gitlab-work"); err != nil {
		t.Fatalf("delete missing must be idempotent: %v", err)
	}
}

func TestStoreGetMissing(t *testing.T) {
	s := newStore(&memoryBackend{})
	secret, ok, err := s.Get(context.Background(), "scm/missing")
	if err != nil || ok || secret != nil {
		t.Fatalf("Get missing = (%q, %v, %v), want (nil, false, nil)", secret, ok, err)
	}
}

func TestStoreErrorsDoNotExposeSecrets(t *testing.T) {
	secret := "vault-secret-must-be-redacted"
	cause := errors.New("vault rejected " + secret)
	s := newStore(&memoryBackend{setErr: cause})

	err := s.Put(context.Background(), "scm/gitlab-work", []byte(secret))
	if err == nil {
		t.Fatal("put succeeded")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked secret: %v", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("error does not preserve cause: %v", err)
	}
}
