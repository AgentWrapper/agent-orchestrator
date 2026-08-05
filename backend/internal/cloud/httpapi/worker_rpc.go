package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	pathpkg "path"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

type workerRPCResponse struct {
	Payload json.RawMessage `json:"payload"`
	Error   string          `json:"error,omitempty"`
}

type workerRPCBroker struct {
	mu      sync.Mutex
	pending map[string]chan workerRPCResponse
}

type previewToken struct {
	SessionID clouddomain.SessionID
	Port      int
	FilePath  string
	ExpiresAt time.Time
}

type previewTokenStore struct {
	mu     sync.Mutex
	tokens map[string]previewToken
}

func newPreviewTokenStore() *previewTokenStore {
	return &previewTokenStore{tokens: make(map[string]previewToken)}
}

func (s *previewTokenStore) issue(sessionID clouddomain.SessionID, port int) (string, time.Time) {
	return s.issueToken(previewToken{SessionID: sessionID, Port: port})
}

func (s *previewTokenStore) issueFile(
	sessionID clouddomain.SessionID,
	filePath string,
) (string, time.Time) {
	return s.issueToken(previewToken{SessionID: sessionID, FilePath: filePath})
}

func (s *previewTokenStore) issueToken(value previewToken) (string, time.Time) {
	now := time.Now()
	expiresAt := now.Add(30 * time.Minute)
	token := uuid.NewString()
	s.mu.Lock()
	for key, value := range s.tokens {
		if value.ExpiresAt.Before(now) {
			delete(s.tokens, key)
		}
	}
	value.ExpiresAt = expiresAt
	s.tokens[token] = value
	s.mu.Unlock()
	return token, expiresAt
}

func (s *previewTokenStore) get(token string) (previewToken, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.tokens[token]
	if !ok || value.ExpiresAt.Before(time.Now()) {
		delete(s.tokens, token)
		return previewToken{}, false
	}
	return value, true
}

func newWorkerRPCBroker() *workerRPCBroker {
	return &workerRPCBroker{pending: make(map[string]chan workerRPCResponse)}
}

func workerRPCKey(sessionID clouddomain.SessionID, requestID string) string {
	return string(sessionID) + ":" + requestID
}

func (b *workerRPCBroker) register(
	sessionID clouddomain.SessionID,
	requestID string,
) (<-chan workerRPCResponse, func()) {
	key := workerRPCKey(sessionID, requestID)
	response := make(chan workerRPCResponse, 1)
	b.mu.Lock()
	b.pending[key] = response
	b.mu.Unlock()
	return response, func() {
		b.mu.Lock()
		delete(b.pending, key)
		b.mu.Unlock()
	}
}

func (b *workerRPCBroker) deliver(
	sessionID clouddomain.SessionID,
	requestID string,
	response workerRPCResponse,
) bool {
	key := workerRPCKey(sessionID, requestID)
	b.mu.Lock()
	pending, ok := b.pending[key]
	if ok {
		delete(b.pending, key)
	}
	b.mu.Unlock()
	if !ok {
		return false
	}
	pending <- response
	return true
}

func (s *Server) workerWorkspaceResponse(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:terminal") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:terminal scope is required.")
		return
	}
	var input struct {
		RequestID string          `json:"requestId"`
		Payload   json.RawMessage `json:"payload"`
		Error     string          `json:"error"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_JSON", "Request body must be valid JSON.")
		return
	}
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.RequestID == "" || len(input.RequestID) > 100 {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST_ID", "requestId is required.")
		return
	}
	if !s.workerRPC.deliver(claims.SessionID, input.RequestID, workerRPCResponse{
		Payload: input.Payload,
		Error:   input.Error,
	}) {
		writeError(w, r, http.StatusGone, "WORKSPACE_REQUEST_EXPIRED", "The workspace request is no longer active.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) workspaceFiles(w http.ResponseWriter, r *http.Request) {
	s.runWorkspaceRequest(w, r, "list", map[string]any{"path": r.URL.Query().Get("path")})
}

func (s *Server) workspaceFile(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeError(w, r, http.StatusBadRequest, "INVALID_WORKSPACE_PATH", "path is required.")
		return
	}
	s.runWorkspaceRequest(w, r, "read", map[string]any{"path": path})
}

func (s *Server) workspaceDiff(w http.ResponseWriter, r *http.Request) {
	s.runWorkspaceRequest(w, r, "diff", map[string]any{})
}

func (s *Server) workspacePreview(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Port   int    `json:"port"`
		Path   string `json:"path"`
		Method string `json:"method"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Port < 1024 || input.Port > 65535 {
		writeError(w, r, http.StatusBadRequest, "INVALID_PREVIEW_PORT", "port must be between 1024 and 65535.")
		return
	}
	s.runWorkspaceRequest(w, r, "preview", input)
}

func (s *Server) issueWorkspacePreview(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Port int `json:"port"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Port < 1024 || input.Port > 65535 {
		writeError(w, r, http.StatusBadRequest, "INVALID_PREVIEW_PORT", "port must be between 1024 and 65535.")
		return
	}
	_, session, ok := s.authorizedSession(w, r, "authorize workspace preview")
	if !ok {
		return
	}
	if !session.RuntimeConnected {
		writeError(w, r, http.StatusConflict, "WORKER_NOT_CONNECTED", "The worker is still starting.")
		return
	}
	token, expiresAt := s.previewTokens.issue(session.ID, input.Port)
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"url":       fmt.Sprintf("%s://%s/api/cloud/v1/preview/%s/", scheme, r.Host, token),
		"expiresAt": expiresAt.UTC(),
	})
}

func (s *Server) issueWorkspaceFilePreview(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Path = strings.TrimSpace(input.Path)
	if input.Path == "" || strings.ContainsRune(input.Path, '\x00') {
		writeError(w, r, http.StatusBadRequest, "INVALID_WORKSPACE_PATH", "path is required.")
		return
	}
	_, session, ok := s.authorizedSession(w, r, "authorize workspace file preview")
	if !ok {
		return
	}
	if !session.RuntimeConnected {
		writeError(w, r, http.StatusConflict, "WORKER_NOT_CONNECTED", "The worker is still starting.")
		return
	}
	token, expiresAt := s.previewTokens.issueFile(session.ID, input.Path)
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"url":       fmt.Sprintf("%s://%s/api/cloud/v1/preview/%s/", scheme, r.Host, token),
		"expiresAt": expiresAt.UTC(),
	})
}

func (s *Server) workspacePreviewProxy(w http.ResponseWriter, r *http.Request) {
	tokenValue, ok := s.previewTokens.get(chi.URLParam(r, "token"))
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "INVALID_PREVIEW_TOKEN", "The preview link is invalid or expired.")
		return
	}
	requestPath := "/" + strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if r.URL.RawQuery != "" {
		requestPath += "?" + r.URL.RawQuery
	}
	action := "preview"
	input := map[string]any{
		"port":   tokenValue.Port,
		"path":   requestPath,
		"method": r.Method,
	}
	if tokenValue.FilePath != "" {
		action = "preview_file"
		filePath := tokenValue.FilePath
		relativeRequest := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
		if relativeRequest != "" {
			filePath = pathpkg.Join(pathpkg.Dir(tokenValue.FilePath), relativeRequest)
		}
		input = map[string]any{
			"path":   filePath,
			"method": r.Method,
		}
	}
	result, err := s.requestWorkspace(
		r.Context(),
		tokenValue.SessionID,
		action,
		input,
	)
	if err != nil {
		writeError(w, r, http.StatusBadGateway, "WORKSPACE_PREVIEW_FAILED", err.Error())
		return
	}
	var preview struct {
		Status      int    `json:"status"`
		ContentType string `json:"contentType"`
		Location    string `json:"location"`
		Body        string `json:"body"`
	}
	if err := json.Unmarshal(result.Payload, &preview); err != nil {
		s.internalError(w, r, "decode workspace preview response", err)
		return
	}
	body, err := base64.StdEncoding.DecodeString(preview.Body)
	if err != nil {
		s.internalError(w, r, "decode workspace preview body", err)
		return
	}
	prefix := "/api/cloud/v1/preview/" + chi.URLParam(r, "token")
	body = rewritePreviewBody(body, preview.ContentType, prefix, tokenValue.Port)
	if preview.ContentType != "" {
		w.Header().Set("Content-Type", preview.ContentType)
	}
	setPreviewProxyHeaders(w)
	if preview.Location != "" {
		w.Header().Set("Location", rewritePreviewLocation(preview.Location, prefix, tokenValue.Port))
	}
	status := preview.Status
	if status < 100 || status > 599 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body) // #nosec G705 -- body is isolated inside a sandboxed, capability-scoped preview.
	}
}

func setPreviewProxyHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func (s *Server) runWorkspaceRequest(
	w http.ResponseWriter,
	r *http.Request,
	action string,
	input any,
) {
	_, session, ok := s.authorizedSession(w, r, "authorize workspace inspector request")
	if !ok {
		return
	}
	if !session.RuntimeConnected {
		writeError(w, r, http.StatusConflict, "WORKER_NOT_CONNECTED", "The worker is still starting.")
		return
	}
	result, err := s.requestWorkspace(r.Context(), session.ID, action, input)
	if err != nil {
		writeError(w, r, http.StatusBadGateway, "WORKSPACE_REQUEST_FAILED", err.Error())
		return
	}
	if len(result.Payload) == 0 || string(result.Payload) == "null" {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, result.Payload)
}

func (s *Server) requestWorkspace(
	ctx context.Context,
	sessionID clouddomain.SessionID,
	action string,
	input any,
) (workerRPCResponse, error) {
	encodedInput, err := json.Marshal(input)
	if err != nil {
		return workerRPCResponse{}, fmt.Errorf("encode workspace request: %w", err)
	}
	requestID := uuid.NewString()
	response, cancel := s.workerRPC.register(sessionID, requestID)
	defer cancel()
	err = s.workerHub.Send(sessionID, cloudworkerhub.Command{
		Type:      "workspace_request",
		RequestID: requestID,
		Action:    action,
		Data:      base64.StdEncoding.EncodeToString(encodedInput),
	})
	if err != nil {
		if errors.Is(err, cloudworkerhub.ErrWorkerBackpressure) {
			return workerRPCResponse{}, errors.New("the worker command queue is full")
		}
		return workerRPCResponse{}, fmt.Errorf("send workspace request: %w", err)
	}

	ctx, cancelWait := context.WithTimeout(ctx, 20*time.Second)
	defer cancelWait()
	select {
	case <-ctx.Done():
		return workerRPCResponse{}, errors.New("the worker did not respond in time")
	case result := <-response:
		if result.Error != "" {
			return workerRPCResponse{}, errors.New(result.Error)
		}
		return result, nil
	}
}

func rewritePreviewBody(body []byte, contentType, prefix string, port int) []byte {
	if !strings.Contains(contentType, "html") &&
		!strings.Contains(contentType, "javascript") &&
		!strings.Contains(contentType, "css") {
		return body
	}
	text := string(body)
	absoluteLocalhost := []string{
		fmt.Sprintf("http://localhost:%d", port),
		fmt.Sprintf("http://127.0.0.1:%d", port),
	}
	for _, origin := range absoluteLocalhost {
		text = strings.ReplaceAll(text, origin, prefix)
	}
	replacer := strings.NewReplacer(
		`src="/`, `src="`+prefix+`/`,
		`src='/`, `src='`+prefix+`/`,
		`href="/`, `href="`+prefix+`/`,
		`href='/`, `href='`+prefix+`/`,
		`action="/`, `action="`+prefix+`/`,
		`action='/`, `action='`+prefix+`/`,
		`from "/`, `from "`+prefix+`/`,
		`from '/`, `from '`+prefix+`/`,
		`import "/`, `import "`+prefix+`/`,
		`import '/`, `import '`+prefix+`/`,
		`import("/`, `import("`+prefix+`/`,
		`import('/`, `import('`+prefix+`/`,
		`url("/`, `url("`+prefix+`/`,
		`url('/`, `url('`+prefix+`/`,
		`url(/`, `url(`+prefix+`/`,
	)
	return []byte(replacer.Replace(text))
}

func rewritePreviewLocation(location, prefix string, port int) string {
	for _, origin := range []string{
		fmt.Sprintf("http://localhost:%d", port),
		fmt.Sprintf("http://127.0.0.1:%d", port),
	} {
		location = strings.ReplaceAll(location, origin, prefix)
	}
	if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, prefix) {
		return prefix + location
	}
	return location
}
