package envelope

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"
)

// APIError is the locked wire shape for every non-2xx response.
type APIError struct {
	Error     string         `json:"error"`
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"requestId,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

// WriteJSON serialises v as JSON with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteAPIError emits the locked envelope for any non-2xx response.
func WriteAPIError(w http.ResponseWriter, r *http.Request, status int, kind, code, message string, details map[string]any) {
	WriteJSON(w, status, APIError{
		Error:     kind,
		Code:      code,
		Message:   message,
		RequestID: middleware.GetReqID(r.Context()),
		Details:   details,
	})
}
