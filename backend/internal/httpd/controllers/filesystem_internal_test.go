package controllers

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"syscall"
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

func TestFilesystemCreateErrorMapper(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "exists", err: fs.ErrExist, wantStatus: http.StatusConflict, wantCode: "DIRECTORY_ALREADY_EXISTS"},
		{name: "permission", err: fs.ErrPermission, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
		{name: "read only", err: syscall.EROFS, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
		{name: "missing", err: fs.ErrNotExist, wantStatus: http.StatusNotFound, wantCode: "DIRECTORY_NOT_FOUND"},
		{name: "not directory", err: syscall.ENOTDIR, wantStatus: http.StatusUnprocessableEntity, wantCode: "NOT_A_DIRECTORY"},
		{name: "unexpected", err: errors.New("boom"), wantStatus: http.StatusInternalServerError, wantCode: "DIRECTORY_CREATE_FAILED"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/filesystem/directories", nil)

			writeDirectoryCreateError(rec, req, tt.err)

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
