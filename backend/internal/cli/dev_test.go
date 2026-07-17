package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/devimport"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

type devImportCapture struct {
	method string
	path   string
	body   devImportProjectsRequest
}

func devImportServer(t *testing.T, status int, report devimport.Report) (*httptest.Server, *devImportCapture) {
	t.Helper()
	capture := &devImportCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.method = r.Method
		capture.path = r.URL.Path
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/dev/import-projects" {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &capture.body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(devImportProjectsResponse{Report: report})
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestDevImportProjectsDryRunCallsLiveDaemon(t *testing.T) {
	cfg := setConfigEnv(t)
	sourceDir := filepath.Join(t.TempDir(), "source")
	srv, capture := devImportServer(t, http.StatusOK, devimport.Report{
		SourceDataDir: sourceDir,
		TargetDataDir: cfg.dataDir,
		DryRun:        true,
		Inserted:      1,
	})
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "dev", "import-projects", "--from-data-dir", sourceDir, "--dry-run")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/dev/import-projects" {
		t.Fatalf("request = %s %s, want POST /api/v1/dev/import-projects", capture.method, capture.path)
	}
	if capture.body.SourceDataDir != sourceDir || !capture.body.DryRun {
		t.Fatalf("request body = %#v", capture.body)
	}
	if !strings.Contains(out, "Dry run -- no changes written.") || !strings.Contains(out, "Inserted: 1") {
		t.Fatalf("out = %q", out)
	}
}

func TestDevImportProjectsJSON(t *testing.T) {
	cfg := setConfigEnv(t)
	sourceDir := filepath.Join(t.TempDir(), "source")
	srv, _ := devImportServer(t, http.StatusOK, devimport.Report{
		SourceDataDir: sourceDir,
		TargetDataDir: cfg.dataDir,
		Inserted:      1,
	})
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "dev", "import-projects", "--from-data-dir", sourceDir, "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var rep devimport.Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("parse report %q: %v", out, err)
	}
	if rep.SourceDataDir != sourceDir || rep.Inserted != 1 || rep.Updated != 0 || rep.Skipped != 0 {
		t.Fatalf("report = %#v", rep)
	}
}

func TestDevImportProjectsDaemonError(t *testing.T) {
	cfg := setConfigEnv(t)
	sourceDir := filepath.Join(t.TempDir(), "source")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"message":"open source store: file does not exist","code":"INTERNAL"}`)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "dev", "import-projects", "--from-data-dir", sourceDir, "--dry-run")
	if err == nil || !strings.Contains(err.Error(), "open source store") {
		t.Fatalf("err = %v, want daemon source open failure", err)
	}
}

func TestDevImportProjectsRefusesSameSourceAndTargetDataDir(t *testing.T) {
	cfg := setConfigEnv(t)
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 3002, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "dev", "import-projects", "--from-data-dir", cfg.dataDir)
	if err == nil || !strings.Contains(err.Error(), "source and target data dirs are the same") {
		t.Fatalf("err = %v, want same-dir refusal", err)
	}
}
