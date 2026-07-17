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
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// FilesystemController owns the /filesystem routes.
type FilesystemController struct{}

// Register mounts the remote directory routes on the supplied router.
func (c *FilesystemController) Register(r chi.Router) {
	r.Get("/filesystem/directories", c.listDirectories)
	r.Post("/filesystem/directories", c.createDirectory)
}

func (c *FilesystemController) createDirectory(w http.ResponseWriter, r *http.Request) {
	var in CreateDirectoryRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if !filepath.IsAbs(in.ParentPath) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "ABSOLUTE_PATH_REQUIRED", "Parent path must be absolute", nil)
		return
	}
	if !validDirectoryName(in.Name) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_DIRECTORY_NAME", "Directory name is invalid", nil)
		return
	}
	parent := filepath.Clean(in.ParentPath)
	target := filepath.Join(parent, in.Name)
	//nolint:gosec // G301: user-created project directories intentionally use standard 0755 permissions, subject to the daemon user's umask.
	if err := os.Mkdir(target, 0o755); err != nil {
		writeDirectoryCreateError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, DirectoryEntry{Name: in.Name, Path: target})
}

func validDirectoryName(name string) bool {
	return name != "" && strings.TrimSpace(name) == name && name != "." && name != ".." &&
		!strings.ContainsRune(name, 0) && !strings.ContainsAny(name, `/\\`)
}

func (c *FilesystemController) listDirectories(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	path := query.Get("path")
	if !query.Has("path") {
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
		Origin:      directoryGitOrigin(path),
		Directories: directories,
	})
}

func directoryGitOrigin(path string) string {
	out, err := aoprocess.Command("git", "-C", path, "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
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

func writeDirectoryCreateError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, fs.ErrExist):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "DIRECTORY_ALREADY_EXISTS", "Directory already exists", nil)
	case errors.Is(err, fs.ErrPermission), errors.Is(err, syscall.EROFS):
		envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "DIRECTORY_PERMISSION_DENIED", "Directory permission denied", nil)
	case errors.Is(err, fs.ErrNotExist) && errors.Is(err, syscall.ENOTDIR):
		if directoryCreateParentIsNotDirectory(err) {
			envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "NOT_A_DIRECTORY", "Path is not a directory", nil)
			return
		}
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "DIRECTORY_NOT_FOUND", "Directory not found", nil)
	case errors.Is(err, fs.ErrNotExist):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "DIRECTORY_NOT_FOUND", "Directory not found", nil)
	case errors.Is(err, syscall.ENOTDIR):
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "NOT_A_DIRECTORY", "Path is not a directory", nil)
	default:
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "DIRECTORY_CREATE_FAILED", "Directory create failed", nil)
	}
}

// Windows uses ERROR_PATH_NOT_FOUND for both missing path components and a
// non-directory parent. Inspect the nearest existing component to disambiguate.
func directoryCreateParentIsNotDirectory(err error) bool {
	var pathErr *fs.PathError
	if !errors.As(err, &pathErr) {
		return false
	}

	parent := filepath.Dir(pathErr.Path)
	for {
		info, statErr := os.Stat(parent)
		if statErr == nil {
			return !info.IsDir()
		}
		if !errors.Is(statErr, fs.ErrNotExist) && !errors.Is(statErr, syscall.ENOTDIR) {
			return false
		}
		next := filepath.Dir(parent)
		if next == parent {
			return false
		}
		parent = next
	}
}
