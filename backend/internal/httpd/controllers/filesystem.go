package controllers

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// FilesystemController owns the read-only /filesystem routes.
type FilesystemController struct{}

// Register mounts the remote directory browsing route on the supplied router.
func (c *FilesystemController) Register(r chi.Router) {
	r.Get("/filesystem/directories", c.listDirectories)
}

func (c *FilesystemController) listDirectories(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		var err error
		path, err = os.UserHomeDir()
		if err != nil {
			writeFilesystemError(w, r, err)
			return
		}
	} else if !filepath.IsAbs(path) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "ABSOLUTE_PATH_REQUIRED", "Path must be absolute", nil)
		return
	}

	path = filepath.Clean(path)
	entries, err := os.ReadDir(path)
	if err != nil {
		writeFilesystemError(w, r, err)
		return
	}

	directories := make([]DirectoryEntry, 0)
	for _, entry := range entries {
		isDir := entry.IsDir()
		if entry.Type()&fs.ModeSymlink != 0 {
			info, err := os.Stat(filepath.Join(path, entry.Name()))
			if err != nil {
				continue
			}
			isDir = info.IsDir()
		}
		if isDir {
			directories = append(directories, DirectoryEntry{
				Name: entry.Name(),
				Path: filepath.Join(path, entry.Name()),
			})
		}
	}
	sort.Slice(directories, func(i, j int) bool {
		left, right := strings.ToLower(directories[i].Name), strings.ToLower(directories[j].Name)
		if left == right {
			return directories[i].Name < directories[j].Name
		}
		return left < right
	})

	var parent *string
	if candidate := filepath.Dir(path); candidate != path {
		parent = &candidate
	}
	envelope.WriteJSON(w, http.StatusOK, ListDirectoriesResponse{
		Path:        path,
		Parent:      parent,
		Directories: directories,
	})
}

func writeFilesystemError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, fs.ErrPermission):
		envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "DIRECTORY_PERMISSION_DENIED", "Directory permission denied", nil)
	case errors.Is(err, fs.ErrNotExist):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "DIRECTORY_NOT_FOUND", "Directory not found", nil)
	case errors.Is(err, syscall.ENOTDIR):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "NOT_A_DIRECTORY", "Path is not a directory", nil)
	default:
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "DIRECTORY_READ_FAILED", "Directory read failed", nil)
	}
}
