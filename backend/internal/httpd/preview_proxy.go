package httpd

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	previewutil "github.com/aoagents/agent-orchestrator/backend/internal/preview"
)

const (
	previewTargetHeader                = "X-AO-Preview-Target"
	previewRedirectTargetHeader        = "X-AO-Preview-Redirect-Target"
	previewUpstreamAuthorizationHeader = "X-AO-Preview-Upstream-Authorization"
	previewConnectionTimeout           = 30 * time.Second
	previewResponseHeaderTimeout       = 30 * time.Second
)

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
	requestPath, rawRequestPath, err := previewRequestSuffixPath(r)
	if err != nil {
		writePreviewProxyError(w, http.StatusBadRequest)
		return
	}
	if target.url.Scheme == "file" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writePreviewProxyError(w, http.StatusMethodNotAllowed)
			return
		}
		p.serveFile(w, r, workspace, resolvePreviewFileRequestPath(target.url.Path, requestPath))
		return
	}
	if (target.url.Path != "" && target.url.Path != "/") || target.url.RawQuery != "" {
		writePreviewProxyError(w, http.StatusBadRequest)
		return
	}
	if isPreviewBlockedTargetPath(pathpkg.Clean(requestPath)) {
		writePreviewProxyError(w, http.StatusBadRequest)
		return
	}
	p.serveLoopback(w, r, target.url, requestPath, rawRequestPath)
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
		filePath, ok := normalizePreviewFileURLPath(runtime.GOOS, u.Path)
		if u.Host != "" || u.Opaque != "" || u.RawQuery != "" || !ok {
			return previewTarget{}, errInvalidPreviewTarget
		}
		u.Scheme = "file"
		u.Path = filePath
	case "http", "https":
		if err := normalizeLoopbackPreviewURL(u); err != nil || isPreviewBlockedTargetPath(u.Path) {
			return previewTarget{}, errInvalidPreviewTarget
		}
	default:
		return previewTarget{}, errInvalidPreviewTarget
	}
	return previewTarget{url: u}, nil
}

func normalizePreviewFileURLPath(goos, raw string) (string, bool) {
	if goos == "windows" && isWindowsDriveURLPath(raw) {
		return strings.ReplaceAll(raw[1:], "/", `\`), true
	}
	if goos == "windows" {
		return "", false
	}
	if !isPOSIXAbsolutePreviewFileURLPath(raw) {
		return "", false
	}
	return raw, true
}

func isPOSIXAbsolutePreviewFileURLPath(raw string) bool {
	return strings.HasPrefix(raw, "/") && !isWindowsDriveURLPath(raw)
}

func isWindowsDriveURLPath(raw string) bool {
	return len(raw) >= 4 && raw[0] == '/' && isASCIILetter(raw[1]) && raw[2] == ':' && raw[3] == '/'
}

func isASCIILetter(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
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

func previewRequestSuffixPath(r *http.Request) (string, string, error) {
	routePath, ok := strings.CutPrefix(r.URL.EscapedPath(), "/_ao/preview/")
	if !ok {
		return "", "", errInvalidPreviewTarget
	}
	separator := strings.IndexByte(routePath, '/')
	if separator < 0 {
		return "", "", errInvalidPreviewTarget
	}
	sessionID, err := url.PathUnescape(routePath[:separator])
	if err != nil || sessionID != chi.URLParam(r, "sessionId") {
		return "", "", errInvalidPreviewTarget
	}
	rawPath := routePath[separator:]
	requestPath, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", "", errInvalidPreviewTarget
	}
	return requestPath, rawPath, nil
}

func (p previewProxy) serveLoopback(w http.ResponseWriter, r *http.Request, target *url.URL, requestPath, rawRequestPath string) {
	targetOrigin := &url.URL{Scheme: target.Scheme, Host: target.Host}
	transport := previewLoopbackTransport(targetOrigin)
	defer transport.CloseIdleConnections()
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.Out.URL.Scheme = targetOrigin.Scheme
			request.Out.URL.Host = targetOrigin.Host
			request.Out.URL.RawQuery = request.In.URL.RawQuery
			request.Out.Host = targetOrigin.Host
			request.Out.Header.Set("Origin", previewOrigin(targetOrigin))
			stripPreviewProxyRequestHeaders(request.Out)
		},
		ModifyResponse: func(response *http.Response) error {
			return mapPreviewRedirect(response, targetOrigin)
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			writePreviewProxyError(response, http.StatusBadGateway)
		},
	}
	proxyRequest := r.Clone(r.Context())
	requestURL := *r.URL
	requestURL.Path = requestPath
	requestURL.RawPath = rawRequestPath
	proxyRequest.URL = &requestURL
	proxy.ServeHTTP(w, proxyRequest)
}

func previewLoopbackTransport(target *url.URL) *http.Transport {
	dialHost := target.Hostname()
	if dialHost == "localhost" {
		dialHost = "127.0.0.1"
	}
	port := target.Port()
	if port == "" {
		if target.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	dialAddress := net.JoinHostPort(dialHost, port)
	baseTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		baseTransport = &http.Transport{}
	}
	transport := baseTransport.Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = previewResponseHeaderTimeout
	dialer := previewLoopbackDialer()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, dialAddress)
	}
	if target.Scheme == "https" {
		transport.TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true, //nolint:gosec // local development preview servers commonly use self-signed certificates
			ServerName:         target.Hostname(),
		}
	}
	return transport
}

func previewLoopbackDialer() *net.Dialer {
	return &net.Dialer{Timeout: previewConnectionTimeout}
}

func stripPreviewProxyRequestHeaders(r *http.Request) {
	upstreamAuthorization := r.Header.Get(previewUpstreamAuthorizationHeader)
	r.Header.Del("Authorization")
	for name := range r.Header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-ao-preview-") || strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" || lower == "x-real-ip" {
			r.Header.Del(name)
		}
	}
	if upstreamAuthorization != "" {
		r.Header.Set("Authorization", upstreamAuthorization)
	}
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, cookie := range cookies {
		if cookie.Name != "ao_conn" {
			r.AddCookie(cookie)
		}
	}
}

func mapPreviewRedirect(response *http.Response, target *url.URL) error {
	for name := range response.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-ao-preview-") {
			response.Header.Del(name)
		}
	}
	switch response.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
	default:
		return nil
	}
	location := response.Header.Get("Location")
	if location == "" {
		return nil
	}
	reference, err := url.Parse(location)
	if err != nil {
		return errInvalidPreviewRedirect
	}
	if reference.Scheme == "" && reference.Host == "" {
		return nil
	}
	redirect := response.Request.URL.ResolveReference(reference)
	redirect.Scheme = strings.ToLower(redirect.Scheme)
	if (redirect.Scheme != "http" && redirect.Scheme != "https") || redirect.Host == "" || redirect.User != nil {
		return errInvalidPreviewRedirect
	}
	redirectOrigin := &url.URL{Scheme: redirect.Scheme, Host: redirect.Host}
	if samePreviewOrigin(target, redirectOrigin) {
		return nil
	}
	if err := normalizeLoopbackPreviewURL(redirectOrigin); err != nil {
		if isLoopbackPreviewHostname(redirect.Hostname()) {
			return errInvalidPreviewRedirect
		}
		return nil
	}
	response.Header.Set(previewRedirectTargetHeader, previewOrigin(redirectOrigin))
	return nil
}

func isLoopbackPreviewHostname(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

func samePreviewOrigin(a, b *url.URL) bool {
	return a.Scheme == b.Scheme && a.Hostname() == b.Hostname() && previewPort(a) == previewPort(b)
}

func previewOrigin(u *url.URL) string {
	return (&url.URL{Scheme: u.Scheme, Host: u.Host}).String()
}

func previewPort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

func resolvePreviewFileRequestPath(entry, requestPath string) string {
	requestPath = strings.TrimPrefix(requestPath, "/")
	if requestPath == "" || requestPath == filepath.Base(entry) {
		return entry
	}
	return filepath.Join(filepath.Dir(entry), filepath.FromSlash(requestPath))
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
	defer func() { _ = root.Close() }()
	file, err := root.Open(rel)
	if err != nil {
		writePreviewProxyError(w, http.StatusNotFound)
		return
	}
	defer func() { _ = file.Close() }()
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

var (
	errInvalidPreviewTarget   = errors.New("invalid preview target")
	errInvalidPreviewRedirect = errors.New("invalid preview redirect")
)
