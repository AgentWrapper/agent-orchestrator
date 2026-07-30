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

func TestChatMessageAuthIdempotencyAndWorkerReplay(t *testing.T) {
	server, store := integrationAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	account, err := store.EnsureAccount(ctx, tokenID("user-one"), "User One")
	if err != nil {
		t.Fatalf("EnsureAccount() error = %v", err)
	}
	project, err := store.CreateProject(ctx, account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   "Chat E2E",
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
		DisplayName:    "chat-e2e",
		Prompt:         "initial task",
		Resource:       clouddomain.DefaultResourceProfile(),
	})
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	initialEvents, err := store.ChatEventsAfter(ctx, account.ID, created.Session.ID, 0, 10)
	if err != nil || len(initialEvents) != 1 {
		t.Fatalf("initial chat events = %#v, error = %v", initialEvents, err)
	}
	initialEvent := initialEvents[0]
	path := "/api/cloud/v1/sessions/" + string(created.Session.ID) + "/messages"
	key := uuid.NewString()
	unauthorized := requestJSON(
		t,
		server,
		http.MethodPost,
		path,
		"user-two",
		map[string]string{"text": "hello Claude"},
		map[string]string{"Idempotency-Key": key},
	)
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-account message status = %d, want 404", unauthorized.StatusCode)
	}

	first := requestJSON(
		t,
		server,
		http.MethodPost,
		path,
		"user-one",
		map[string]string{"text": "hello Claude"},
		map[string]string{"Idempotency-Key": key},
	)
	defer first.Body.Close()
	if first.StatusCode != http.StatusAccepted {
		t.Fatalf("first message status = %d", first.StatusCode)
	}
	var firstBody struct {
		Event clouddomain.Event `json:"event"`
	}
	if err := json.NewDecoder(first.Body).Decode(&firstBody); err != nil {
		t.Fatalf("decode first message: %v", err)
	}
	if firstBody.Event.Type != "chat.user_message" {
		t.Fatalf("first event type = %q", firstBody.Event.Type)
	}

	retry := requestJSON(
		t,
		server,
		http.MethodPost,
		path,
		"user-one",
		map[string]string{"text": "hello Claude"},
		map[string]string{"Idempotency-Key": key},
	)
	defer retry.Body.Close()
	if retry.StatusCode != http.StatusAccepted {
		t.Fatalf("retry message status = %d", retry.StatusCode)
	}
	var retryBody struct {
		Event clouddomain.Event `json:"event"`
	}
	if err := json.NewDecoder(retry.Body).Decode(&retryBody); err != nil {
		t.Fatalf("decode retried message: %v", err)
	}
	if retryBody.Event.Sequence != firstBody.Event.Sequence ||
		string(retryBody.Event.Payload) != string(firstBody.Event.Payload) {
		t.Fatalf("retry event = %#v, want %#v", retryBody.Event, firstBody.Event)
	}
	conflict := requestJSON(
		t,
		server,
		http.MethodPost,
		path,
		"user-one",
		map[string]string{"text": "different text"},
		map[string]string{"Idempotency-Key": key},
	)
	conflict.Body.Close()
	if conflict.StatusCode != http.StatusConflict {
		t.Fatalf("conflicting retry status = %d, want 409", conflict.StatusCode)
	}

	if _, err := store.AppendEvent(
		ctx,
		account.ID,
		created.Session.ID,
		"terminal.output",
		json.RawMessage(`{"data":"ignored"}`),
	); err != nil {
		t.Fatalf("AppendEvent(non-chat) error = %v", err)
	}
	eventsResponse := requestJSON(
		t,
		server,
		http.MethodGet,
		"/api/cloud/v1/sessions/"+string(created.Session.ID)+"/chat-events?after=0&limit=1",
		"user-one",
		nil,
		nil,
	)
	defer eventsResponse.Body.Close()
	if eventsResponse.StatusCode != http.StatusOK {
		t.Fatalf("chat events status = %d", eventsResponse.StatusCode)
	}
	var eventsBody struct {
		Events []clouddomain.Event `json:"events"`
	}
	if err := json.NewDecoder(eventsResponse.Body).Decode(&eventsBody); err != nil {
		t.Fatalf("decode chat events: %v", err)
	}
	if len(eventsBody.Events) != 1 || eventsBody.Events[0].Sequence != initialEvent.Sequence {
		t.Fatalf("chat events = %#v", eventsBody.Events)
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
			"capabilities":   []string{"chat.stream-json.v1"},
		},
		nil,
	)
	defer bootstrapResponse.Body.Close()
	var bootstrapBody struct {
		WorkerToken string `json:"workerToken"`
	}
	if err := json.NewDecoder(bootstrapResponse.Body).Decode(&bootstrapBody); err != nil {
		t.Fatalf("decode bootstrap: %v", err)
	}
	workerEvent := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/events",
		"",
		map[string]any{
			"type":    "chat.assistant_delta",
			"payload": map[string]string{"text": "hello"},
		},
		map[string]string{"Authorization": "Worker " + bootstrapBody.WorkerToken},
	)
	workerEvent.Body.Close()
	if workerEvent.StatusCode != http.StatusAccepted {
		t.Fatalf("chat worker event status = %d", workerEvent.StatusCode)
	}
	workerURL := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/api/cloud/v1/worker/connect?after=0"
	headers := http.Header{}
	headers.Set("Authorization", "Worker "+bootstrapBody.WorkerToken)
	socket, _, err := websocket.Dial(ctx, workerURL, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatalf("dial worker socket: %v", err)
	}
	defer socket.Close(websocket.StatusNormalClosure, "test complete")
	for _, expected := range []struct {
		sequence int64
		text     string
	}{
		{sequence: initialEvent.Sequence, text: "initial task"},
		{sequence: firstBody.Event.Sequence, text: "hello Claude"},
	} {
		_, encodedCommand, readErr := socket.Read(ctx)
		if readErr != nil {
			t.Fatalf("read replayed prompt: %v", readErr)
		}
		var command cloudworkerhub.Command
		if err := json.Unmarshal(encodedCommand, &command); err != nil {
			t.Fatalf("decode replayed prompt: %v", err)
		}
		decodedPrompt, err := base64.StdEncoding.DecodeString(command.Data)
		if err != nil {
			t.Fatalf("decode prompt data: %v", err)
		}
		if command.Type != "prompt" ||
			command.Sequence != expected.sequence ||
			string(decodedPrompt) != expected.text {
			t.Fatalf("replayed prompt command = %#v text=%q", command, decodedPrompt)
		}
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

	oauthSecret := "sk-ant-oat01-" + strings.Repeat("a", 80)
	put := requestJSON(
		t,
		server,
		http.MethodPut,
		"/api/cloud/v1/provider-connections/agents/claude-code",
		"user-one",
		map[string]any{"credentialType": "oauth_token", "secret": oauthSecret},
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
		Secret:         oauthSecret,
	}) {
		t.Fatalf("bootstrap agentCredential = %#v", bootstrapBody.AgentCredential)
	}
}

func TestWorkerOrchestrationIsProjectScoped(t *testing.T) {
	server, store := integrationAPI(t)
	ctx := context.Background()
	connection := requestJSON(
		t,
		server,
		http.MethodPut,
		"/api/cloud/v1/provider-connections/agents/cursor",
		"user-one",
		map[string]string{"credentialType": "api_key", "secret": "cursor-secret"},
		nil,
	)
	connection.Body.Close()
	if connection.StatusCode != http.StatusOK {
		t.Fatalf("cursor connection status = %d", connection.StatusCode)
	}
	account, err := store.EnsureAccount(ctx, tokenID("user-one"), "User One")
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject(ctx, account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   "Orchestration",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := store.CreateSession(ctx, account.ID, cloudpostgres.CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      project.ID,
		Kind:           "orchestrator",
		Harness:        "cursor",
		DisplayName:    "orchestrator",
		Resource:       clouddomain.DefaultResourceProfile(),
		Provider:       "daytona",
	})
	if err != nil {
		t.Fatal(err)
	}
	unscopedToken := bootstrapWorker(t, server, store, account.ID, parent.Session.ID, []string{
		"worker:connect",
		"worker:event",
		"worker:terminal",
	})
	unscoped := requestJSON(
		t,
		server,
		http.MethodGet,
		"/api/cloud/v1/worker/orchestrate/sessions",
		"",
		nil,
		map[string]string{
			"Authorization":   "Worker " + unscopedToken,
			"X-AO-Session-ID": string(parent.Session.ID),
		},
	)
	unscoped.Body.Close()
	if unscoped.StatusCode != http.StatusForbidden {
		t.Fatalf("unscoped orchestration status = %d, want 403", unscoped.StatusCode)
	}
	token := bootstrapWorker(t, server, store, account.ID, parent.Session.ID, []string{
		"worker:connect",
		"worker:event",
		"worker:terminal",
		"worker:orchestrate",
	})
	headers := map[string]string{
		"Authorization":   "Worker " + token,
		"X-AO-Session-ID": string(parent.Session.ID),
		"Idempotency-Key": uuid.NewString(),
	}
	spawn := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/orchestrate/sessions",
		"",
		map[string]string{
			"displayName": "worker-one",
			"prompt":      "fix the tests",
		},
		headers,
	)
	defer spawn.Body.Close()
	if spawn.StatusCode != http.StatusCreated {
		payload, _ := io.ReadAll(spawn.Body)
		t.Fatalf("spawn status = %d: %s", spawn.StatusCode, payload)
	}
	var spawned cloudpostgres.CreateSessionResult
	if err := json.NewDecoder(spawn.Body).Decode(&spawned); err != nil {
		t.Fatal(err)
	}
	if spawned.Session.ProjectID != project.ID ||
		spawned.Session.Harness != parent.Session.Harness ||
		spawned.Sandbox.Provider != parent.Sandbox.Provider {
		t.Fatalf("spawned result = %#v", spawned)
	}

	list := requestJSON(
		t,
		server,
		http.MethodGet,
		"/api/cloud/v1/worker/orchestrate/sessions",
		"",
		nil,
		map[string]string{
			"Authorization":   "Worker " + token,
			"X-AO-Session-ID": string(parent.Session.ID),
		},
	)
	defer list.Body.Close()
	if list.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", list.StatusCode)
	}
	var listed struct {
		Sessions []clouddomain.Session `json:"sessions"`
	}
	if err := json.NewDecoder(list.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Sessions) != 2 {
		t.Fatalf("listed sessions = %#v", listed.Sessions)
	}

	otherProject, err := store.CreateProject(ctx, account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   "Other",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateSession(ctx, account.ID, cloudpostgres.CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      otherProject.ID,
		Kind:           "worker",
		Harness:        "fake",
		DisplayName:    "other-worker",
		Resource:       clouddomain.DefaultResourceProfile(),
	})
	if err != nil {
		t.Fatal(err)
	}
	crossProject := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/orchestrate/sessions/"+string(other.Session.ID)+"/messages",
		"",
		map[string]string{"text": "not allowed"},
		headers,
	)
	crossProject.Body.Close()
	if crossProject.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-project send status = %d, want 404", crossProject.StatusCode)
	}
}

func TestBrowserInterruptAndWorkerTurnActivity(t *testing.T) {
	server, store := integrationAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	account, err := store.EnsureAccount(ctx, tokenID("user-one"), "User One")
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject(ctx, account.ID, cloudpostgres.CreateProjectInput{
		DisplayName:   "Interrupt",
		RepositoryURL: "https://github.com/example/" + uuid.NewString(),
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, account.ID, cloudpostgres.CreateSessionInput{
		IdempotencyKey: uuid.NewString(),
		ProjectID:      project.ID,
		Kind:           "worker",
		Harness:        "fake",
		DisplayName:    "interrupt-worker",
		Resource:       clouddomain.DefaultResourceProfile(),
	})
	if err != nil {
		t.Fatal(err)
	}
	token := bootstrapWorker(t, server, store, account.ID, session.Session.ID, []string{
		"worker:connect",
		"worker:event",
		"worker:terminal",
	})
	workerURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/cloud/v1/worker/connect"
	workerHeaders := http.Header{}
	workerHeaders.Set("Authorization", "Worker "+token)
	socket, _, err := websocket.Dial(ctx, workerURL, &websocket.DialOptions{HTTPHeader: workerHeaders})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close(websocket.StatusNormalClosure, "test complete")

	interrupt := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/sessions/"+string(session.Session.ID)+"/interrupt",
		"user-one",
		map[string]any{},
		nil,
	)
	defer interrupt.Body.Close()
	if interrupt.StatusCode != http.StatusAccepted {
		t.Fatalf("interrupt status = %d", interrupt.StatusCode)
	}
	_, encodedCommand, err := socket.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var command cloudworkerhub.Command
	if err := json.Unmarshal(encodedCommand, &command); err != nil {
		t.Fatal(err)
	}
	if command.Type != "interrupt" || command.Sequence <= 0 {
		t.Fatalf("interrupt command = %#v", command)
	}

	for _, event := range []struct {
		eventType string
		wantState string
	}{
		{eventType: "chat.turn_started", wantState: "active"},
		{eventType: "chat.turn_interrupted", wantState: "idle"},
		{eventType: "chat.turn_completed", wantState: "idle"},
	} {
		response := requestJSON(
			t,
			server,
			http.MethodPost,
			"/api/cloud/v1/worker/events",
			"",
			map[string]any{"type": event.eventType, "payload": map[string]any{}},
			map[string]string{"Authorization": "Worker " + token},
		)
		response.Body.Close()
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("%s status = %d", event.eventType, response.StatusCode)
		}
		got, err := store.GetSession(ctx, account.ID, session.Session.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.ActivityState != event.wantState {
			t.Fatalf("%s activity = %q, want %q", event.eventType, got.ActivityState, event.wantState)
		}
	}
}

func bootstrapWorker(
	t *testing.T,
	server *httptest.Server,
	store *cloudpostgres.Store,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	scopes []string,
) string {
	t.Helper()
	ticket, err := store.IssueAccessTicket(
		context.Background(),
		accountID,
		sessionID,
		"worker_bootstrap",
		scopes,
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	response := requestJSON(
		t,
		server,
		http.MethodPost,
		"/api/cloud/v1/worker/bootstrap",
		"",
		map[string]any{"bootstrapToken": ticket, "version": "test", "capabilities": []string{"chat.stream-json.v1"}},
		nil,
	)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("bootstrap status = %d: %s", response.StatusCode, payload)
	}
	var body struct {
		WorkerToken string `json:"workerToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.WorkerToken
}
