// Package secrets defines credential custody for AO Cloud. The control plane
// stores provider credentials server-side, encrypted at rest, without binding
// the core code to one cloud KMS.
package secrets

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
)

// Manager encrypts and decrypts user-provided agent credentials.
type Manager interface {
	Encrypt(ctx context.Context, plaintext []byte) (Ciphertext, error)
	Decrypt(ctx context.Context, ciphertext Ciphertext) ([]byte, error)
}

// Ciphertext is the storage representation for encrypted secret material.
type Ciphertext struct {
	Algorithm string
	KeyID     string
	Nonce     []byte
	Body      []byte
}

// LocalEnvelopeManager is the development implementation. It intentionally
// exposes the same Manager port a future KMS-backed envelope implementation
// will satisfy.
type LocalEnvelopeManager struct {
	key   []byte
	keyID string
}

// NewLocalEnvelopeManager derives an AES-256-GCM key from a local dev secret.
func NewLocalEnvelopeManager(keyMaterial, keyID string) (*LocalEnvelopeManager, error) {
	if keyMaterial == "" {
		return nil, fmt.Errorf("secret key material is required")
	}
	sum := sha256.Sum256([]byte(keyMaterial))
	if keyID == "" {
		keyID = "local-dev"
	}
	return &LocalEnvelopeManager{key: sum[:], keyID: keyID}, nil
}

// Encrypt encrypts plaintext using local AES-256-GCM key material.
func (m *LocalEnvelopeManager) Encrypt(_ context.Context, plaintext []byte) (Ciphertext, error) {
	block, err := aes.NewCipher(m.key)
	if err != nil {
		return Ciphertext{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Ciphertext{}, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return Ciphertext{}, err
	}
	body := gcm.Seal(nil, nonce, plaintext, nil)
	return Ciphertext{Algorithm: "AES-256-GCM", KeyID: m.keyID, Nonce: nonce, Body: body}, nil
}

// Decrypt decrypts ciphertext produced by Encrypt.
func (m *LocalEnvelopeManager) Decrypt(_ context.Context, ciphertext Ciphertext) ([]byte, error) {
	if ciphertext.Algorithm != "AES-256-GCM" {
		return nil, fmt.Errorf("unsupported secret algorithm %q", ciphertext.Algorithm)
	}
	block, err := aes.NewCipher(m.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, ciphertext.Nonce, ciphertext.Body, nil)
}

// EncodeField stores binary secret components in text columns.
func EncodeField(b []byte) string {
	return base64.RawStdEncoding.EncodeToString(b)
}

// DecodeField loads binary secret components from text columns.
func DecodeField(s string) ([]byte, error) {
	return base64.RawStdEncoding.DecodeString(s)
}
