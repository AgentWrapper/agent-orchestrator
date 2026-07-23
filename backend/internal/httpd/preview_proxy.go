package httpd

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	previewutil "github.com/aoagents/agent-orchestrator/backend/internal/preview"
)

const previewTargetHeader = "X-AO-Preview-Target"

// PreviewSessionService supplies only the durable workspace required to serve a
// preview asset. It deliberately does not build a session display model.
type PreviewSessionService interface {
	GetPreviewWorkspace(ctx context.Context, id domain.SessionID) (string, error)
}

type previewProxy struct {
	sessions PreviewSessionService
}

type previewTarget struct {
	url *url.URL
}

func mountPreviewProxy(r chi.Router, sessions PreviewSessionService) {
	r.Handle("/_ao/preview/{sessionId}/*", previewProxy{sessions: sessions})
}

func (p previewProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writePreviewProxyError(w, http.StatusMethodNotAllowed)
		return
	}
	target, err := parsePreviewTarget(r.Header.Get(previewTargetHeader))
	if err != nil {
		writePreviewProxyError(w, http.StatusBadRequest)
		return
	}
	if p.sessions == nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	workspace, err := p.sessions.GetPreviewWorkspace(r.Context(), domain.SessionID(chi.URLParam(r, "sessionId")))
	if err != nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	if target.url.Scheme != "file" {
		writePreviewProxyError(w, http.StatusNotImplemented)
		return
	}
	p.serveFile(w, r, workspace, target.url.Path)
}

func parsePreviewTarget(raw string) (previewTarget, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return previewTarget{}, errInvalidPreviewTarget
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil || u.User != nil || u.Fragment != "" {
		return previewTarget{}, errInvalidPreviewTarget
	}
	switch strings.ToLower(u.Scheme) {
	case "file":
		if u.Host != "" || u.Opaque != "" || u.RawQuery != "" || !filepath.IsAbs(u.Path) {
			return previewTarget{}, errInvalidPreviewTarget
		}
		u.Scheme = "file"
	case "http", "https":
		if err := normalizeLoopbackPreviewURL(u); err != nil || isPreviewBlockedTargetPath(u.Path) {
			return previewTarget{}, errInvalidPreviewTarget
		}
	default:
		return previewTarget{}, errInvalidPreviewTarget
	}
	return previewTarget{url: u}, nil
}

func normalizeLoopbackPreviewURL(u *url.URL) error {
	if u.Host == "" || u.User != nil {
		return errInvalidPreviewTarget
	}
	host := u.Hostname()
	if host == "" {
		return errInvalidPreviewTarget
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.ParseUint(port, 10, 16)
		if err != nil || n == 0 {
			return errInvalidPreviewTarget
		}
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() {
			if ip.To4() != nil {
				host = "127.0.0.1"
			} else {
				host = "::1"
			}
		} else if !ip.IsLoopback() {
			return errInvalidPreviewTarget
		}
	} else if host != "localhost" {
		return errInvalidPreviewTarget
	}
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	}
	return nil
}

func isPreviewBlockedTargetPath(path string) bool {
	if isLANControlBlockedPath(path) {
		return true
	}
	return path == "/_ao/preview" || strings.HasPrefix(path, "/_ao/preview/")
}

func (p previewProxy) serveFile(w http.ResponseWriter, r *http.Request, workspace, targetPath string) {
	rel, err := filepath.Rel(workspace, targetPath)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	defer root.Close()
	file, err := root.Open(rel)
	if err != nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	if previewutil.IsMarkdownPath(rel) {
		p.serveMarkdown(w, r, file, filepath.Base(rel))
		return
	}
	http.ServeContent(w, r, filepath.Base(rel), info.ModTime(), file)
}

func (p previewProxy) serveMarkdown(w http.ResponseWriter, r *http.Request, file *os.File, name string) {
	source, err := io.ReadAll(file)
	if err != nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	rendered, err := previewutil.RenderMarkdown(source, name)
	if err != nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(rendered)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(rendered) //nolint:gosec // G705: preview content is workspace-local and agent-trusted
}

func writePreviewProxyError(w http.ResponseWriter, status int) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(http.StatusText(status)))
}

var errInvalidPreviewTarget = errors.New("invalid preview target")
