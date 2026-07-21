package httpd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const cliTelemetryStateFile = "telemetry_cli_daily.json"

type cliTelemetryReservoir struct {
	mu sync.Mutex

	path        string
	activeDay   string
	invokedDay  string
	invokedSeen map[string]struct{}
}

type cliTelemetryState struct {
	ActiveDay   string   `json:"active_day"`
	InvokedDay  string   `json:"invoked_day"`
	InvokedSeen []string `json:"invoked_seen"`
}

func newCLITelemetryReservoir(dataDir string) *cliTelemetryReservoir {
	r := &cliTelemetryReservoir{
		invokedSeen: make(map[string]struct{}),
	}
	if dataDir != "" {
		r.path = filepath.Join(dataDir, cliTelemetryStateFile)
		r.load()
	}
	return r
}

func (r *cliTelemetryReservoir) reserveActive(now time.Time) bool {
	day := telemetryUTCDate(now)
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.activeDay == day {
		return false
	}
	r.activeDay = day
	_ = r.saveLocked()
	return true
}

func (r *cliTelemetryReservoir) reserveInvoked(now time.Time, commandPath string) bool {
	day := telemetryUTCDate(now)
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.invokedDay != day {
		r.invokedDay = day
		r.invokedSeen = make(map[string]struct{})
	}
	if _, seen := r.invokedSeen[commandPath]; seen {
		return false
	}
	r.invokedSeen[commandPath] = struct{}{}
	_ = r.saveLocked()
	return true
}

func telemetryUTCDate(now time.Time) string {
	return now.UTC().Format("2006-01-02")
}

func (r *cliTelemetryReservoir) load() {
	if r.path == "" {
		return
	}
	b, err := os.ReadFile(r.path)
	if err != nil {
		return
	}
	var st cliTelemetryState
	if err := json.Unmarshal(b, &st); err != nil {
		return
	}
	r.activeDay = st.ActiveDay
	r.invokedDay = st.InvokedDay
	r.invokedSeen = make(map[string]struct{}, len(st.InvokedSeen))
	for _, commandPath := range st.InvokedSeen {
		if commandPath != "" {
			r.invokedSeen[commandPath] = struct{}{}
		}
	}
}

func (r *cliTelemetryReservoir) saveLocked() error {
	if r.path == "" {
		return nil
	}
	seen := make([]string, 0, len(r.invokedSeen))
	for commandPath := range r.invokedSeen {
		seen = append(seen, commandPath)
	}
	body, err := json.Marshal(cliTelemetryState{
		ActiveDay:   r.activeDay,
		InvokedDay:  r.invokedDay,
		InvokedSeen: seen,
	})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(r.path), ".telemetry-cli-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, r.path); err != nil {
		if removeErr := os.Remove(r.path); removeErr != nil && !os.IsNotExist(removeErr) {
			return err
		}
		return os.Rename(tmpName, r.path)
	}
	return nil
}
