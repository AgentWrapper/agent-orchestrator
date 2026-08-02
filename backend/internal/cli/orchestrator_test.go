package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func orchestratorCommandServer(t *testing.T) (*httptest.Server, *sessionRequestLog) {
	t.Helper()
	log := &sessionRequestLog{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.append(r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/orchestrators":
			_, _ = io.WriteString(w, `{"sessions":[`+
				sessionJSON("other-orch", "other", "orchestrator", "idle", false)+`,`+
				sessionJSON("demo-worker", "demo", "worker", "working", false)+`,`+
				sessionJSON("demo-orch", "demo", "orchestrator", "working", false)+`]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, log
}

func TestOrchestratorList_TableOutput(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, log := orchestratorCommandServer(t)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "orchestrator", "ls")
	if err != nil {
		t.Fatalf("orchestrator ls failed: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "demo:") || !strings.Contains(out, "demo-orch") {
		t.Fatalf("output missing demo orchestrator:\n%s", out)
	}
	if !strings.Contains(out, "other:") || !strings.Contains(out, "other-orch") {
		t.Fatalf("output missing other orchestrator:\n%s", out)
	}
	if strings.Contains(out, "demo-worker") {
		t.Fatalf("worker session should not be shown in orchestrator ls:\n%s", out)
	}
	want := []string{"GET /api/v1/orchestrators"}
	if got := log.all(); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %#v, want %#v", got, want)
	}
}

func TestOrchestratorList_JSONOutputDecodes(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := orchestratorCommandServer(t)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "orchestrator", "ls", "--json")
	if err != nil {
		t.Fatalf("orchestrator ls --json failed: %v\nstderr=%s", err, errOut)
	}
	var got orchestratorListOutput
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("orchestrator ls --json output is not decodable: %v\noutput=%s", err, out)
	}
	if len(got.Data) != 2 {
		t.Fatalf("len(data) = %d, want 2; data=%#v", len(got.Data), got.Data)
	}
	if got.Data[0].ID != "demo-orch" || got.Data[0].ProjectID != "demo" || got.Data[0].Role != "orchestrator" {
		t.Fatalf("unexpected first JSON entry: %#v", got.Data[0])
	}
	if got.Data[1].ID != "other-orch" || got.Data[1].ProjectID != "other" || got.Data[1].Role != "orchestrator" {
		t.Fatalf("unexpected second JSON entry: %#v", got.Data[1])
	}
}
