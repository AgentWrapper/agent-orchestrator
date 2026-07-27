package candidaterun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestObserverClientAcknowledgesClaimBeforeAllocation(t *testing.T) {
	configPath := writeTestConfig(t)
	client, err := Open(context.Background(), configPath, nil)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	client.clock = func() time.Time {
		return time.Date(2026, 7, 26, 20, 1, 0, 0, time.UTC)
	}

	claim, err := client.Claim(context.Background(), ports.CandidateRunClaimRequest{
		ProjectID:       "fixture",
		IssueID:         "github:taymoork2/tenetfold-orchestration-fixture#21",
		RequestedBranch: "",
	})
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if claim.Slot != "A" || claim.Branch != "fixture/agent-orchestrator/s1" {
		t.Fatalf("claim = %#v, want prepared slot A and branch", claim)
	}
	if claim.ClaimID == "" || claim.ControllerInstanceID == "" {
		t.Fatalf("claim = %#v, want process-bound identities", claim)
	}

	records := readTestJournal(t, filepath.Dir(configPath))
	if len(records) != 2 {
		t.Fatalf("journal records = %d, want configure plus claim", len(records))
	}
	if records[1]["type"] != "task-claimed" {
		t.Fatalf("second record = %#v, want task-claimed", records[1])
	}
	payload := records[1]["payload"].(map[string]any)
	if payload["controllerInstanceId"] != claim.ControllerInstanceID {
		t.Fatalf("claim controller instance = %v, want %q", payload["controllerInstanceId"], claim.ControllerInstanceID)
	}
}

func TestObserverClientRecordsReceiptBeforeSessionStart(t *testing.T) {
	configPath := writeTestConfig(t)
	client, err := Open(context.Background(), configPath, nil)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	client.clock = func() time.Time {
		return time.Date(2026, 7, 26, 20, 2, 0, 0, time.UTC)
	}
	claim, err := client.Claim(context.Background(), ports.CandidateRunClaimRequest{
		ProjectID: "fixture",
		IssueID:   "github:taymoork2/tenetfold-orchestration-fixture#21",
	})
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}

	if err := client.RecordAllocation(
		context.Background(),
		claim,
		"fixture-1",
		"/tmp/fixture-1",
	); err != nil {
		t.Fatalf("RecordAllocation: %v", err)
	}
	if err := client.RecordSessionStartRequested(context.Background(), "fixture-1"); err != nil {
		t.Fatalf("RecordSessionStartRequested: %v", err)
	}
	if err := client.RecordSessionStarted(context.Background(), "fixture-1"); err != nil {
		t.Fatalf("RecordSessionStarted: %v", err)
	}

	records := readTestJournal(t, filepath.Dir(configPath))
	var types []any
	for _, record := range records {
		types = append(types, record["type"])
	}
	wantTypes := []any{
		"run-configured",
		"task-claimed",
		"task-allocated",
		"session-start-requested",
		"session-started",
	}
	if !reflect.DeepEqual(types, wantTypes) {
		t.Fatalf("record types = %#v, want %#v", types, wantTypes)
	}
	receipt := records[2]["payload"].(map[string]any)["allocationReceipt"].(map[string]any)
	if receipt["runtimeTaskId"] != "fixture-1" ||
		receipt["workspace"] != "/tmp/fixture-1" ||
		receipt["sourceWriter"] != "agent-orchestrator:fixture-1" ||
		receipt["requestedBranch"] != claim.Branch {
		t.Fatalf("allocation receipt = %#v, want complete AO-native identities", receipt)
	}
	if receipt["runtimeHostId"] != nil {
		t.Fatalf("runtimeHostId = %#v, want explicit null", receipt["runtimeHostId"])
	}
}

func TestObserverClientRejectsOffTargetPullRequest(t *testing.T) {
	configPath := writeTestConfig(t)
	client, err := Open(context.Background(), configPath, nil)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	client.clock = func() time.Time {
		return time.Date(2026, 7, 26, 20, 3, 0, 0, time.UTC)
	}
	claim, err := client.Claim(context.Background(), ports.CandidateRunClaimRequest{
		ProjectID: "fixture",
		IssueID:   "github:taymoork2/tenetfold-orchestration-fixture#21",
	})
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if err := client.RecordAllocation(context.Background(), claim, "fixture-1", "/tmp/fixture-1"); err != nil {
		t.Fatalf("RecordAllocation: %v", err)
	}
	if err := client.RecordSessionStartRequested(context.Background(), "fixture-1"); err != nil {
		t.Fatalf("RecordSessionStartRequested: %v", err)
	}
	if err := client.RecordSessionStarted(context.Background(), "fixture-1"); err != nil {
		t.Fatalf("RecordSessionStarted: %v", err)
	}

	offTarget := ports.SCMObservation{
		ObservedAt: time.Date(2026, 7, 26, 20, 4, 0, 0, time.UTC),
		Repo:       "other/repository",
		PR: ports.SCMPRObservation{
			Number:       84,
			URL:          "https://github.com/other/repository/pull/84",
			SourceBranch: "feat/off-target",
		},
	}
	if err := client.RecordPullRequest(context.Background(), "fixture-1", offTarget); err == nil {
		t.Fatal("RecordPullRequest off-target error = nil, want rejection")
	}

	onTarget := offTarget
	onTarget.Repo = claim.Repository
	onTarget.PR.URL = "https://github.com/taymoork2/tenetfold-orchestration-fixture/pull/84"
	onTarget.PR.SourceBranch = claim.Branch
	if err := client.RecordPullRequest(context.Background(), "fixture-1", onTarget); err != nil {
		t.Fatalf("RecordPullRequest on-target: %v", err)
	}

	records := readTestJournal(t, filepath.Dir(configPath))
	var pullRequests int
	for _, record := range records {
		if record["type"] == "pull-request-opened" {
			pullRequests++
		}
	}
	if pullRequests != 1 {
		t.Fatalf("pull-request-opened records = %d, want only the target-bound observation", pullRequests)
	}
}

func TestObserverClientRecordsStopOnlyWithZeroDescendantProof(t *testing.T) {
	configPath := writeTestConfig(t)
	client, err := Open(context.Background(), configPath, nil)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	client.clock = func() time.Time {
		return time.Date(2026, 7, 26, 20, 5, 0, 0, time.UTC)
	}
	claim, err := client.Claim(context.Background(), ports.CandidateRunClaimRequest{
		ProjectID: "fixture",
		IssueID:   "github:taymoork2/tenetfold-orchestration-fixture#21",
	})
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if err := client.RecordAllocation(context.Background(), claim, "fixture-1", "/tmp/fixture-1"); err != nil {
		t.Fatalf("RecordAllocation: %v", err)
	}
	if err := client.RecordSessionStartRequested(context.Background(), "fixture-1"); err != nil {
		t.Fatalf("RecordSessionStartRequested: %v", err)
	}
	if err := client.RecordSessionStarted(context.Background(), "fixture-1"); err != nil {
		t.Fatalf("RecordSessionStarted: %v", err)
	}

	if err := client.RecordStopped(context.Background(), "fixture-1", "operator stop", ports.RuntimeStopProof{
		ProcessID:          "4242",
		DescendantIDs:      []string{"4243", "4244"},
		DescendantsRunning: 1,
	}); err == nil {
		t.Fatal("RecordStopped with a running descendant error = nil, want rejection")
	}
	if err := client.RecordStopped(context.Background(), "fixture-1", "operator stop", ports.RuntimeStopProof{
		ProcessID:          "4242",
		DescendantIDs:      []string{"4243", "4244"},
		DescendantsRunning: 0,
	}); err != nil {
		t.Fatalf("RecordStopped: %v", err)
	}

	records := readTestJournal(t, filepath.Dir(configPath))
	if got := records[len(records)-2]["type"]; got != "worker-stopped" {
		t.Fatalf("penultimate record type = %v, want worker-stopped", got)
	}
	if got := records[len(records)-1]["type"]; got != "descendants-stopped" {
		t.Fatalf("last record type = %v, want descendants-stopped", got)
	}
	descendants := records[len(records)-1]["payload"].(map[string]any)
	if descendants["descendantsRunning"] != float64(0) {
		t.Fatalf("descendantsRunning = %#v, want zero", descendants["descendantsRunning"])
	}
}

func TestObserverSidecarRejectsLifecycleControlMethods(t *testing.T) {
	client, err := Open(context.Background(), writeTestConfig(t), nil)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	for _, method := range []string{"start", "resume", "stop"} {
		t.Run(method, func(t *testing.T) {
			var result json.RawMessage
			err := client.request(context.Background(), method, map[string]any{}, &result)
			if err == nil || !strings.Contains(err.Error(), "is not allowed") {
				t.Fatalf("%s error = %v, want explicit observer-only rejection", method, err)
			}
		})
	}
}

func TestObserverSidecarRejectsDuplicateJournalOwner(t *testing.T) {
	configPath := writeTestConfig(t)
	client, err := Open(context.Background(), configPath, nil)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	duplicate, err := Open(context.Background(), configPath, nil)
	if err == nil {
		_ = duplicate.Close()
		t.Fatal("second Open error = nil, want duplicate runtime owner rejection")
	}
}

func TestObserverSidecarRejectsKernelDigestDrift(t *testing.T) {
	configPath := writeTestConfig(t)
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	config["kernel"].(map[string]any)["sha256"] =
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	raw, err = json.MarshalIndent(config, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	client, err := Open(context.Background(), configPath, nil)
	if err == nil {
		_ = client.Close()
		t.Fatal("Open error = nil, want digest mismatch rejection")
	}
	if !strings.Contains(err.Error(), "kernel digest does not match") {
		t.Fatalf("Open error = %v, want exact digest rejection", err)
	}
}

func writeTestConfig(t *testing.T) string {
	t.Helper()
	nodeBinary, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required for the provider-free observer sidecar test")
	}
	nodeBinary, err = filepath.Abs(nodeBinary)
	if err != nil {
		t.Fatal(err)
	}
	modulePath, err := filepath.Abs(filepath.Join("testdata", "kernel.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	moduleBytes, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	moduleDigest := sha256.Sum256(moduleBytes)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "candidate-run.json")
	config := map[string]any{
		"schemaVersion":    1,
		"nodeBinary":       nodeBinary,
		"journalDirectory": dir,
		"kernel": map[string]any{
			"modulePath": modulePath,
			"sha256":     hex.EncodeToString(moduleDigest[:]),
		},
		"controllerClaim": map[string]any{
			"eventId":   "configure-agent-orchestrator",
			"claimId":   "agent-orchestrator:controller",
			"claimedAt": "2026-07-26T20:00:00.000Z",
		},
		"codex": map[string]any{
			"harness":        "codex",
			"approvalPolicy": "on-request",
		},
		"activationProfile": map[string]any{
			"schemaVersion":    2,
			"candidateSlug":    "agent-orchestrator",
			"candidateVersion": "0.10.3",
			"adapterRevision":  "c89414ddb8cf4dc35e77417907e1ea663b79cf6b",
			"adapterDigest":    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"workerRuntime":    "Codex CLI",
			"modelProvider":    "OpenAI",
			"modelAuthRoute":   "enterprise Codex subscription",
			"authStatus":       "available",
			"authStateScope":   "shared",
			"model":            "gpt-5.6-codex",
			"effort":           "high",
			"sandbox":          "workspace-write",
			"privacyPosture":   "enterprise policy",
			"meteringPosture":  "subscription quota",
			"lastVerifiedAt":   "2026-07-26T20:00:00.000Z",
			"nextAuthAction":   "none",
		},
		"prepared": map[string]any{
			"candidateSlug":      "agent-orchestrator",
			"runId":              "AO-S1-001",
			"scenario":           "S1",
			"repository":         "taymoork2/tenetfold-orchestration-fixture",
			"controllerOwner":    "portfolio-controller",
			"dispatcher":         "agent-orchestrator",
			"candidateRoleClass": "Orchestrator",
			"workspaceAllocator": "agent-orchestrator-worktree",
			"initiationMode":     "automatic",
			"workerLimit":        1,
			"tasks": []map[string]any{{
				"slot":             "A",
				"issueNumber":      21,
				"idempotencyKey":   "agent-orchestrator:AO-S1-001:S1:A",
				"allocationKey":    "agent-orchestrator:AO-S1-001:S1:A",
				"workspaceMode":    "native-after-claim",
				"sourceWriterMode": "agent-orchestrator-session",
				"workspace":        nil,
				"branch":           "fixture/agent-orchestrator/s1",
				"sourceWriter":     nil,
				"authorizedFiles":  []string{"src/work-items.mjs"},
			}},
		},
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return configPath
}

func readTestJournal(t *testing.T, dir string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "fake-runtime-journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var records []map[string]any
	for _, line := range splitNonblankLines(string(raw)) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	return records
}

func splitNonblankLines(value string) []string {
	var lines []string
	for _, line := range strings.Split(value, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
