package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestControlPlaneOrgIsolationThroughExistingAPI(t *testing.T) {
	ctx := context.Background()
	ctr, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("ao_cloud_test"),
		tcpostgres.WithUsername("ao"),
		tcpostgres.WithPassword("ao"),
		testcontainers.WithWaitStrategy(wait.ForListeningPort("5432/tcp")),
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "docker") {
			t.Skipf("docker unavailable for postgres integration test: %v", err)
		}
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() {
		if err := ctr.Terminate(context.Background()); err != nil {
			t.Logf("terminate postgres container: %v", err)
		}
	})
	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("postgres connection string: %v", err)
	}
	store, err := postgres.Open(dsn)
	if err != nil {
		t.Fatalf("open postgres store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	userA, orgsA, err := store.UpsertGoogleUser(ctx, auth.GoogleProfile{Subject: "google-a", Email: "a@example.com", DisplayName: "Org A Owner"})
	if err != nil {
		t.Fatalf("create user A: %v", err)
	}
	userB, orgsB, err := store.UpsertGoogleUser(ctx, auth.GoogleProfile{Subject: "google-b", Email: "b@example.com", DisplayName: "Org B Owner"})
	if err != nil {
		t.Fatalf("create user B: %v", err)
	}
	orgA, orgB := orgsA[0], orgsB[0]
	now := time.Now().UTC()
	ctxA := tenancy.WithScope(ctx, tenancy.Scope{UserID: userA.ID, OrgID: orgA.ID})
	ctxB := tenancy.WithScope(ctx, tenancy.Scope{UserID: userB.ID, OrgID: orgB.ID})
	seedProjectAndSession(ctxA, t, store, "A project", "A session", now)
	seedProjectAndSession(ctxB, t, store, "B project", "B session", now)

	issuer, err := auth.NewIssuer(auth.IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud"})
	if err != nil {
		t.Fatalf("issuer: %v", err)
	}
	tokenA, err := issuer.Issue(userA.ID, []string{orgA.ID})
	if err != nil {
		t.Fatalf("issue token A: %v", err)
	}
	tokenB, err := issuer.Issue(userB.ID, []string{orgB.ID})
	if err != nil {
		t.Fatalf("issue token B: %v", err)
	}
	server := httptest.NewServer(NewHandler(Config{RequestTimeout: time.Second}, store, issuer))
	t.Cleanup(server.Close)

	assertProjectNames(t, server.URL, tokenA.AccessToken, orgA.ID, []string{"A project"})
	assertProjectNames(t, server.URL, tokenB.AccessToken, orgB.ID, []string{"B project"})
	assertSessionNames(t, server.URL, tokenA.AccessToken, orgA.ID, []string{"A session"})
	assertSessionNames(t, server.URL, tokenB.AccessToken, orgB.ID, []string{"B session"})

	req, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/projects", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tokenA.AccessToken)
	req.Header.Set("X-AO-Org-ID", orgB.ID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-org request status = %d, want 403", resp.StatusCode)
	}
}

func seedProjectAndSession(ctx context.Context, t *testing.T, store *postgres.Store, projectName, sessionName string, now time.Time) {
	t.Helper()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{
		ID:           "shared",
		Path:         "/tmp/" + strings.ReplaceAll(strings.ToLower(projectName), " ", "-"),
		DisplayName:  projectName,
		RegisteredAt: now,
		Kind:         domain.ProjectKindSingleRepo,
	}); err != nil {
		t.Fatalf("seed project %q: %v", projectName, err)
	}
	if _, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID:   "shared",
		Kind:        domain.KindWorker,
		Harness:     domain.HarnessCodex,
		DisplayName: sessionName,
		Activity: domain.Activity{
			State:          domain.ActivityIdle,
			LastActivityAt: now,
		},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed session %q: %v", sessionName, err)
	}
}

func assertProjectNames(t *testing.T, baseURL, token, orgID string, want []string) {
	t.Helper()
	var body struct {
		Projects []struct {
			Name string `json:"name"`
		} `json:"projects"`
	}
	getJSON(t, baseURL+"/api/v1/projects", token, orgID, &body)
	got := make([]string, 0, len(body.Projects))
	for _, project := range body.Projects {
		got = append(got, project.Name)
	}
	assertStrings(t, got, want)
}

func assertSessionNames(t *testing.T, baseURL, token, orgID string, want []string) {
	t.Helper()
	var body struct {
		Sessions []struct {
			DisplayName string `json:"displayName"`
		} `json:"sessions"`
	}
	getJSON(t, baseURL+"/api/v1/sessions", token, orgID, &body)
	got := make([]string, 0, len(body.Sessions))
	for _, session := range body.Sessions {
		got = append(got, session.DisplayName)
	}
	assertStrings(t, got, want)
}

func getJSON(t *testing.T, url, token, orgID string, out any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-AO-Org-ID", orgID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status = %d, want 200", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func assertStrings(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
