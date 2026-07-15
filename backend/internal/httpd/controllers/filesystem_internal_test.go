package controllers

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

func TestFilesystemErrorMapper(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "permission denied", err: fs.ErrPermission, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
		{name: "unexpected", err: errors.New("unexpected read failure"), wantStatus: http.StatusInternalServerError, wantCode: "DIRECTORY_READ_FAILED"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/api/v1/filesystem/directories", nil)

			writeFilesystemError(rec, req, tt.err)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			var got envelope.APIError
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode error envelope: %v", err)
			}
			if got.Code != tt.wantCode {
				t.Fatalf("code = %q, want %q; body=%s", got.Code, tt.wantCode, rec.Body.String())
			}
		})
	}
}
