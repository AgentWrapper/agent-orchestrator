package cloud

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestControlPlaneOrgIsolationThroughExistingAPI(t *testing.T) {
	ctx := context.Background()
	store := openTestPostgresStore(ctx, t)

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
	server := httptest.NewServer(NewHandler(Config{RequestTimeout: time.Second}, store, issuer, nil, cdc.NewBroadcaster()))
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

	if _, err := store.DB().ExecContext(ctx, `DELETE FROM org_members WHERE user_id = $1 AND org_id = $2`, userA.ID, orgA.ID); err != nil {
		t.Fatalf("delete membership: %v", err)
	}
	req, err = http.NewRequest(http.MethodGet, server.URL+"/api/v1/projects", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tokenA.AccessToken)
	req.Header.Set("X-AO-Org-ID", orgA.ID)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("stale membership request status = %d, want 403", resp.StatusCode)
	}

	if _, err := store.EventsAfter(context.Background(), 0, 10); err == nil {
		t.Fatalf("unscoped change_log read succeeded, want fail-closed error")
	}
}

func TestControlPlaneMountsReadOnlyAPISurface(t *testing.T) {
	ctx := context.Background()
	store := openTestPostgresStore(ctx, t)
	user, orgs, err := store.UpsertGoogleUser(ctx, auth.GoogleProfile{Subject: "google-readonly", Email: "readonly@example.com"})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	issuer, err := auth.NewIssuer(auth.IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud"})
	if err != nil {
		t.Fatalf("issuer: %v", err)
	}
	token, err := issuer.Issue(user.ID, []string{orgs[0].ID})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	server := httptest.NewServer(NewHandler(Config{RequestTimeout: time.Second}, store, issuer, nil, cdc.NewBroadcaster()))
	t.Cleanup(server.Close)

	req, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/projects", strings.NewReader(`{"path":"/tmp/cloud"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("X-AO-Org-ID", orgs[0].ID)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusOK {
		t.Fatalf("POST /api/v1/projects status = %d, want non-success", resp.StatusCode)
	}
}

func TestControlPlaneEventsReceivesLivePostgresChange(t *testing.T) {
	ctx := context.Background()
	store := openTestPostgresStore(ctx, t)
	user, orgs, err := store.UpsertGoogleUser(ctx, auth.GoogleProfile{Subject: "google-events", Email: "events@example.com"})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	org := orgs[0]
	issuer, err := auth.NewIssuer(auth.IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud"})
	if err != nil {
		t.Fatalf("issuer: %v", err)
	}
	token, err := issuer.Issue(user.ID, []string{org.ID})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	events := cdc.NewBroadcaster()
	server := httptest.NewServer(NewHandler(Config{RequestTimeout: time.Second}, store, issuer, nil, events))
	t.Cleanup(server.Close)

	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, server.URL+"/api/v1/events?after=0", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("X-AO-Org-ID", org.ID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /events status = %d, want 200", resp.StatusCode)
	}
	waitForSubscriber(t, events)

	projectID := "live-project"
	if err := store.UpsertProject(tenancy.WithScope(ctx, tenancy.Scope{UserID: user.ID, OrgID: org.ID}), domain.ProjectRecord{
		ID:           projectID,
		Path:         "/tmp/live-project",
		DisplayName:  "Live project",
		RegisteredAt: time.Now().UTC(),
		Kind:         domain.ProjectKindSingleRepo,
	}); err != nil {
		t.Fatalf("seed live project: %v", err)
	}
	session, err := store.CreateSession(tenancy.WithScope(ctx, tenancy.Scope{UserID: user.ID, OrgID: org.ID}), domain.SessionRecord{
		ProjectID:   domain.ProjectID(projectID),
		Kind:        domain.KindWorker,
		Harness:     domain.HarnessCodex,
		DisplayName: "Live session",
		Activity: domain.Activity{
			State:          domain.ActivityIdle,
			LastActivityAt: time.Now().UTC(),
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("seed live session: %v", err)
	}
	poller := cdc.NewPoller(store.AdminChangeLogSource(), events, cdc.PollerConfig{})
	if err := poller.Poll(ctx); err != nil {
		t.Fatalf("poll change_log: %v", err)
	}

	if got := readSSEDataLine(t, resp); !strings.Contains(got, string(session.ID)) {
		t.Fatalf("live SSE data = %q, want session id %q", got, session.ID)
	}
}

func TestPostgresRefreshTokenRotationIsAtomic(t *testing.T) {
	ctx := context.Background()
	store := openTestPostgresStore(ctx, t)
	user, _, err := store.UpsertGoogleUser(ctx, auth.GoogleProfile{Subject: "google-refresh", Email: "refresh@example.com"})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	now := time.Now().UTC()
	tokenHash := auth.HashRefreshToken("refresh-token")
	if err := store.StoreRefreshToken(ctx, auth.APIToken{
		ID:        "refresh-token-id",
		UserID:    user.ID,
		TokenHash: tokenHash,
		Kind:      "refresh",
		ExpiresAt: now.Add(time.Hour),
		CreatedAt: now,
	}); err != nil {
		t.Fatalf("store refresh token: %v", err)
	}

	const workers = 16
	start := make(chan struct{})
	var wg sync.WaitGroup
	var successes int32
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, _, ok, err := store.ConsumeRefreshToken(ctx, tokenHash, now.Add(time.Second))
			if err != nil {
				errs <- err
				return
			}
			if ok {
				atomic.AddInt32(&successes, 1)
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("consume refresh token: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful refresh consumptions = %d, want 1", successes)
	}
}

func waitForSubscriber(t *testing.T, events *cdc.Broadcaster) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if events.SubscriberCount() > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for event subscriber")
}

func readSSEDataLine(t *testing.T, resp *http.Response) string {
	t.Helper()
	lines := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data: ") {
				lines <- strings.TrimPrefix(line, "data: ")
				return
			}
		}
		lines <- fmt.Sprintf("scanner ended: %v", scanner.Err())
	}()
	select {
	case line := <-lines:
		return line
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for SSE data")
		return ""
	}
}

func openTestPostgresStore(ctx context.Context, t *testing.T) *postgres.Store {
	t.Helper()
	skipIfDockerUnavailable(t)
	startCtx, cancelStart := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelStart()
	ctr, err := tcpostgres.Run(startCtx,
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
		stopCtx, cancelStop := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelStop()
		if err := ctr.Terminate(stopCtx); err != nil {
			t.Logf("terminate postgres container: %v", err)
		}
	})
	dsn, err := ctr.ConnectionString(startCtx, "sslmode=disable")
	if err != nil {
		t.Fatalf("postgres connection string: %v", err)
	}
	store, err := postgres.Open(dsn)
	if err != nil {
		t.Fatalf("open postgres store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func skipIfDockerUnavailable(t *testing.T) {
	t.Helper()
	network, address, ok := dockerPingTarget()
	if !ok {
		t.Skip("docker host is not a supported unix/tcp endpoint for postgres integration test")
	}
	transport := &http.Transport{
		DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
	}
	if network == "unix" {
		socketPath := address
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, socketPath)
		}
		address = "docker"
	}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + address + "/_ping") //nolint:noctx // client timeout bounds this preflight.
	if err != nil {
		t.Skipf("docker unavailable for postgres integration test: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Skipf("docker unavailable for postgres integration test: ping status %d", resp.StatusCode)
	}
}

func dockerPingTarget() (network, address string, ok bool) {
	host := strings.TrimSpace(os.Getenv("DOCKER_HOST"))
	if host == "" {
		return "unix", "/var/run/docker.sock", true
	}
	u, err := url.Parse(host)
	if err != nil {
		return "", "", false
	}
	switch u.Scheme {
	case "unix":
		return "unix", u.Path, u.Path != ""
	case "tcp", "http":
		return "tcp", u.Host, u.Host != ""
	default:
		return "", "", false
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
