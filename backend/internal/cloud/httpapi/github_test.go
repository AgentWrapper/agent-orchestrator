package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
)

func TestGitHubInstallStateRejectsTamperingAndExpiry(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state := githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	}
	encoded, err := signGitHubInstallState(secret, state)
	if err != nil {
		t.Fatalf("signGitHubInstallState() error = %v", err)
	}
	verified, err := verifyGitHubInstallState(secret, encoded, now)
	if err != nil {
		t.Fatalf("verifyGitHubInstallState() error = %v", err)
	}
	if verified.OrgID != state.OrgID || verified.UserID != state.UserID || verified.Nonce != state.Nonce {
		t.Fatalf("verified state = %#v", verified)
	}

	parts := strings.Split(encoded, ".")
	parts[0] = parts[0][:len(parts[0])-1] + differentBase64Byte(parts[0][len(parts[0])-1])
	if _, err := verifyGitHubInstallState(secret, strings.Join(parts, "."), now); !errors.Is(err, errInvalidGitHubInstallState) {
		t.Fatalf("tampered state error = %v, want errInvalidGitHubInstallState", err)
	}
	if _, err := verifyGitHubInstallState(secret, encoded, now.Add(githubInstallStateTTL)); !errors.Is(err, errInvalidGitHubInstallState) {
		t.Fatalf("expired state error = %v, want errInvalidGitHubInstallState", err)
	}
}

func TestConfirmGitHubInstallRejectsWrongUserOrOrganizationBeforeAtomicConfirm(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state, err := signGitHubInstallState(secret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		orgID  clouddomain.OrgID
		userID string
	}{
		{name: "wrong user", orgID: "org-1", userID: "user-2"},
		{name: "wrong organization", orgID: "org-2", userID: "user-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeGitHubStore{}
			client := &fakeGitHubAppClient{}
			server := newGitHubTestServer(store, client, now, secret, []byte("independent-webhook-secret-at-least-32"))
			body, _ := json.Marshal(map[string]any{"state": state})
			request := httptest.NewRequest(http.MethodPost, "/github/install/confirm", bytes.NewReader(body))
			request = request.WithContext(context.WithValue(request.Context(), orgContextKey{}, clouddomain.UserOrganization{
				Organization: clouddomain.Organization{ID: test.orgID},
				Membership:   clouddomain.OrgMembership{Role: "admin"},
			}))
			request = request.WithContext(cloudauth.ContextWithPrincipal(request.Context(), cloudauth.Principal{UserID: test.userID}))
			response := httptest.NewRecorder()

			server.confirmGitHubInstall(response, request)

			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusForbidden, response.Body.String())
			}
			if store.confirmCalls != 0 {
				t.Fatalf("confirm calls = %d, want 0", store.confirmCalls)
			}
			if client.getCalls != 0 {
				t.Fatalf("GitHub lookup calls = %d, want 0", client.getCalls)
			}
		})
	}
}

func TestGitHubInstallCallbackRedirectsOnlyToFixedWebRoute(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state, err := signGitHubInstallState(secret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeGitHubStore{}
	client := &fakeGitHubAppClient{installation: cloudgithubapp.Installation{
		ID:                  99,
		AppID:               123,
		ClientID:            "client-id",
		Account:             cloudgithubapp.Account{ID: 7, Login: "aoagents", Type: "Organization"},
		RepositorySelection: "selected",
	}}
	server := newGitHubTestServer(
		store,
		client,
		now,
		secret,
		[]byte("independent-webhook-secret-at-least-32"),
	)
	server.webOrigin = "https://ao.example/untrusted-base?old=value#fragment"
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/github/install/callback?state="+url.QueryEscape(state)+"&installation_id=99&returnTo=https://evil.example",
		nil,
	)
	response := httptest.NewRecorder()

	server.githubInstallCallback(response, request)

	if response.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusFound, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := response.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Scheme != "https" || location.Host != "ao.example" || location.Path != "/app/github/callback" {
		t.Fatalf("redirect location = %q", location.String())
	}
	if location.Query().Get("state") != state ||
		location.Query().Has("installationId") ||
		location.Query().Has("installation_id") ||
		location.Query().Has("returnTo") ||
		location.Query().Has("old") ||
		location.Fragment != "" {
		t.Fatalf("redirect query = %q, fragment = %q", location.RawQuery, location.Fragment)
	}
	if store.recordPendingCalls != 1 {
		t.Fatalf("pending record calls = %d, want 1", store.recordPendingCalls)
	}
}

func TestGitHubInstallCallbackIsIdempotentAndFirstInstallationWins(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state, err := signGitHubInstallState(secret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeGitHubStore{}
	client := &fakeGitHubAppClient{
		installation: cloudgithubapp.Installation{
			ID:                  99,
			AppID:               123,
			ClientID:            "client-id",
			Account:             cloudgithubapp.Account{ID: 7, Login: "aoagents", Type: "Organization"},
			RepositorySelection: "selected",
		},
	}
	server := newGitHubTestServer(store, client, now, secret, []byte("independent-webhook-secret-at-least-32"))
	server.webOrigin = "https://ao.example"
	callback := func(installationID string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(
			http.MethodGet,
			"/api/cloud/v1/github/install/callback?state="+url.QueryEscape(state)+"&installation_id="+installationID,
			nil,
		)
		response := httptest.NewRecorder()
		server.githubInstallCallback(response, request)
		return response
	}

	if response := callback("99"); response.Code != http.StatusFound {
		t.Fatalf("first callback = %d: %s", response.Code, response.Body.String())
	}
	if response := callback("99"); response.Code != http.StatusFound {
		t.Fatalf("idempotent callback = %d: %s", response.Code, response.Body.String())
	}
	client.installation.ID = 100
	if response := callback("100"); response.Code != http.StatusConflict {
		t.Fatalf("different installation callback = %d, want %d: %s", response.Code, http.StatusConflict, response.Body.String())
	}
	if store.pendingAttempt.PendingGitHubInstallationID == nil ||
		*store.pendingAttempt.PendingGitHubInstallationID != 99 {
		t.Fatalf("pending installation = %#v, want 99", store.pendingAttempt.PendingGitHubInstallationID)
	}
}

func TestPendingAndConfirmGitHubInstallUseOnlyServerRecordedInstallation(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state, err := signGitHubInstallState(secret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeGitHubStore{
		pendingAttempt: pendingAttemptFromInput(cloudpostgres.GitHubPendingInstallationInput{
			InstallationID:      99,
			AccountID:           7,
			AccountLogin:        "aoagents",
			AccountType:         "Organization",
			RepositorySelection: "selected",
			RepositoryCount:     1,
		}),
	}
	client := &fakeGitHubAppClient{
		installation: cloudgithubapp.Installation{
			ID:                  99,
			AppID:               123,
			ClientID:            "client-id",
			Account:             cloudgithubapp.Account{ID: 7, Login: "aoagents", Type: "Organization"},
			RepositorySelection: "selected",
			Permissions:         map[string]string{"metadata": "read"},
		},
		repositories: []cloudgithubapp.Repository{{
			ID:            84,
			Owner:         cloudgithubapp.Account{ID: 7},
			Name:          "agent-orchestrator",
			FullName:      "aoagents/agent-orchestrator",
			HTMLURL:       "https://github.com/aoagents/agent-orchestrator",
			CloneURL:      "https://github.com/aoagents/agent-orchestrator.git",
			DefaultBranch: "main",
		}},
	}
	server := newGitHubTestServer(store, client, now, secret, []byte("independent-webhook-secret-at-least-32"))
	body, _ := json.Marshal(map[string]string{"state": state})

	pendingRequest := githubAdminRequest(http.MethodPost, "/github/install/pending", body, "org-1", "user-1")
	pendingResponse := httptest.NewRecorder()
	server.pendingGitHubInstall(pendingResponse, pendingRequest)
	if pendingResponse.Code != http.StatusOK ||
		!strings.Contains(pendingResponse.Body.String(), `"accountLogin":"aoagents"`) ||
		!strings.Contains(pendingResponse.Body.String(), `"repositoryCount":1`) {
		t.Fatalf("pending response = %d: %s", pendingResponse.Code, pendingResponse.Body.String())
	}
	if pendingResponse.Header().Get("Cache-Control") != "no-store" ||
		pendingResponse.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("pending privacy headers = %#v", pendingResponse.Header())
	}

	extraBody, _ := json.Marshal(map[string]any{"state": state, "installationId": 100})
	extraRequest := githubAdminRequest(http.MethodPost, "/github/install/confirm", extraBody, "org-1", "user-1")
	extraResponse := httptest.NewRecorder()
	server.confirmGitHubInstall(extraResponse, extraRequest)
	if extraResponse.Code != http.StatusBadRequest || store.confirmCalls != 0 || client.getCalls != 0 {
		t.Fatalf("extra installation ID response = %d, confirm=%d get=%d", extraResponse.Code, store.confirmCalls, client.getCalls)
	}

	confirmRequest := githubAdminRequest(http.MethodPost, "/github/install/confirm", body, "org-1", "user-1")
	confirmResponse := httptest.NewRecorder()
	server.confirmGitHubInstall(confirmResponse, confirmRequest)
	if confirmResponse.Code != http.StatusOK {
		t.Fatalf("confirm response = %d: %s", confirmResponse.Code, confirmResponse.Body.String())
	}
	if store.confirmCalls != 1 || store.bindCalls != 1 || store.fullSyncCalls != 1 ||
		client.installation.ID != 99 {
		t.Fatalf(
			"confirm calls = atomic %d bind %d sync %d installation %d",
			store.confirmCalls,
			store.bindCalls,
			store.fullSyncCalls,
			client.installation.ID,
		)
	}

	replayRequest := githubAdminRequest(http.MethodPost, "/github/install/confirm", body, "org-1", "user-1")
	replayResponse := httptest.NewRecorder()
	server.confirmGitHubInstall(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusConflict || store.confirmCalls != 1 || store.bindCalls != 1 {
		t.Fatalf("replay response = %d, confirm=%d bind=%d", replayResponse.Code, store.confirmCalls, store.bindCalls)
	}
}

func TestPendingGitHubInstallRejectsWrongUserOrOrganization(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state, err := signGitHubInstallState(secret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"state": state})
	for _, test := range []struct {
		name, orgID, userID string
	}{
		{name: "wrong user", orgID: "org-1", userID: "user-2"},
		{name: "wrong organization", orgID: "org-2", userID: "user-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeGitHubStore{}
			server := newGitHubTestServer(store, &fakeGitHubAppClient{}, now, secret, []byte("independent-webhook-secret-at-least-32"))
			request := githubAdminRequest(http.MethodPost, "/github/install/pending", body, test.orgID, test.userID)
			response := httptest.NewRecorder()
			server.pendingGitHubInstall(response, request)
			if response.Code != http.StatusForbidden || store.getPendingCalls != 0 {
				t.Fatalf("response = %d, pending calls = %d", response.Code, store.getPendingCalls)
			}
		})
	}
}

func TestCreateGitHubInstallReturnsSignedGitHubURL(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	store := &fakeGitHubStore{}
	server := newGitHubTestServer(
		store,
		&fakeGitHubAppClient{},
		now,
		secret,
		[]byte("independent-webhook-secret-at-least-32"),
	)
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/orgs/org-1/github/install", nil)
	request = request.WithContext(context.WithValue(request.Context(), orgContextKey{}, clouddomain.UserOrganization{
		Organization: clouddomain.Organization{ID: "org-1"},
		Membership:   clouddomain.OrgMembership{Role: "admin"},
	}))
	request = request.WithContext(cloudauth.ContextWithPrincipal(request.Context(), cloudauth.Principal{UserID: "user-1"}))
	response := httptest.NewRecorder()

	server.createGitHubInstall(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var output struct {
		InstallURL string `json:"installUrl"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	installURL, err := url.Parse(output.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	if installURL.Scheme != "https" ||
		installURL.Host != "github.com" ||
		installURL.Path != "/apps/ao-cloud/installations/new" {
		t.Fatalf("install URL = %q", output.InstallURL)
	}
	claims, err := verifyGitHubInstallState(secret, installURL.Query().Get("state"), now)
	if err != nil {
		t.Fatalf("verify install state: %v", err)
	}
	if claims.Nonce != "nonce" || claims.OrgID != "org-1" || claims.UserID != "user-1" {
		t.Fatalf("install claims = %#v", claims)
	}
	if store.createOrgID != "org-1" || store.createUserID != "user-1" || store.createTTL != githubInstallStateTTL {
		t.Fatalf(
			"create attempt = org %q user %q ttl %s",
			store.createOrgID,
			store.createUserID,
			store.createTTL,
		)
	}
}

func TestListRepositoriesFlattensActiveGitHubGrantsForProjectPicker(t *testing.T) {
	t.Parallel()
	store := &fakeGitHubStore{
		repositories: []clouddomain.GitHubGrantedRepository{{
			Repository: clouddomain.GitHubRepository{
				ID:            991,
				FullName:      "aoagents/agent-orchestrator",
				HTMLURL:       "https://github.com/aoagents/agent-orchestrator",
				DefaultBranch: "main",
				Private:       true,
			},
		}},
	}
	server := newGitHubTestServer(
		store,
		&fakeGitHubAppClient{},
		time.Now(),
		[]byte("independent-state-secret-at-least-32-bytes"),
		[]byte("independent-webhook-secret-at-least-32"),
	)
	request := httptest.NewRequest(http.MethodGet, "/api/cloud/v1/orgs/org-1/repositories", nil)
	request = request.WithContext(context.WithValue(request.Context(), orgContextKey{}, clouddomain.UserOrganization{
		Organization: clouddomain.Organization{ID: "org-1"},
	}))
	response := httptest.NewRecorder()

	server.listRepositories(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var output struct {
		Repositories []struct {
			ID            int64  `json:"id"`
			FullName      string `json:"fullName"`
			URL           string `json:"url"`
			DefaultBranch string `json:"defaultBranch"`
			Private       bool   `json:"private"`
		} `json:"repositories"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Repositories) != 1 ||
		output.Repositories[0].ID != 991 ||
		output.Repositories[0].FullName != "aoagents/agent-orchestrator" ||
		output.Repositories[0].URL != "https://github.com/aoagents/agent-orchestrator" ||
		output.Repositories[0].DefaultBranch != "main" ||
		!output.Repositories[0].Private {
		t.Fatalf("repositories = %#v", output.Repositories)
	}
}

func TestGitHubInstallRouteRequiresCurrentAdminRole(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		role       string
		wantStatus int
	}{
		{role: "admin", wantStatus: http.StatusOK},
		{role: "member", wantStatus: http.StatusForbidden},
		{role: "viewer", wantStatus: http.StatusForbidden},
	} {
		t.Run(test.role, func(t *testing.T) {
			githubStore := &fakeGitHubStore{}
			server := newGitHubTestServer(
				githubStore,
				&fakeGitHubAppClient{},
				now,
				[]byte("independent-state-secret-at-least-32-bytes"),
				[]byte("independent-webhook-secret-at-least-32"),
			)
			server.store = &githubRouteStore{role: test.role}
			server.auth = githubTestAuthenticator{}
			server.log = slog.Default()
			handler := server.routes()
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/cloud/v1/orgs/org-1/github/install",
				nil,
			)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
			wantCreateCalls := 0
			if test.wantStatus == http.StatusOK {
				wantCreateCalls = 1
			}
			if githubStore.createCalls != wantCreateCalls {
				t.Fatalf("create calls = %d, want %d", githubStore.createCalls, wantCreateCalls)
			}
		})
	}
}

func TestGitHubPendingInstallRouteRequiresCurrentAdminRole(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	secret := []byte("independent-state-secret-at-least-32-bytes")
	state, err := signGitHubInstallState(secret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     "nonce",
		OrgID:     "org-1",
		UserID:    "user-1",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"state": state})
	for _, test := range []struct {
		role       string
		wantStatus int
	}{
		{role: "admin", wantStatus: http.StatusOK},
		{role: "member", wantStatus: http.StatusForbidden},
	} {
		t.Run(test.role, func(t *testing.T) {
			githubStore := &fakeGitHubStore{
				pendingAttempt: pendingAttemptFromInput(cloudpostgres.GitHubPendingInstallationInput{
					InstallationID:      99,
					AccountID:           7,
					AccountLogin:        "aoagents",
					AccountType:         "Organization",
					RepositorySelection: "selected",
					RepositoryCount:     1,
				}),
			}
			server := newGitHubTestServer(
				githubStore,
				&fakeGitHubAppClient{},
				now,
				secret,
				[]byte("independent-webhook-secret-at-least-32"),
			)
			server.store = &githubRouteStore{role: test.role}
			server.auth = githubTestAuthenticator{}
			server.log = slog.Default()
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/cloud/v1/orgs/org-1/github/install/pending",
				bytes.NewReader(body),
			)
			response := httptest.NewRecorder()

			server.routes().ServeHTTP(response, request)

			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
			wantPendingCalls := 0
			if test.wantStatus == http.StatusOK {
				wantPendingCalls = 1
			}
			if githubStore.getPendingCalls != wantPendingCalls {
				t.Fatalf("pending calls = %d, want %d", githubStore.getPendingCalls, wantPendingCalls)
			}
		})
	}
}

func TestGitHubWebhookSignatureDedupeReplayAndAllowlist(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	stateSecret := []byte("independent-state-secret-at-least-32-bytes")
	webhookSecret := []byte("independent-webhook-secret-at-least-32")
	store := &fakeGitHubStore{deliveries: make(map[string]cloudpostgres.GitHubWebhookDeliveryInput)}
	server := newGitHubTestServer(store, &fakeGitHubAppClient{}, now, stateSecret, webhookSecret)
	deliveryID := "632d8f96-d393-11f0-9f72-0242ac120002"
	payload := []byte(`{"action":"suspend","installation":{"id":42},"repository":{"id":84}}`)

	first := signedWebhookRequest(deliveryID, "installation", payload, webhookSecret)
	response := httptest.NewRecorder()
	server.githubWebhook(response, first)
	if response.Code != http.StatusAccepted {
		t.Fatalf("first status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
	if store.lastDelivery.InstallationID == nil || *store.lastDelivery.InstallationID != 42 ||
		store.lastDelivery.RepositoryID == nil || *store.lastDelivery.RepositoryID != 84 ||
		store.lastDelivery.Action != "suspend" {
		t.Fatalf("stored delivery = %#v", store.lastDelivery)
	}

	duplicate := signedWebhookRequest(deliveryID, "installation", payload, webhookSecret)
	response = httptest.NewRecorder()
	server.githubWebhook(response, duplicate)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"duplicate":true`) {
		t.Fatalf("duplicate response = %d %s", response.Code, response.Body.String())
	}

	changed := []byte(`{"action":"unsuspend","installation":{"id":42}}`)
	replay := signedWebhookRequest(deliveryID, "installation", changed, webhookSecret)
	response = httptest.NewRecorder()
	server.githubWebhook(response, replay)
	if response.Code != http.StatusConflict {
		t.Fatalf("replay status = %d, want %d: %s", response.Code, http.StatusConflict, response.Body.String())
	}

	badSignature := signedWebhookRequest(
		"732d8f96-d393-11f0-9f72-0242ac120002",
		"installation",
		payload,
		[]byte("wrong-webhook-secret-at-least-32-bytes"),
	)
	response = httptest.NewRecorder()
	server.githubWebhook(response, badSignature)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("signature status = %d, want %d", response.Code, http.StatusUnauthorized)
	}

	targetedEvents := []struct {
		event      string
		deliveryID string
	}{
		{event: "pull_request", deliveryID: "912d8f96-d393-11f0-9f72-0242ac120002"},
		{event: "pull_request_review", deliveryID: "922d8f96-d393-11f0-9f72-0242ac120002"},
		{event: "pull_request_review_thread", deliveryID: "932d8f96-d393-11f0-9f72-0242ac120002"},
		{event: "check_run", deliveryID: "942d8f96-d393-11f0-9f72-0242ac120002"},
		{event: "check_suite", deliveryID: "952d8f96-d393-11f0-9f72-0242ac120002"},
		{event: "status", deliveryID: "962d8f96-d393-11f0-9f72-0242ac120002"},
	}
	for _, targeted := range targetedEvents {
		request := signedWebhookRequest(targeted.deliveryID, targeted.event, payload, webhookSecret)
		response = httptest.NewRecorder()
		server.githubWebhook(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d, want %d: %s", targeted.event, response.Code, http.StatusAccepted, response.Body.String())
		}
		if stored := store.deliveries[targeted.deliveryID]; stored.Event != targeted.event {
			t.Fatalf("%s durable delivery = %#v", targeted.event, stored)
		}
	}

	unsupported := signedWebhookRequest(
		"832d8f96-d393-11f0-9f72-0242ac120002",
		"push",
		payload,
		webhookSecret,
	)
	response = httptest.NewRecorder()
	server.githubWebhook(response, unsupported)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("allowlist status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func TestGitHubWebhookBackoffIsBounded(t *testing.T) {
	t.Parallel()
	if got := githubWebhookBackoff(1); got != 5*time.Second {
		t.Fatalf("first backoff = %s", got)
	}
	if got := githubWebhookBackoff(100); got != maxGitHubWebhookBackoff {
		t.Fatalf("bounded backoff = %s, want %s", got, maxGitHubWebhookBackoff)
	}
}

func TestGitHubWebhookProcessorAppliesLifecycleAndCanonicalResync(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	binding := clouddomain.GitHubInstallation{
		OrgID:                "org-1",
		GitHubInstallationID: 42,
		Status:               "active",
		InstalledByUserID:    "user-1",
	}
	store := &fakeGitHubStore{binding: &binding}
	suspendedAt := now
	client := &fakeGitHubAppClient{
		installation: cloudgithubapp.Installation{
			ID:                  42,
			AppID:               123,
			ClientID:            "client-id",
			Account:             cloudgithubapp.Account{ID: 7, Login: "aoagents", Type: "Organization"},
			RepositorySelection: "selected",
			Permissions:         map[string]string{"metadata": "read"},
			Events:              []string{"installation_repositories"},
			SuspendedAt:         &suspendedAt,
		},
		repositories: []cloudgithubapp.Repository{{
			ID:            84,
			Owner:         cloudgithubapp.Account{ID: 7},
			Name:          "agent-orchestrator",
			FullName:      "aoagents/agent-orchestrator",
			HTMLURL:       "https://github.com/aoagents/agent-orchestrator",
			CloneURL:      "https://github.com/aoagents/agent-orchestrator.git",
			DefaultBranch: "main",
		}},
	}
	server := newGitHubTestServer(
		store,
		client,
		now,
		[]byte("independent-state-secret-at-least-32-bytes"),
		[]byte("independent-webhook-secret-at-least-32"),
	)
	installationID := int64(42)

	err := server.processGitHubWebhookDelivery(context.Background(), clouddomain.GitHubWebhookDelivery{
		Event:          "installation",
		Action:         "suspend",
		InstallationID: &installationID,
	})
	if err != nil {
		t.Fatalf("process suspend: %v", err)
	}
	if client.getCalls != 1 || store.bindCalls != 1 || store.fullSyncCalls != 0 {
		t.Fatalf(
			"suspend canonical sync calls: get=%d bind=%d fullSync=%d",
			client.getCalls,
			store.bindCalls,
			store.fullSyncCalls,
		)
	}

	client.installation.SuspendedAt = nil
	err = server.processGitHubWebhookDelivery(context.Background(), clouddomain.GitHubWebhookDelivery{
		Event:          "installation_repositories",
		Action:         "added",
		InstallationID: &installationID,
	})
	if err != nil {
		t.Fatalf("process repository change: %v", err)
	}
	if client.getCalls != 2 || store.bindCalls != 2 || store.fullSyncCalls != 1 {
		t.Fatalf(
			"canonical resync calls: get=%d bind=%d fullSync=%d",
			client.getCalls,
			store.bindCalls,
			store.fullSyncCalls,
		)
	}
	if len(store.syncedRepositories) != 1 || store.syncedRepositories[0].ID != 84 {
		t.Fatalf("synced repositories = %#v", store.syncedRepositories)
	}
}

func TestGitHubSyncMarksMissingInstallationDeletedAndContinues(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	store := &fakeGitHubStore{
		installations: []clouddomain.GitHubInstallation{
			{OrgID: "org-1", GitHubInstallationID: 41, Status: "active", InstalledByUserID: "user-1"},
			{OrgID: "org-1", GitHubInstallationID: 42, Status: "active", InstalledByUserID: "user-1"},
		},
	}
	client := &fakeGitHubAppClient{
		installations: map[int64]cloudgithubapp.Installation{
			42: {
				ID:                  42,
				AppID:               123,
				ClientID:            "client-id",
				Account:             cloudgithubapp.Account{ID: 7, Login: "aoagents", Type: "Organization"},
				RepositorySelection: "selected",
				Permissions:         map[string]string{"metadata": "read"},
			},
		},
		getErrors: map[int64]error{
			41: &cloudgithubapp.APIError{StatusCode: http.StatusNotFound, Status: "404 Not Found"},
		},
		repositoriesByInstallation: map[int64][]cloudgithubapp.Repository{42: {}},
	}
	server := newGitHubTestServer(
		store,
		client,
		now,
		[]byte("independent-state-secret-at-least-32-bytes"),
		[]byte("independent-webhook-secret-at-least-32"),
	)
	request := githubAdminRequest(http.MethodPost, "/github/sync", nil, "org-1", "user-1")
	response := httptest.NewRecorder()

	server.syncGitHub(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("sync response = %d: %s", response.Code, response.Body.String())
	}
	if client.getCalls != 2 || store.bindCalls != 1 || len(store.statusUpdates) != 1 ||
		store.statusInstallations[0] != 41 || store.statusUpdates[0].Status != "deleted" {
		t.Fatalf(
			"sync cleanup = get %d bind %d status IDs %#v updates %#v",
			client.getCalls,
			store.bindCalls,
			store.statusInstallations,
			store.statusUpdates,
		)
	}
}

func TestGitHubWebhookResyncClassifiesOnlyAPINotFoundAsDeleted(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	binding := clouddomain.GitHubInstallation{
		OrgID:                "org-1",
		GitHubInstallationID: 42,
		Status:               "active",
		InstalledByUserID:    "user-1",
	}
	for _, test := range []struct {
		name        string
		getErr      error
		listErr     error
		wantErr     bool
		wantDeleted bool
	}{
		{
			name:        "not found",
			getErr:      &cloudgithubapp.APIError{StatusCode: http.StatusNotFound, Status: "404 Not Found"},
			wantDeleted: true,
		},
		{
			name:        "not found while listing repositories",
			listErr:     &cloudgithubapp.APIError{StatusCode: http.StatusNotFound, Status: "404 Not Found"},
			wantDeleted: true,
		},
		{
			name:    "server failure",
			getErr:  &cloudgithubapp.APIError{StatusCode: http.StatusInternalServerError, Status: "500 Internal Server Error"},
			wantErr: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeGitHubStore{binding: &binding}
			client := &fakeGitHubAppClient{
				installation: cloudgithubapp.Installation{
					ID:                  42,
					AppID:               123,
					ClientID:            "client-id",
					Account:             cloudgithubapp.Account{ID: 7, Login: "aoagents", Type: "Organization"},
					RepositorySelection: "selected",
				},
				getErr:  test.getErr,
				listErr: test.listErr,
			}
			server := newGitHubTestServer(
				store,
				client,
				now,
				[]byte("independent-state-secret-at-least-32-bytes"),
				[]byte("independent-webhook-secret-at-least-32"),
			)
			err := server.resyncGitHubBinding(context.Background(), binding)
			if (err != nil) != test.wantErr {
				t.Fatalf("resync error = %v, want error %v", err, test.wantErr)
			}
			if got := len(store.statusUpdates) == 1 && store.statusUpdates[0].Status == "deleted"; got != test.wantDeleted {
				t.Fatalf("deleted update = %v, want %v: %#v", got, test.wantDeleted, store.statusUpdates)
			}
		})
	}
}

func TestGitHubWebhookProcessorRefreshesTargetedRepositoryEvents(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	binding := clouddomain.GitHubInstallation{
		OrgID:                "org-1",
		GitHubInstallationID: 42,
		Status:               "active",
	}
	grant := clouddomain.GitHubRepositoryGrant{
		OrgID:                "org-1",
		GitHubInstallationID: 42,
		GitHubRepositoryID:   84,
	}
	store := &fakeGitHubStore{binding: &binding, activeGrant: &grant}
	server := newGitHubTestServer(
		store,
		&fakeGitHubAppClient{},
		now,
		[]byte("independent-state-secret-at-least-32-bytes"),
		[]byte("independent-webhook-secret-at-least-32"),
	)
	refreshes := 0
	server.githubApp.repositoryRefresh = func(
		_ context.Context,
		orgID clouddomain.OrgID,
		repositoryID int64,
	) error {
		refreshes++
		if orgID != "org-1" || repositoryID != 84 {
			t.Fatalf("refresh scope = %q/%d", orgID, repositoryID)
		}
		return nil
	}
	installationID := int64(42)
	repositoryID := int64(84)
	events := []string{
		"pull_request",
		"pull_request_review",
		"pull_request_review_thread",
		"check_run",
		"check_suite",
		"status",
	}
	for _, event := range events {
		err := server.processGitHubWebhookDelivery(context.Background(), clouddomain.GitHubWebhookDelivery{
			Event:          event,
			InstallationID: &installationID,
			RepositoryID:   &repositoryID,
		})
		if err != nil {
			t.Fatalf("process %s: %v", event, err)
		}
	}
	if refreshes != len(events) {
		t.Fatalf("repository refreshes = %d, want %d", refreshes, len(events))
	}

	store.activeGrant = nil
	err := server.processGitHubWebhookDelivery(context.Background(), clouddomain.GitHubWebhookDelivery{
		Event:          "status",
		InstallationID: &installationID,
		RepositoryID:   &repositoryID,
	})
	if err != nil {
		t.Fatalf("process inactive repository status: %v", err)
	}
	if refreshes != len(events) {
		t.Fatalf("inactive repository triggered refresh: %d", refreshes)
	}
}

func newGitHubTestServer(
	store githubStore,
	client GitHubAppClient,
	now time.Time,
	stateSecret, webhookSecret []byte,
) *Server {
	return &Server{
		githubStore: store,
		githubApp: &githubAppRuntime{
			mode:              "github-app",
			appID:             123,
			clientID:          "client-id",
			appSlug:           "ao-cloud",
			stateSecret:       stateSecret,
			webhookSecret:     webhookSecret,
			client:            client,
			now:               func() time.Time { return now },
			processorInterval: time.Millisecond,
		},
	}
}

func signedWebhookRequest(deliveryID, event string, payload, secret []byte) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhooks", bytes.NewReader(payload))
	request.Header.Set("X-GitHub-Delivery", deliveryID)
	request.Header.Set("X-GitHub-Event", event)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	return request
}

func githubAdminRequest(method, target string, body []byte, orgID, userID string) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), orgContextKey{}, clouddomain.UserOrganization{
		Organization: clouddomain.Organization{ID: clouddomain.OrgID(orgID)},
		Membership:   clouddomain.OrgMembership{Role: "admin"},
	}))
	return request.WithContext(cloudauth.ContextWithPrincipal(request.Context(), cloudauth.Principal{UserID: userID}))
}

func differentBase64Byte(value byte) string {
	if value == 'A' {
		return "B"
	}
	return "A"
}

type fakeGitHubAppClient struct {
	installation               cloudgithubapp.Installation
	repositories               []cloudgithubapp.Repository
	installations              map[int64]cloudgithubapp.Installation
	repositoriesByInstallation map[int64][]cloudgithubapp.Repository
	getErrors                  map[int64]error
	listErrors                 map[int64]error
	getErr                     error
	listErr                    error
	getCalls                   int
	listCalls                  int
}

func (c *fakeGitHubAppClient) GetInstallation(_ context.Context, installationID int64) (cloudgithubapp.Installation, error) {
	c.getCalls++
	if err := c.getErrors[installationID]; err != nil {
		return cloudgithubapp.Installation{}, err
	}
	if installation, ok := c.installations[installationID]; ok {
		return installation, nil
	}
	return c.installation, c.getErr
}

func (c *fakeGitHubAppClient) ListInstallationRepositories(_ context.Context, installationID int64) ([]cloudgithubapp.Repository, error) {
	c.listCalls++
	if err := c.listErrors[installationID]; err != nil {
		return nil, err
	}
	if repositories, ok := c.repositoriesByInstallation[installationID]; ok {
		return repositories, nil
	}
	return c.repositories, c.listErr
}

type fakeGitHubStore struct {
	createCalls         int
	recordPendingCalls  int
	getPendingCalls     int
	confirmCalls        int
	createOrgID         clouddomain.OrgID
	createUserID        clouddomain.UserID
	createTTL           time.Duration
	deliveries          map[string]cloudpostgres.GitHubWebhookDeliveryInput
	lastDelivery        cloudpostgres.GitHubWebhookDeliveryInput
	binding             *clouddomain.GitHubInstallation
	activeGrant         *clouddomain.GitHubRepositoryGrant
	activeGrantErr      error
	statusUpdates       []cloudpostgres.GitHubInstallationStatusUpdate
	statusInstallations []int64
	bindCalls           int
	fullSyncCalls       int
	syncedRepositories  []clouddomain.GitHubRepository
	repositories        []clouddomain.GitHubGrantedRepository
	pendingAttempt      clouddomain.GitHubInstallAttempt
	recordPendingErr    error
	getPendingErr       error
	confirmErr          error
	consumed            bool
	installations       []clouddomain.GitHubInstallation
}

func (s *fakeGitHubStore) CreateGitHubInstallAttempt(_ context.Context, orgID clouddomain.OrgID, userID clouddomain.UserID, _ json.RawMessage, ttl time.Duration) (string, clouddomain.GitHubInstallAttempt, error) {
	s.createCalls++
	s.createOrgID = orgID
	s.createUserID = userID
	s.createTTL = ttl
	return "nonce", clouddomain.GitHubInstallAttempt{}, nil
}

func (s *fakeGitHubStore) RecordPendingGitHubInstallation(
	_ context.Context,
	_ clouddomain.OrgID,
	_ clouddomain.UserID,
	_ string,
	input cloudpostgres.GitHubPendingInstallationInput,
) (clouddomain.GitHubInstallAttempt, error) {
	s.recordPendingCalls++
	if s.recordPendingErr != nil {
		return clouddomain.GitHubInstallAttempt{}, s.recordPendingErr
	}
	if s.pendingAttempt.PendingGitHubInstallationID != nil &&
		*s.pendingAttempt.PendingGitHubInstallationID != input.InstallationID {
		return clouddomain.GitHubInstallAttempt{}, cloudpostgres.ErrGitHubInstallAttemptConflict
	}
	if s.pendingAttempt.PendingGitHubInstallationID == nil {
		s.pendingAttempt = pendingAttemptFromInput(input)
	}
	return s.pendingAttempt, nil
}

func (s *fakeGitHubStore) GetPendingGitHubInstallation(
	context.Context,
	clouddomain.OrgID,
	clouddomain.UserID,
	string,
) (clouddomain.GitHubInstallAttempt, error) {
	s.getPendingCalls++
	if s.consumed {
		return clouddomain.GitHubInstallAttempt{}, cloudpostgres.ErrInvalidGitHubInstallAttempt
	}
	if s.getPendingErr != nil {
		return clouddomain.GitHubInstallAttempt{}, s.getPendingErr
	}
	return s.pendingAttempt, nil
}

func (s *fakeGitHubStore) ConfirmGitHubInstallation(
	_ context.Context,
	_ clouddomain.OrgID,
	_ clouddomain.UserID,
	_ string,
	confirmation cloudpostgres.GitHubInstallationConfirmation,
) ([]clouddomain.GitHubRepositoryGrant, error) {
	s.confirmCalls++
	if s.confirmErr != nil {
		return nil, s.confirmErr
	}
	if s.consumed {
		return nil, cloudpostgres.ErrInvalidGitHubInstallAttempt
	}
	s.consumed = true
	s.bindCalls++
	if confirmation.Installation.Status == "active" {
		s.fullSyncCalls++
		s.syncedRepositories = append([]clouddomain.GitHubRepository(nil), confirmation.Repositories...)
	}
	return nil, nil
}

func pendingAttemptFromInput(input cloudpostgres.GitHubPendingInstallationInput) clouddomain.GitHubInstallAttempt {
	return clouddomain.GitHubInstallAttempt{
		PendingGitHubInstallationID: &input.InstallationID,
		PendingGitHubAccountID:      &input.AccountID,
		PendingAccountLogin:         &input.AccountLogin,
		PendingAccountType:          &input.AccountType,
		PendingRepositorySelection:  &input.RepositorySelection,
		PendingRepositoryCount:      &input.RepositoryCount,
	}
}

func (s *fakeGitHubStore) BindGitHubInstallation(context.Context, clouddomain.OrgID, clouddomain.UserID, cloudpostgres.GitHubInstallationInput) (clouddomain.GitHubInstallation, error) {
	s.bindCalls++
	return clouddomain.GitHubInstallation{}, nil
}

func (s *fakeGitHubStore) ListGitHubInstallations(context.Context, clouddomain.OrgID) ([]clouddomain.GitHubInstallation, error) {
	return s.installations, nil
}

func (s *fakeGitHubStore) FindGitHubInstallationByGitHubID(context.Context, int64) (clouddomain.GitHubInstallation, error) {
	if s.binding != nil {
		return *s.binding, nil
	}
	return clouddomain.GitHubInstallation{}, cloudpostgres.ErrGitHubInstallationNotFound
}

func (*fakeGitHubStore) DisconnectGitHubInstallation(context.Context, clouddomain.OrgID, int64) error {
	return nil
}

func (s *fakeGitHubStore) UpdateGitHubInstallationStatus(_ context.Context, _ clouddomain.OrgID, installationID int64, update cloudpostgres.GitHubInstallationStatusUpdate) (clouddomain.GitHubInstallation, error) {
	s.statusInstallations = append(s.statusInstallations, installationID)
	s.statusUpdates = append(s.statusUpdates, update)
	return clouddomain.GitHubInstallation{}, nil
}

func (s *fakeGitHubStore) FullSyncGitHubRepositories(_ context.Context, _ clouddomain.OrgID, _ int64, repositories []clouddomain.GitHubRepository) ([]clouddomain.GitHubRepositoryGrant, error) {
	s.fullSyncCalls++
	s.syncedRepositories = append([]clouddomain.GitHubRepository(nil), repositories...)
	return nil, nil
}

func (s *fakeGitHubStore) ListActiveGitHubRepositories(context.Context, clouddomain.OrgID) ([]clouddomain.GitHubGrantedRepository, error) {
	return s.repositories, nil
}

func (s *fakeGitHubStore) FindActiveGitHubRepositoryGrant(context.Context, clouddomain.OrgID, int64) (clouddomain.GitHubRepositoryGrant, error) {
	if s.activeGrantErr != nil {
		return clouddomain.GitHubRepositoryGrant{}, s.activeGrantErr
	}
	if s.activeGrant != nil {
		return *s.activeGrant, nil
	}
	return clouddomain.GitHubRepositoryGrant{}, cloudpostgres.ErrGitHubRepositoryGrantNotFound
}

func (s *fakeGitHubStore) InsertGitHubWebhookDelivery(_ context.Context, input cloudpostgres.GitHubWebhookDeliveryInput) (clouddomain.GitHubWebhookDelivery, bool, error) {
	s.lastDelivery = input
	if existing, ok := s.deliveries[input.DeliveryID]; ok {
		if existing.Event != input.Event ||
			existing.Action != input.Action ||
			!bytes.Equal(existing.Payload, input.Payload) {
			return clouddomain.GitHubWebhookDelivery{}, false, cloudpostgres.ErrGitHubWebhookReplayConflict
		}
		return clouddomain.GitHubWebhookDelivery{DeliveryID: input.DeliveryID}, false, nil
	}
	s.deliveries[input.DeliveryID] = input
	return clouddomain.GitHubWebhookDelivery{DeliveryID: input.DeliveryID}, true, nil
}

func (*fakeGitHubStore) ClaimNextGitHubWebhookDelivery(context.Context) (clouddomain.GitHubWebhookDelivery, bool, error) {
	return clouddomain.GitHubWebhookDelivery{}, false, nil
}

func (*fakeGitHubStore) MarkGitHubWebhookDeliveryProcessed(context.Context, string) error {
	return nil
}

func (*fakeGitHubStore) MarkGitHubWebhookDeliveryFailed(context.Context, string, string, *time.Time) error {
	return nil
}

type githubTestAuthenticator struct{}

func (githubTestAuthenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := cloudauth.ContextWithPrincipal(r.Context(), cloudauth.Principal{
			UserID:       "user-1",
			AuthProvider: "local",
		})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type githubRouteStore struct {
	store
	role string
}

func (*githubRouteStore) EnsureAccount(_ context.Context, userID, _ string) (clouddomain.Account, error) {
	return clouddomain.Account{ID: "account-1", OwnerUserID: userID}, nil
}

func (s *githubRouteStore) GetOrgMembership(_ context.Context, userID string, orgID clouddomain.OrgID) (clouddomain.UserOrganization, error) {
	return clouddomain.UserOrganization{
		Organization: clouddomain.Organization{ID: orgID},
		Membership: clouddomain.OrgMembership{
			OrgID:  orgID,
			UserID: clouddomain.UserID(userID),
			Role:   s.role,
			Status: "active",
		},
	}, nil
}
