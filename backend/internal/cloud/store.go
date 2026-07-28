package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Store persists the cloud-session registry so sessions survive a restart. The
// local daemon uses JSONStore (a file under ~/.ao); the control plane injects a
// tenant-scoped SQL store (see internal/controlplane). Load returns every
// persisted session; Save replaces the whole set (the supervisor holds the
// authoritative in-memory map and writes it out on each change).
type Store interface {
	Load() ([]CloudSession, error)
	Save(sessions []CloudSession) error
}

// JSONStore persists the registry as a single JSON file. Empty Path = no-op
// (in-memory only), which keeps tests and keyless dev runs simple.
type JSONStore struct {
	Path string
}

func (s *JSONStore) Load() ([]CloudSession, error) {
	if s.Path == "" {
		return nil, nil
	}
	buf, err := os.ReadFile(s.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var rows []CloudSession
	if err := json.Unmarshal(buf, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *JSONStore) Save(sessions []CloudSession) error {
	if s.Path == "" {
		return nil
	}
	buf, err := json.Marshal(sessions)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.Path, buf, 0o600)
}
