package controllers

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

type ambiguousDirectoryPathError struct{}

func (ambiguousDirectoryPathError) Error() string { return "ambiguous directory path error" }

func (ambiguousDirectoryPathError) Is(target error) bool {
	return target == fs.ErrNotExist || target == syscall.ENOTDIR
}

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
	missingParent := filepath.Join(t.TempDir(), "missing")
	fileParent := filepath.Join(t.TempDir(), "parent-file")
	if err := os.WriteFile(fileParent, []byte("file"), 0o644); err != nil {
		t.Fatalf("write parent file: %v", err)
	}
	ambiguousErr := ambiguousDirectoryPathError{}

	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		hiddenText string
	}{
		{name: "exists", err: fs.ErrExist, wantStatus: http.StatusConflict, wantCode: "DIRECTORY_ALREADY_EXISTS"},
		{name: "permission", err: fs.ErrPermission, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
		{name: "read only", err: syscall.EROFS, wantStatus: http.StatusForbidden, wantCode: "DIRECTORY_PERMISSION_DENIED"},
		{name: "missing", err: fs.ErrNotExist, wantStatus: http.StatusNotFound, wantCode: "DIRECTORY_NOT_FOUND"},
		{
			name:       "not directory",
			err:        &fs.PathError{Op: "mkdir", Path: filepath.Join(fileParent, "child"), Err: syscall.ENOTDIR},
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "NOT_A_DIRECTORY",
		},
		{
			name:       "ambiguous error with missing parent",
			err:        &fs.PathError{Op: "mkdir", Path: filepath.Join(missingParent, "child"), Err: ambiguousErr},
			wantStatus: http.StatusNotFound,
			wantCode:   "DIRECTORY_NOT_FOUND",
			hiddenText: missingParent,
		},
		{
			name:       "ambiguous error with file parent",
			err:        &fs.PathError{Op: "mkdir", Path: filepath.Join(fileParent, "child"), Err: ambiguousErr},
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "NOT_A_DIRECTORY",
			hiddenText: fileParent,
		},
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
			if tt.hiddenText != "" && strings.Contains(rec.Body.String(), tt.hiddenText) {
				t.Fatalf("response exposes parent path %q: %s", tt.hiddenText, rec.Body.String())
			}
			if tt.hiddenText != "" && strings.Contains(rec.Body.String(), ambiguousErr.Error()) {
				t.Fatalf("response exposes raw error: %s", rec.Body.String())
			}
		})
	}
}
