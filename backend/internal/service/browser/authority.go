package browser

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const capabilityKeyFile = "browser-capability.key"

// Authority issues stable, unguessable per-session browser capabilities. The
// daemon-local key survives restarts while the derived token is only exposed to
// the worker process that owns the session.
type Authority struct {
	key []byte
}

// LoadAuthority loads or creates the daemon-local browser capability key.
func LoadAuthority(dataDir string) (*Authority, error) {
	path := filepath.Join(dataDir, capabilityKeyFile)
	key, err := os.ReadFile(path)
	if err == nil {
		if len(key) != sha256.Size {
			return nil, fmt.Errorf("browser capability key has invalid length")
		}
		return &Authority{key: key}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read browser capability key: %w", err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create browser capability directory: %w", err)
	}
	key = make([]byte, sha256.Size)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate browser capability key: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return LoadAuthority(dataDir)
	}
	if err != nil {
		return nil, fmt.Errorf("create browser capability key: %w", err)
	}
	written, err := file.Write(key)
	if err == nil && written != len(key) {
		err = io.ErrShortWrite
	}
	if err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("write browser capability key: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close browser capability key: %w", err)
	}
	return &Authority{key: key}, nil
}

// Token derives the capability injected into one worker runtime.
func (a *Authority) Token(sessionID domain.SessionID) string {
	if a == nil || len(a.key) == 0 || sessionID == "" {
		return ""
	}
	mac := hmac.New(sha256.New, a.key)
	_, _ = mac.Write([]byte(sessionID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Valid performs a constant-time comparison against the expected capability.
func (a *Authority) Valid(sessionID domain.SessionID, token string) bool {
	expected := a.Token(sessionID)
	return expected != "" && hmac.Equal([]byte(expected), []byte(token))
}
