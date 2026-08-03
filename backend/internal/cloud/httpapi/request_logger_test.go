package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

func TestRequestLoggerRecordsSafeRequestMetadata(t *testing.T) {
	var output bytes.Buffer
	server := &Server{
		log: slog.New(slog.NewJSONHandler(&output, nil)),
	}
	handler := middleware.RequestID(server.requestLogger(http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte("ok"))
		},
	)))
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/sessions/session-one/messages?secret=hidden", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatalf("decode request log: %v", err)
	}
	if entry["msg"] != "AO Cloud request completed" ||
		entry["method"] != http.MethodPost ||
		entry["path"] != "/api/cloud/v1/sessions/session-one/messages" ||
		entry["status"] != float64(http.StatusAccepted) ||
		entry["bytes"] != float64(2) {
		t.Fatalf("request log = %#v", entry)
	}
	if entry["request_id"] == "" {
		t.Fatalf("request log has no request ID: %#v", entry)
	}
	if bytes.Contains(output.Bytes(), []byte("secret")) ||
		bytes.Contains(output.Bytes(), []byte("hidden")) {
		t.Fatalf("request log included query data: %s", output.String())
	}
}

func TestRequestLoggerSuppressesSuccessfulHealthChecks(t *testing.T) {
	var output bytes.Buffer
	server := &Server{
		log: slog.New(slog.NewJSONHandler(&output, nil)),
	}
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	server.requestLogger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(response, request)

	if output.Len() != 0 {
		t.Fatalf("health request log = %s", output.String())
	}
}

func TestRequestLoggerRedactsFailedPreviewTokens(t *testing.T) {
	var output bytes.Buffer
	server := &Server{
		log: slog.New(slog.NewJSONHandler(&output, nil)),
	}
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/preview/private-capability/src/main.js",
		nil,
	)
	response := httptest.NewRecorder()

	server.requestLogger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "failed", http.StatusBadGateway)
	})).ServeHTTP(response, request)

	if bytes.Contains(output.Bytes(), []byte("private-capability")) {
		t.Fatalf("request log included preview token: %s", output.String())
	}
	if !bytes.Contains(output.Bytes(), []byte("/api/cloud/v1/preview/[redacted]")) {
		t.Fatalf("request log did not include redacted preview path: %s", output.String())
	}
}

func TestRequestLoggerRedactsShareTokens(t *testing.T) {
	var output bytes.Buffer
	server := &Server{
		log: slog.New(slog.NewJSONHandler(&output, nil)),
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/cloud/v1/share-links/private-share-token/redeem",
		nil,
	)
	response := httptest.NewRecorder()

	server.requestLogger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "failed", http.StatusUnauthorized)
	})).ServeHTTP(response, request)

	if bytes.Contains(output.Bytes(), []byte("private-share-token")) {
		t.Fatalf("request log included share token: %s", output.String())
	}
	if !bytes.Contains(output.Bytes(), []byte("/api/cloud/v1/share-links/[redacted]")) {
		t.Fatalf("request log did not include redacted share path: %s", output.String())
	}
}
