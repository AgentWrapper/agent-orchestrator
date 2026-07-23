package httpd

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type fakePreviewSessions struct {
	workspaces map[domain.SessionID]string
}

func (f fakePreviewSessions) GetPreviewWorkspace(_ context.Context, id domain.SessionID) (string, error) {
	workspace, ok := f.workspaces[id]
	if !ok {
		return "", apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return workspace, nil
}

func TestPreviewProxy_Validation(t *testing.T) {
	workspace := t.TempDir()
	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": workspace}},
	}, ControlDeps{})

	t.Run("missing target is bad request without internal details", func(t *testing.T) {
		rec := previewProxyRequest(router, http.MethodGet, "ao-1", "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
		if strings.Contains(rec.Body.String(), workspace) {
			t.Fatalf("response leaked workspace path: %q", rec.Body.String())
		}
	})

	t.Run("missing session is not found without service details", func(t *testing.T) {
		rec := previewProxyRequest(router, http.MethodGet, "missing", "file:///tmp/index.html")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
		}
		if strings.Contains(rec.Body.String(), "Unknown session") {
			t.Fatalf("response leaked service detail: %q", rec.Body.String())
		}
	})

	for _, raw := range []string{
		"ftp://127.0.0.1/",
		"http://example.com/",
		"http://192.168.1.10/",
		"http://user@localhost/",
		"http://[::1",
		"http://localhost/_ao/preview/ao-1/",
		"http://localhost/shutdown",
		"http://localhost/internal/telemetry/cli-invoked",
		"http://localhost/api/v1/mobile/status",
	} {
		t.Run(raw, func(t *testing.T) {
			rec := previewProxyRequest(router, http.MethodGet, "ao-1", raw)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			if strings.Contains(rec.Body.String(), raw) {
				t.Fatalf("response leaked target: %q", rec.Body.String())
			}
		})
	}

	for raw, want := range map[string]string{
		"http://0.0.0.0:5173/": "http://127.0.0.1:5173/",
		"http://[::]:5173/":    "http://[::1]:5173/",
	} {
		t.Run(raw+" normalizes to loopback", func(t *testing.T) {
			target, err := parsePreviewTarget(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got := target.url.String(); got != want {
				t.Fatalf("normalized target = %q, want %q", got, want)
			}
		})
	}
}

func TestPreviewProxy_ValidationRejectsWindowsFileURLOutsideWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file URLs are valid on Windows")
	}
	if _, err := parsePreviewTarget("file:///C:/workspace/index.html"); err == nil {
		t.Fatal("Windows file URL was accepted on a non-Windows platform")
	}
}

func TestNormalizePreviewFileURLPath(t *testing.T) {
	for _, tc := range []struct {
		name string
		goos string
		raw  string
		want string
		ok   bool
	}{
		{name: "POSIX path", goos: "darwin", raw: "/workspace/index.html", want: "/workspace/index.html", ok: true},
		{name: "Windows drive URL", goos: "windows", raw: "/C:/workspace/index.html", want: `C:\workspace\index.html`, ok: true},
		{name: "POSIX rejects Windows drive URL", goos: "darwin", raw: "/C:/workspace/index.html"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := normalizePreviewFileURLPath(tc.goos, tc.raw)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("normalizePreviewFileURLPath(%q, %q) = (%q, %v), want (%q, %v)", tc.goos, tc.raw, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestIsPOSIXAbsolutePreviewFileURLPath(t *testing.T) {
	for raw, want := range map[string]bool{
		"/workspace/index.html":    true,
		"workspace/index.html":     false,
		"/C:/workspace/index.html": false,
	} {
		if got := isPOSIXAbsolutePreviewFileURLPath(raw); got != want {
			t.Fatalf("isPOSIXAbsolutePreviewFileURLPath(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestPreviewProxy_Files(t *testing.T) {
	workspace := t.TempDir()
	writePreviewFile(t, filepath.Join(workspace, "index.html"), "<h1>hello</h1>")
	writePreviewFile(t, filepath.Join(workspace, "README.md"), "# Hello")
	if err := os.Mkdir(filepath.Join(workspace, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	writePreviewFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(workspace, "escape.txt")); err != nil {
		t.Fatal(err)
	}

	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": workspace}},
	}, ControlDeps{})

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method+" serves HTML", func(t *testing.T) {
			rec := previewProxyRequest(router, method, "ao-1", previewFileTarget(filepath.Join(workspace, "index.html")))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
				t.Fatalf("Content-Type = %q, want text/html", got)
			}
			if method == http.MethodGet && rec.Body.String() != "<h1>hello</h1>" {
				t.Fatalf("body = %q", rec.Body.String())
			}
			if method == http.MethodHead && rec.Body.Len() != 0 {
				t.Fatalf("HEAD body = %q, want empty", rec.Body.String())
			}
		})
	}

	t.Run("markdown is rendered", func(t *testing.T) {
		rec := previewProxyRequest(router, http.MethodGet, "ao-1", previewFileTarget(filepath.Join(workspace, "README.md")))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		if !strings.Contains(rec.Body.String(), "<h1>Hello</h1>") {
			t.Fatalf("markdown response = %q, want rendered heading", rec.Body.String())
		}
	})

	for _, raw := range []string{
		previewFileTarget(filepath.Join(workspace, "missing.html")),
		previewFileTarget(filepath.Join(workspace, "assets")),
		previewFileTarget(outside),
		previewFileTarget(filepath.Join(workspace, "escape.txt")),
	} {
		t.Run(raw+" is not served", func(t *testing.T) {
			rec := previewProxyRequest(router, http.MethodGet, "ao-1", raw)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
			}
			if strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), workspace) {
				t.Fatalf("response leaked file detail: %q", rec.Body.String())
			}
		})
	}

	rec := previewProxyRequest(router, http.MethodPost, "ao-1", previewFileTarget(filepath.Join(workspace, "index.html")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestPreviewProxy_FilesResolveRequestPathRelativeToEntry(t *testing.T) {
	workspace := t.TempDir()
	entry := filepath.Join(workspace, "dist", "index.html")
	writePreviewFile(t, entry, "entry")
	writePreviewFile(t, filepath.Join(workspace, "dist", "assets", "app.css"), "asset")
	outside := filepath.Join(t.TempDir(), "secret.css")
	writePreviewFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(workspace, "dist", "assets", "escape.css")); err != nil {
		t.Fatal(err)
	}

	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": workspace}},
	}, ControlDeps{})

	for _, tc := range []struct {
		name        string
		requestPath string
		wantStatus  int
		wantBody    string
	}{
		{name: "entry path", requestPath: "/index.html", wantStatus: http.StatusOK, wantBody: "entry"},
		{name: "asset path", requestPath: "/assets/app.css", wantStatus: http.StatusOK, wantBody: "asset"},
		{name: "encoded asset path", requestPath: "/assets%2Fapp.css", wantStatus: http.StatusOK, wantBody: "asset"},
		{name: "asset symlink escape", requestPath: "/assets/escape.css", wantStatus: http.StatusNotFound},
		{name: "parent traversal escape", requestPath: "/../../secret.css", wantStatus: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := previewProxyRequestPath(router, http.MethodGet, "ao-1", previewFileTarget(entry), tc.requestPath)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Fatalf("body = %q, want %q", rec.Body.String(), tc.wantBody)
			}
			if strings.Contains(rec.Body.String(), "secret") {
				t.Fatalf("response leaked escaped asset: %q", rec.Body.String())
			}
		})
	}
}

func TestPreviewProxy_HTTP(t *testing.T) {
	type observedRequest struct {
		method        string
		path          string
		rawQuery      string
		body          string
		host          string
		origin        string
		authorization string
		cookie        string
		previewSecret string
		forwarded     string
		forwardedFor  string
		realIP        string
		appHeader     string
	}
	observed := make(chan observedRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		observed <- observedRequest{
			method:        r.Method,
			path:          r.URL.Path,
			rawQuery:      r.URL.RawQuery,
			body:          string(body),
			host:          r.Host,
			origin:        r.Header.Get("Origin"),
			authorization: r.Header.Get("Authorization"),
			cookie:        r.Header.Get("Cookie"),
			previewSecret: r.Header.Get("X-AO-Preview-Secret"),
			forwarded:     r.Header.Get("Forwarded"),
			forwardedFor:  r.Header.Get("X-Forwarded-For"),
			realIP:        r.Header.Get("X-Real-IP"),
			appHeader:     r.Header.Get("X-App-Header"),
		}
		w.Header().Set("X-Upstream", "preserved")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("upstream response"))
	}))
	defer upstream.Close()
	target := previewTargetWithHostname(t, upstream.URL, "localhost")
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	req, err := http.NewRequest(http.MethodPatch, daemon.URL+"/_ao/preview/ao-1/api/items?color=blue&n=2", strings.NewReader("request body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, target)
	req.Header.Set("Origin", "http://127.0.0.1:4173")
	req.Header.Set("Authorization", "Bearer ao-secret")
	req.Header.Set("Cookie", "ao_conn=daemon-secret; app_session=keep")
	req.Header.Set("X-AO-Preview-Secret", "internal")
	req.Header.Set("Forwarded", "for=192.0.2.1")
	req.Header.Set("X-Forwarded-For", "192.0.2.2")
	req.Header.Set("X-Real-IP", "192.0.2.3")
	req.Header.Set("X-App-Header", "preserve me")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %q", resp.StatusCode, http.StatusCreated, body)
	}
	if got := resp.Header.Get("X-Upstream"); got != "preserved" {
		t.Fatalf("X-Upstream = %q, want preserved", got)
	}
	if got := string(body); got != "upstream response" {
		t.Fatalf("body = %q, want upstream response", got)
	}

	got := <-observed
	targetURL, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	if got.method != http.MethodPatch || got.path != "/api/items" || got.rawQuery != "color=blue&n=2" || got.body != "request body" {
		t.Fatalf("upstream request = %#v", got)
	}
	if got.host != targetURL.Host || got.origin != targetURL.Scheme+"://"+targetURL.Host {
		t.Fatalf("upstream host/origin = %q / %q, want %q", got.host, got.origin, targetURL.Scheme+"://"+targetURL.Host)
	}
	if got.authorization != "" || got.previewSecret != "" || got.forwarded != "" || got.forwardedFor != "" || got.realIP != "" {
		t.Fatalf("internal headers reached upstream: %#v", got)
	}
	if got.cookie != "app_session=keep" {
		t.Fatalf("Cookie = %q, want app_session=keep", got.cookie)
	}
	if got.appHeader != "preserve me" {
		t.Fatalf("X-App-Header = %q, want preserve me", got.appHeader)
	}
}

func TestPreviewProxy_HTTPAuthorization(t *testing.T) {
	type observedAuthorization struct {
		authorization         string
		internalAuthorization string
	}
	observed := make(chan observedAuthorization, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- observedAuthorization{
			authorization:         r.Header.Get("Authorization"),
			internalAuthorization: r.Header.Get("X-AO-Preview-Upstream-Authorization"),
		}
		w.Header().Set("X-AO-Preview-Upstream-Authorization", "must-not-leak")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	for _, tc := range []struct {
		name                 string
		browserAuthorization string
		wantAuthorization    string
	}{
		{name: "Basic browser authorization", browserAuthorization: "Basic dXNlcjpwYXNz", wantAuthorization: "Basic dXNlcjpwYXNz"},
		{name: "Bearer browser authorization", browserAuthorization: "Bearer browser-token", wantAuthorization: "Bearer browser-token"},
		{name: "no browser authorization"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1/private", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set(previewTargetHeader, upstream.URL)
			req.Header.Set("Authorization", "Bearer daemon-connection-password")
			if tc.browserAuthorization != "" {
				req.Header.Set("X-AO-Preview-Upstream-Authorization", tc.browserAuthorization)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusNoContent {
				t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
			}
			if got := resp.Header.Get("X-AO-Preview-Upstream-Authorization"); got != "" {
				t.Fatalf("internal response header leaked: %q", got)
			}
			got := <-observed
			if got.authorization != tc.wantAuthorization {
				t.Fatalf("upstream Authorization = %q, want %q", got.authorization, tc.wantAuthorization)
			}
			if got.internalAuthorization != "" {
				t.Fatalf("internal authorization header reached upstream: %q", got.internalAuthorization)
			}
		})
	}
}

func TestPreviewProxy_SetsUpstreamOriginWithoutIncomingOrigin(t *testing.T) {
	upstreamOrigin := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamOrigin <- r.Header.Get("Origin")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1/origin", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, upstream.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := <-upstreamOrigin; got != upstream.URL {
		t.Fatalf("upstream Origin = %q, want %q", got, upstream.URL)
	}
}

func TestPreviewProxy_PreservesRawQuery(t *testing.T) {
	const wantQuery = "a=1;b=2&x=%2F"
	upstreamQuery := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamQuery <- r.URL.RawQuery
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1/query?"+wantQuery, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, upstream.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := <-upstreamQuery; got != wantQuery {
		t.Fatalf("upstream RawQuery = %q, want %q", got, wantQuery)
	}
}

func TestPreviewProxy_PreservesEscapedPath(t *testing.T) {
	const wantRequestURI = "/assets/a%2Fb%20c%3Fd.js"
	upstreamRequestURI := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequestURI <- r.RequestURI
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1"+wantRequestURI, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, upstream.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := <-upstreamRequestURI; got != wantRequestURI {
		t.Fatalf("upstream RequestURI = %q, want %q", got, wantRequestURI)
	}
}

func TestPreviewProxy_HTTPRedirects(t *testing.T) {
	var targetOrigin string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/relative":
			w.Header().Set("Location", "/next")
		case "/same-origin":
			w.Header().Set("Location", targetOrigin+"/next")
		case "/cross-loopback":
			w.Header().Set("Location", "http://127.0.0.1:43210/next?q=1")
		case "/public":
			w.Header().Set("Location", "https://example.com/next")
		case "/lan":
			w.Header().Set("Location", "http://192.168.1.10/next")
		case "/unsupported":
			w.Header().Set("Location", "file:///tmp/secret")
		case "/invalid-loopback":
			w.Header().Set("Location", "http://127.0.0.1:0/next")
		}
		w.WriteHeader(http.StatusFound)
	}))
	defer upstream.Close()
	targetOrigin = previewTargetWithHostname(t, upstream.URL, "localhost")
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

	for _, tc := range []struct {
		name           string
		path           string
		wantStatus     int
		wantLocation   string
		wantRedirectTo string
	}{
		{name: "relative stays ordinary", path: "/relative", wantStatus: http.StatusFound, wantLocation: "/next"},
		{name: "same origin stays ordinary", path: "/same-origin", wantStatus: http.StatusFound, wantLocation: targetOrigin + "/next"},
		{name: "cross loopback is mapped", path: "/cross-loopback", wantStatus: http.StatusFound, wantLocation: "http://127.0.0.1:43210/next?q=1", wantRedirectTo: "http://127.0.0.1:43210"},
		{name: "public stays ordinary", path: "/public", wantStatus: http.StatusFound, wantLocation: "https://example.com/next"},
		{name: "LAN stays ordinary", path: "/lan", wantStatus: http.StatusFound, wantLocation: "http://192.168.1.10/next"},
		{name: "unsupported fails closed", path: "/unsupported", wantStatus: http.StatusBadGateway},
		{name: "invalid loopback fails closed", path: "/invalid-loopback", wantStatus: http.StatusBadGateway},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1"+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set(previewTargetHeader, targetOrigin)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if got := resp.Header.Get("Location"); got != tc.wantLocation {
				t.Fatalf("Location = %q, want %q", got, tc.wantLocation)
			}
			if got := resp.Header.Get("X-AO-Preview-Redirect-Target"); got != tc.wantRedirectTo {
				t.Fatalf("X-AO-Preview-Redirect-Target = %q, want %q", got, tc.wantRedirectTo)
			}
		})
	}
}

func TestPreviewProxy_StripsUpstreamPreviewResponseHeaders(t *testing.T) {
	var targetOrigin string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(previewRedirectTargetHeader, "http://127.0.0.1:1")
		w.Header().Set("X-AO-Preview-Upstream-Secret", "leak")
		switch r.URL.Path {
		case "/ok":
			w.WriteHeader(http.StatusOK)
		case "/ok-location":
			w.Header().Set("Location", "http://127.0.0.1:43210/next")
			w.WriteHeader(http.StatusOK)
		case "/error-location":
			w.Header().Set("Location", "http://127.0.0.1:43210/next")
			w.WriteHeader(http.StatusNotFound)
		case "/same-origin":
			w.Header().Set("Location", targetOrigin+"/next")
			w.WriteHeader(http.StatusFound)
		case "/cross-loopback":
			w.Header().Set("Location", "http://127.0.0.1:43210/next")
			w.WriteHeader(http.StatusFound)
		}
	}))
	defer upstream.Close()
	targetOrigin = previewTargetWithHostname(t, upstream.URL, "localhost")
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

	for _, tc := range []struct {
		path               string
		wantLocation       string
		wantRedirectTarget string
	}{
		{path: "/ok"},
		{path: "/ok-location", wantLocation: "http://127.0.0.1:43210/next"},
		{path: "/error-location", wantLocation: "http://127.0.0.1:43210/next"},
		{path: "/same-origin", wantLocation: targetOrigin + "/next"},
		{path: "/cross-loopback", wantLocation: "http://127.0.0.1:43210/next", wantRedirectTarget: "http://127.0.0.1:43210"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1"+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set(previewTargetHeader, targetOrigin)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if got := resp.Header.Get("Location"); got != tc.wantLocation {
				t.Fatalf("Location = %q, want %q", got, tc.wantLocation)
			}
			if got := resp.Header.Get(previewRedirectTargetHeader); got != tc.wantRedirectTarget {
				t.Fatalf("%s = %q, want %q", previewRedirectTargetHeader, got, tc.wantRedirectTarget)
			}
			if got := resp.Header.Get("X-AO-Preview-Upstream-Secret"); got != "" {
				t.Fatalf("upstream internal response header leaked: %q", got)
			}
		})
	}
}

func TestPreviewProxy_HTTPRejectsNonOriginTargetsAndBlockedSuffixes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("blocked preview request reached upstream")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	for _, tc := range []struct {
		name   string
		target string
		path   string
	}{
		{name: "target path", target: upstream.URL + "/base", path: "/asset.js"},
		{name: "target query", target: upstream.URL + "?base=1", path: "/asset.js"},
		{name: "recursive suffix", target: upstream.URL, path: "/_ao/preview/ao-1/asset.js"},
		{name: "control suffix", target: upstream.URL, path: "/shutdown"},
		{name: "encoded cleaned recursive suffix", target: upstream.URL, path: "/%2F_ao%2Fpreview%2Fao-1/asset.js"},
		{name: "encoded cleaned control suffix", target: upstream.URL, path: "/%2Fshutdown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1"+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set(previewTargetHeader, tc.target)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusBadRequest)
			}
		})
	}
}

func TestPreviewProxy_Streaming(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-time.After(3 * time.Second):
		}
		_, _ = w.Write([]byte("second\n"))
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, upstream.URL)
	ctx, cancel := context.WithTimeout(req.Context(), 2*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	first, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if first != "first\n" {
		t.Fatalf("first streamed chunk = %q", first)
	}
	close(release)
	rest, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(rest); got != "second\n" {
		t.Fatalf("remaining stream = %q", got)
	}
}

func TestPreviewProxy_HTTPS(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/secure" {
			t.Errorf("path = %q, want /secure", r.URL.Path)
		}
		_, _ = w.Write([]byte("secure response"))
	}))
	defer upstream.Close()
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()
	target := previewTargetWithHostname(t, upstream.URL, "localhost")

	req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1/secure", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, target)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || string(body) != "secure response" {
		t.Fatalf("status/body = %d / %q", resp.StatusCode, body)
	}
}

func TestPreviewLoopbackTransport_ResponseHeaderTimeout(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	defer close(release)
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := previewLoopbackTransport(target)
	defer transport.CloseIdleConnections()
	if got := transport.ResponseHeaderTimeout; got != 30*time.Second {
		t.Fatalf("ResponseHeaderTimeout = %s, want 30s", got)
	}

	transport.ResponseHeaderTimeout = 25 * time.Millisecond
	client := &http.Client{Transport: transport}
	started := time.Now()
	resp, err := client.Get(upstream.URL)
	if resp != nil {
		defer resp.Body.Close()
	}
	if err == nil {
		t.Fatal("request unexpectedly received response headers")
	}
	if elapsed := time.Since(started); elapsed >= 250*time.Millisecond {
		t.Fatalf("response header timeout took %s, want less than 250ms", elapsed)
	}
}

func TestPreviewProxy_WebSocket(t *testing.T) {
	upstreamResult := make(chan error, 1)
	var targetOrigin string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/socket" || r.URL.RawQuery != "room=one" {
			upstreamResult <- fmt.Errorf("unexpected upstream path/query: %s", r.URL.RequestURI())
			return
		}
		if got := r.Header.Get("Origin"); got != targetOrigin {
			upstreamResult <- fmt.Errorf("upstream Origin = %q, want %q", got, targetOrigin)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer browser-token" {
			upstreamResult <- fmt.Errorf("upstream Authorization = %q, want browser token", got)
			return
		}
		if got := r.Header.Get("X-AO-Preview-Upstream-Authorization"); got != "" {
			upstreamResult <- fmt.Errorf("internal authorization header reached upstream: %q", got)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			upstreamResult <- err
			return
		}
		defer conn.CloseNow()
		messageType, payload, err := conn.Read(r.Context())
		if err == nil {
			err = conn.Write(r.Context(), messageType, append([]byte("echo:"), payload...))
		}
		upstreamResult <- err
	}))
	defer upstream.Close()
	targetOrigin = upstream.URL
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(daemon.URL, "http") + "/_ao/preview/ao-1/socket?room=one"
	conn, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{
		previewTargetHeader:                   []string{upstream.URL},
		"Authorization":                       []string{"Bearer daemon-connection-password"},
		"X-AO-Preview-Upstream-Authorization": []string{"Bearer browser-token"},
	}})
	if err != nil {
		if resp != nil {
			defer resp.Body.Close()
			t.Fatalf("WebSocket dial failed with status %d: %v", resp.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	messageType, payload, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if messageType != websocket.MessageText || string(payload) != "echo:hello" {
		t.Fatalf("echo frame = %v %q", messageType, payload)
	}
	if err := <-upstreamResult; err != nil {
		t.Fatal(err)
	}
}

func TestPreviewProxy_UpstreamFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := "http://" + listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	daemon := newPreviewProxyTestServer(t)
	defer daemon.Close()

	req, err := http.NewRequest(http.MethodGet, daemon.URL+"/_ao/preview/ao-1/unreachable", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(previewTargetHeader, target)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusBadGateway)
	}
	if got := string(body); got != http.StatusText(http.StatusBadGateway) {
		t.Fatalf("body = %q, want generic %q", got, http.StatusText(http.StatusBadGateway))
	}
	if strings.Contains(string(body), listener.Addr().String()) || strings.Contains(strings.ToLower(string(body)), "connect") {
		t.Fatalf("response leaked dial detail: %q", body)
	}
}

func newPreviewProxyTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	router := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{
		PreviewSessions: fakePreviewSessions{workspaces: map[domain.SessionID]string{"ao-1": t.TempDir()}},
	}, ControlDeps{})
	return httptest.NewServer(router)
}

func previewTargetWithHostname(t *testing.T, raw, hostname string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	u.Host = net.JoinHostPort(hostname, u.Port())
	return u.String()
}

func previewProxyRequest(router http.Handler, method, sessionID, target string) *httptest.ResponseRecorder {
	return previewProxyRequestPath(router, method, sessionID, target, "/")
}

func previewProxyRequestPath(router http.Handler, method, sessionID, target, requestPath string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/_ao/preview/"+sessionID+requestPath, nil)
	if target != "" {
		req.Header.Set("X-AO-Preview-Target", target)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func previewFileTarget(file string) string {
	return (&url.URL{Scheme: "file", Path: file}).String()
}

func writePreviewFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
