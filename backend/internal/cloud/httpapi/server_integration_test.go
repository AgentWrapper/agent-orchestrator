package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudevents "github.com/aoagents/agent-orchestrator/backend/internal/cloud/events"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

func integrationAPI(t *testing.T) (*httptest.Server, *cloudpostgres.Store) {
	t.Helper()
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := cloudpostgres.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	store, err := cloudpostgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(store.Close)
	authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token != "user-one" && token != "user-two" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"id":"` + tokenID(token) + `","email":"` + token + `@example.com"}`))
	}))
	t.Cleanup(authServer.Close)
	secretCipher, err := cloudsecrets.New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("secrets.New() error = %v", err)
	}
	api := New(
		store,
		cloudevents.New(store),
		cloudauth.NewVerifier(authServer.URL, "anon", authServer.Client()),
		cloudworker.NewTokenManager([]byte("01234567890123456789012345678901")),
		secretCipher,
		"daytona",
		"https://app.daytona.io/api",
		"us",
		cloudworkerhub.New(),
		nil,
		"http://127.0.0.1:5174",
		nil,
	)
	credentialServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	t.Cleanup(credentialServer.Close)
	api.agentCredentials = newAgentCredentialValidator(credentialServer.Client())
	api.agentCredentials.anthropicBaseURL = credentialServer.URL
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	return server, store
}

func tokenID(token string) string {
	if token == "user-one" {
		return "11111111-1111-4111-8111-111111111111"
	}
	return "22222222-2222-4222-8222-222222222222"
}

func requestJSON(
	t *testing.T,
	server *httptest.Server,
	method, path, token string,
	body any,
	headers map[string]string,
) *http.Response {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("Marshal() error = %v", err)
		}
	}
	request, err := http.NewRequest(method, server.URL+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	return response
}

func TestAuthenticatedProjectAndIdempotentSessionFlow(t *testing.T) {
	server, _ := integrationAPI(t)
	repositoryURL := "https://github.com/example/" + uuid.NewString()
	projectResponse := requestJSON(t, server, http.MethodPost, "/api/cloud/v1/projects", "user-one", map[string]any{
		"displayName":   "AO Cloud",
		"repositoryUrl": repositoryURL,
		"defaultBranch": "main",
	}, nil)
	defer projectResponse.Body.Close()
	if projectResponse.StatusCode != http.StatusCreated {
		t.Fatalf("project status = %d", projectResponse.StatusCode)
	}
	var projectBody struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	if err := json.NewDecoder(projectResponse.Body).Decode(&projectBody); err != nil {
		t.Fatalf("decode project response: %v", err)
	}

	idempotencyKey := uuid.NewString()
	sessionInput := map[string]any{
		"projectId":   projectBody.Project.ID,
		"kind":        "worker",
		"harness":     "fake",
		"displayName": "verify-cloud",
		"prompt":      "Verify the cloud flow",
	}
	first := requestJSON(t, server, http.MethodPost, "/api/cloud/v1/sessions", "user-one", sessionInput, map[string]string{
		"Idempotency-Key": idempotencyKey,
	})
	defer first.Body.Close()
	if first.StatusCode != http.StatusCreated {
		t.Fatalf("first session status = %d", first.StatusCode)
	}
	var firstBody struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	if err := json.NewDecoder(first.Body).Decode(&firstBody); err != nil {
		t.Fatalf("decode first session: %v", err)
	}

	second := requestJSON(t, server, http.MethodPost, "/api/cloud/v1/sessions", "user-one", sessionInput, map[string]string{
		"Idempotency-Key": idempotencyKey,
	})
	defer second.Body.Close()
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second session status = %d", second.StatusCode)
	}
	var secondBody struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	if err := json.NewDecoder(second.Body).Decode(&secondBody); err != nil {
		t.Fatalf("decode second session: %v", err)
	}
	if secondBody.Session.ID != firstBody.Session.ID {
		t.Fatalf("session IDs = %q and %q", firstBody.Session.ID, secondBody.Session.ID)
	}

	otherUser := requestJSON(
		t,
		server,
		http.MethodGet,
		"/api/cloud/v1/sessions/"+firstBody.Session.ID,
		"user-two",
		nil,
		nil,
	)
	defer otherUser.Body.Close()
	if otherUser.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-user session status = %d, want 404", otherUser.StatusCode)
	}
}

func TestWorkerAndBrowserTerminalReplayLiveRouting(t *testing.T) {
	server, store := integrationAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	account, err := store.EnsureAccount(ctx, tokenID("user-one"), "User One")
	if err != nil {
		t.Fatalf("EnsureAccount() error = %v", err)
	}
	project, err := store.CreateProject(ctx, account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   "Terminal E2E",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatalf("CreateProject() error = %v", err)
	}
	created, err := store.CreateSession(ctx, account.ID, cloudpostgres.CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      project.ID,
		Kind:           "worker",
		Harness:        "fake",
		DisplayName:    "terminal-e2e",
		Resource:       clouddomain.DefaultResourceProfile(),
	})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	bootstrapTicket, err := store.IssueAccessTicket(
		ctx,
		account.ID,
		created.Session.ID,
		"worker_bootstrap",
		[]string{"worker:connect", "worker:event", "worker:terminal"},
		time.Minute,
	)
	if err != nil {
		t.Fatalf("IssueAccessTicket(worker) error = %v", err)
	}
	bootstrapResponse := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/bootstrap",
		"",
		map[string]any{
			"bootstrapToken": bootstrapTicket,
			"version":        "test",
			"capabilities":   []string{"pty.v1"},
		},
		nil,
	)
	defer bootstrapResponse.Body.Close()
	if bootstrapResponse.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", bootstrapResponse.StatusCode)
	}
	var bootstrapBody struct {
		WorkerToken string `json:"workerToken"`
	}
	if err := json.NewDecoder(bootstrapResponse.Body).Decode(&bootstrapBody); err != nil {
		t.Fatalf("decode bootstrap: %v", err)
	}

	workerURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/cloud/v1/worker/connect"
	workerHeaders := http.Header{}
	workerHeaders.Set("Authorization", "Worker "+bootstrapBody.WorkerToken)
	workerSocket, _, err := websocket.Dial(ctx, workerURL, &websocket.DialOptions{HTTPHeader: workerHeaders})
	if err != nil {
		t.Fatalf("dial worker socket: %v", err)
	}
	defer workerSocket.Close(websocket.StatusNormalClosure, "test complete")

	ticketResponse := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/sessions/"+string(created.Session.ID)+"/terminal-ticket",
		"user-one",
		map[string]any{},
		nil,
	)
	defer ticketResponse.Body.Close()
	var ticketBody struct {
		Ticket string `json:"ticket"`
	}
	if err := json.NewDecoder(ticketResponse.Body).Decode(&ticketBody); err != nil {
		t.Fatalf("decode terminal ticket: %v", err)
	}
	terminalURL := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/api/cloud/v1/terminal?ticket=" + ticketBody.Ticket
	terminalHeaders := http.Header{}
	terminalHeaders.Set("Origin", "http://127.0.0.1:5174")
	terminalSocket, _, err := websocket.Dial(ctx, terminalURL, &websocket.DialOptions{HTTPHeader: terminalHeaders})
	if err != nil {
		t.Fatalf("dial terminal socket: %v", err)
	}
	defer terminalSocket.Close(websocket.StatusNormalClosure, "test complete")
	_, resetMessageData, err := terminalSocket.Read(ctx)
	if err != nil {
		t.Fatalf("read terminal reset: %v", err)
	}
	var resetMessage terminalServerMessage
	if err := json.Unmarshal(resetMessageData, &resetMessage); err != nil {
		t.Fatalf("decode terminal reset: %v", err)
	}
	if resetMessage.Type != "reset" || resetMessage.Sequence <= 0 {
		t.Fatalf("terminal reset = %#v", resetMessage)
	}

	output := base64.StdEncoding.EncodeToString([]byte("worker output"))
	eventResponse := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/events",
		"",
		map[string]any{"type": "terminal.output", "payload": map[string]string{"data": output, "encoding": "base64"}},
		map[string]string{"Authorization": "Worker " + bootstrapBody.WorkerToken},
	)
	defer eventResponse.Body.Close()
	if eventResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("worker event status = %d", eventResponse.StatusCode)
	}
	_, browserMessage, err := terminalSocket.Read(ctx)
	if err != nil {
		t.Fatalf("read browser output: %v", err)
	}
	var outputMessage terminalServerMessage
	if err := json.Unmarshal(browserMessage, &outputMessage); err != nil {
		t.Fatalf("decode browser output: %v", err)
	}
	if outputMessage.Type != "output" || outputMessage.Data != output {
		t.Fatalf("browser output = %#v", outputMessage)
	}

	input := base64.StdEncoding.EncodeToString([]byte("hello"))
	if err := terminalSocket.Write(ctx, websocket.MessageText, []byte(`{"type":"input","data":"`+input+`"}`)); err != nil {
		t.Fatalf("write browser input: %v", err)
	}
	_, workerMessage, err := workerSocket.Read(ctx)
	if err != nil {
		t.Fatalf("read worker command: %v", err)
	}
	var command struct {
		Type string `json:"type"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(workerMessage, &command); err != nil {
		t.Fatalf("decode worker command: %v", err)
	}
	if command.Type != "input" || command.Data != input {
		t.Fatalf("worker command = %#v", command)
	}
}

func TestAgentProviderConnectionValidationAndAccountIsolation(t *testing.T) {
	server, _ := integrationAPI(t)
	for _, token := range []string{"user-one", "user-two"} {
		response := requestJSON(
			t,
			server,
			http.MethodDelete,
			"/api/cloud/v1/provider-connections/agents/cursor",
			token,
			nil,
			nil,
		)
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			t.Fatalf("initial %s delete status = %d", token, response.StatusCode)
		}
	}

	for _, test := range []struct {
		name   string
		agent  string
		body   map[string]any
		status int
		code   string
	}{
		{
			name:   "unknown agent",
			agent:  "other",
			body:   map[string]any{"credentialType": "api_key", "secret": "secret"},
			status: http.StatusBadRequest,
			code:   "INVALID_AGENT",
		},
		{
			name:   "unsupported credential type",
			agent:  "cursor",
			body:   map[string]any{"credentialType": "oauth_token", "secret": "secret"},
			status: http.StatusBadRequest,
			code:   "INVALID_CREDENTIAL_TYPE",
		},
		{
			name:   "empty secret",
			agent:  "claude-code",
			body:   map[string]any{"credentialType": "api_key", "secret": " \n "},
			status: http.StatusBadRequest,
			code:   "INVALID_AGENT_CREDENTIAL",
		},
		{
			name:   "oversized secret",
			agent:  "codex",
			body:   map[string]any{"credentialType": "api_key", "secret": strings.Repeat("x", maxAgentCredentialBytes+1)},
			status: http.StatusBadRequest,
			code:   "INVALID_AGENT_CREDENTIAL",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := requestJSON(
				t,
				server,
				http.MethodPut,
				"/api/cloud/v1/provider-connections/agents/"+test.agent,
				"user-one",
				test.body,
				nil,
			)
			defer response.Body.Close()
			if response.StatusCode != test.status {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.status)
			}
			var body struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if body.Code != test.code {
				t.Fatalf("code = %q, want %q", body.Code, test.code)
			}
		})
	}

	put := requestJSON(
		t,
		server,
		http.MethodPut,
		"/api/cloud/v1/provider-connections/agents/cursor",
		"user-one",
		map[string]any{"credentialType": "api_key", "secret": "  cursor-secret  "},
		nil,
	)
	defer put.Body.Close()
	if put.StatusCode != http.StatusOK {
		t.Fatalf("put status = %d", put.StatusCode)
	}
	encodedPut, err := io.ReadAll(put.Body)
	if err != nil {
		t.Fatalf("read put response: %v", err)
	}
	if bytes.Contains(encodedPut, []byte("cursor-secret")) ||
		bytes.Contains(encodedPut, []byte("encryptedSecret")) {
		t.Fatalf("put response exposed credential material: %s", encodedPut)
	}

	otherAccountList := requestJSON(
		t,
		server,
		http.MethodGet,
		"/api/cloud/v1/provider-connections",
		"user-two",
		nil,
		nil,
	)
	defer otherAccountList.Body.Close()
	var otherListBody struct {
		ProviderConnections []cloudpostgres.ProviderConnection `json:"providerConnections"`
	}
	if err := json.NewDecoder(otherAccountList.Body).Decode(&otherListBody); err != nil {
		t.Fatalf("decode other account list: %v", err)
	}
	for _, connection := range otherListBody.ProviderConnections {
		if connection.Provider == "cursor" && connection.Label == "default" {
			t.Fatalf("other account can see user-one connection")
		}
	}

	otherDelete := requestJSON(
		t,
		server,
		http.MethodDelete,
		"/api/cloud/v1/provider-connections/agents/cursor",
		"user-two",
		nil,
		nil,
	)
	defer otherDelete.Body.Close()
	if otherDelete.StatusCode != http.StatusNoContent {
		t.Fatalf("other account delete status = %d", otherDelete.StatusCode)
	}

	userList := requestJSON(
		t,
		server,
		http.MethodGet,
		"/api/cloud/v1/provider-connections",
		"user-one",
		nil,
		nil,
	)
	defer userList.Body.Close()
	var userListBody struct {
		ProviderConnections []cloudpostgres.ProviderConnection `json:"providerConnections"`
	}
	if err := json.NewDecoder(userList.Body).Decode(&userListBody); err != nil {
		t.Fatalf("decode user account list: %v", err)
	}
	found := false
	for _, connection := range userListBody.ProviderConnections {
		if connection.Provider == "cursor" && connection.Label == "default" {
			found = true
			var config agentConnectionConfig
			if err := json.Unmarshal(connection.Config, &config); err != nil {
				t.Fatalf("decode connection config: %v", err)
			}
			if config.CredentialType != "api_key" {
				t.Fatalf("credential type = %q", config.CredentialType)
			}
		}
	}
	if !found {
		t.Fatalf("user-one cursor connection was deleted by user-two")
	}
}

func TestAgentConnectionGatesSessionAndBootstrapsCredential(t *testing.T) {
	server, store := integrationAPI(t)
	deleteResponse := requestJSON(
		t,
		server,
		http.MethodDelete,
		"/api/cloud/v1/provider-connections/agents/claude-code",
		"user-one",
		nil,
		nil,
	)
	deleteResponse.Body.Close()
	if deleteResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("initial delete status = %d", deleteResponse.StatusCode)
	}

	projectResponse := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/projects",
		"user-one",
		map[string]any{
			"displayName":   "Credential bootstrap",
			"repositoryUrl": "https://github.com/example/" + uuid.NewString(),
			"defaultBranch": "main",
		},
		nil,
	)
	defer projectResponse.Body.Close()
	var projectBody struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	if err := json.NewDecoder(projectResponse.Body).Decode(&projectBody); err != nil {
		t.Fatalf("decode project: %v", err)
	}
	sessionInput := map[string]any{
		"projectId":   projectBody.Project.ID,
		"kind":        "worker",
		"harness":     "claude-code",
		"displayName": "credential-bootstrap",
		"prompt":      "Test credentials",
	}
	missing := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/sessions",
		"user-one",
		sessionInput,
		map[string]string{"Idempotency-Key": uuid.NewString()},
	)
	defer missing.Body.Close()
	if missing.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing connection status = %d, want 400", missing.StatusCode)
	}
	var missingBody struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(missing.Body).Decode(&missingBody); err != nil {
		t.Fatalf("decode missing connection response: %v", err)
	}
	if missingBody.Code != "AGENT_CONNECTION_REQUIRED" {
		t.Fatalf("missing connection code = %q", missingBody.Code)
	}

	put := requestJSON(
		t,
		server,
		http.MethodPut,
		"/api/cloud/v1/provider-connections/agents/claude-code",
		"user-one",
		map[string]any{"credentialType": "oauth_token", "secret": "claude-oauth-secret"},
		nil,
	)
	put.Body.Close()
	if put.StatusCode != http.StatusOK {
		t.Fatalf("put connection status = %d", put.StatusCode)
	}
	created := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/sessions",
		"user-one",
		sessionInput,
		map[string]string{"Idempotency-Key": uuid.NewString()},
	)
	defer created.Body.Close()
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("created session status = %d", created.StatusCode)
	}
	var createdBody struct {
		Session struct {
			ID clouddomain.SessionID `json:"id"`
		} `json:"session"`
	}
	if err := json.NewDecoder(created.Body).Decode(&createdBody); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	account, err := store.EnsureAccount(context.Background(), tokenID("user-one"), "User One")
	if err != nil {
		t.Fatalf("EnsureAccount() error = %v", err)
	}
	ticket, err := store.IssueAccessTicket(
		context.Background(),
		account.ID,
		createdBody.Session.ID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	)
	if err != nil {
		t.Fatalf("IssueAccessTicket() error = %v", err)
	}
	bootstrap := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/bootstrap",
		"",
		map[string]any{
			"bootstrapToken": ticket,
			"version":        "test",
			"capabilities":   []string{"pty.v1"},
		},
		nil,
	)
	defer bootstrap.Body.Close()
	if bootstrap.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", bootstrap.StatusCode)
	}
	var bootstrapBody cloudworker.BootstrapResponse
	if err := json.NewDecoder(bootstrap.Body).Decode(&bootstrapBody); err != nil {
		t.Fatalf("decode bootstrap: %v", err)
	}
	if bootstrapBody.AgentCredential == nil {
		t.Fatal("bootstrap agentCredential = nil")
	}
	if *bootstrapBody.AgentCredential != (cloudworker.AgentCredential{
		Provider:       "claude-code",
		CredentialType: "oauth_token",
		Secret:         "claude-oauth-secret",
	}) {
		t.Fatalf("bootstrap agentCredential = %#v", bootstrapBody.AgentCredential)
	}
}
