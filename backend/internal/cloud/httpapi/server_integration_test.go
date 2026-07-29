package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
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
		"https://app.daytona.io/api",
		"us",
		cloudworkerhub.New(),
		nil,
		"http://127.0.0.1:5174",
		nil,
	)
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
