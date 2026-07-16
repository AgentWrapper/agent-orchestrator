package gitlab

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClientAuthAndEncodedProjectPath(t *testing.T) {
	t.Parallel()
	var gotPath, gotToken, gotAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotToken = r.Header.Get("PRIVATE-TOKEN")
		gotAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":1}`))
	}))
	defer server.Close()

	client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("test-token")})
	var result struct {
		ID int `json:"id"`
	}
	_, err := client.DoJSON(context.Background(), http.MethodGet, "/projects/"+EncodedProjectPath("group/subgroup/project"), nil, nil, &result)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/projects/group%2Fsubgroup%2Fproject" {
		t.Fatalf("escaped path = %q", gotPath)
	}
	if gotToken != "test-token" {
		t.Fatalf("PRIVATE-TOKEN = %q", gotToken)
	}
	if gotAgent != defaultUserAgent {
		t.Fatalf("User-Agent = %q", gotAgent)
	}
	if result.ID != 1 {
		t.Fatalf("decoded ID = %d", result.ID)
	}
}

func TestClientDefaultTimeout(t *testing.T) {
	t.Parallel()
	client := NewClient(ClientOptions{})
	if client.http.Timeout != 30*time.Second {
		t.Fatalf("timeout = %s", client.http.Timeout)
	}
	injected := NewClient(ClientOptions{HTTPClient: &http.Client{}})
	if injected.http.Timeout != 30*time.Second {
		t.Fatalf("injected client timeout = %s", injected.http.Timeout)
	}
}

func TestClientRejectsUnsafeBaseURLs(t *testing.T) {
	t.Parallel()
	for _, baseURL := range []string{"https://%", "http://gitlab.example.com/api/v4", "https://user:pass@gitlab.example.com/api/v4?token=bad"} {
		t.Run(baseURL, func(t *testing.T) {
			client := NewClient(ClientOptions{BaseURL: baseURL, Token: StaticTokenSource("must-not-send")})
			_, err := client.DoJSON(context.Background(), http.MethodGet, "/user", nil, nil, nil)
			if !errors.Is(err, ErrInvalidBaseURL) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestClientRefusesCrossOriginRedirectWithoutLeakingToken(t *testing.T) {
	t.Parallel()
	var leaked string
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = r.Header.Get("PRIVATE-TOKEN")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", destination.URL+"/stolen")
		w.WriteHeader(http.StatusFound)
	}))
	defer source.Close()
	client := NewClient(ClientOptions{BaseURL: source.URL, Token: StaticTokenSource("redirect-secret"), HTTPClient: &http.Client{}})
	_, err := client.DoJSON(context.Background(), http.MethodGet, "/resource", nil, nil, nil)
	if err == nil || leaked != "" {
		t.Fatalf("err = %v, leaked token = %q", err, leaked)
	}
}

func TestGetJSONPagesPrefersLinkAndFallsBackToXNextPage(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		firstHeader func(http.Header, string)
	}{
		{
			name: "rfc link preferred",
			firstHeader: func(h http.Header, base string) {
				h.Set("Link", fmt.Sprintf(`<%s/items?page=2>; rel="next"`, base))
				h.Set("X-Next-Page", "99")
			},
		},
		{
			name: "x next page fallback",
			firstHeader: func(h http.Header, _ string) {
				h.Set("X-Next-Page", "2")
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var server *httptest.Server
			var pages []string
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				page := r.URL.Query().Get("page")
				if page == "" {
					page = "1"
				}
				pages = append(pages, page)
				if page == "1" {
					tt.firstHeader(w.Header(), server.URL)
				}
				_, _ = fmt.Fprintf(w, `[{"page":%s}]`, page)
			}))
			defer server.Close()

			client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("token")})
			var decoded []int
			err := client.GetJSONPages(context.Background(), "/items", nil, func(body []byte) error {
				var rows []struct {
					Page int `json:"page"`
				}
				if err := json.Unmarshal(body, &rows); err != nil {
					return err
				}
				for _, row := range rows {
					decoded = append(decoded, row.Page)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(pages, []string{"1", "2"}) || !reflect.DeepEqual(decoded, []int{1, 2}) {
				t.Fatalf("pages = %v, decoded = %v", pages, decoded)
			}
		})
	}
}

func TestGetJSONPagesRejectsCrossOriginLink(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", `<https://attacker.invalid/items?page=2>; rel="next"`)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("token")})
	err := client.GetJSONPages(context.Background(), "/items", nil, func([]byte) error { return nil })
	if !errors.Is(err, ErrInvalidPagination) {
		t.Fatalf("err = %v", err)
	}
}

type rotatingTokenSource struct {
	mu          sync.Mutex
	tokens      []string
	index       int
	invalidated int
}

func (s *rotatingTokenSource) Token(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.tokens) == 0 {
		return "", ErrNoToken
	}
	return s.tokens[s.index], nil
}

func (s *rotatingTokenSource) InvalidateToken() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invalidated++
	if s.index+1 < len(s.tokens) {
		s.index++
	}
}

func TestClientMissingAndRotatedToken(t *testing.T) {
	t.Parallel()
	t.Run("missing", func(t *testing.T) {
		t.Parallel()
		client := NewClient(ClientOptions{BaseURL: "http://127.0.0.1", Token: StaticTokenSource("")})
		_, err := client.DoJSON(context.Background(), http.MethodGet, "/user", nil, nil, nil)
		if !errors.Is(err, ErrAuthFailed) || !errors.Is(err, ErrNoToken) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("401 invalidates and next request uses rotated token", func(t *testing.T) {
		t.Parallel()
		tokens := &rotatingTokenSource{tokens: []string{"old-token", "new-token"}}
		var seen []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen = append(seen, r.Header.Get("PRIVATE-TOKEN"))
			if len(seen) == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"message":"invalid token"}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		}))
		defer server.Close()
		client := NewClient(ClientOptions{BaseURL: server.URL, Token: tokens})
		if _, err := client.DoJSON(context.Background(), http.MethodGet, "/user", nil, nil, nil); !errors.Is(err, ErrAuthFailed) {
			t.Fatalf("first err = %v", err)
		}
		if _, err := client.DoJSON(context.Background(), http.MethodGet, "/user", nil, nil, nil); err != nil {
			t.Fatalf("second err = %v", err)
		}
		if !reflect.DeepEqual(seen, []string{"old-token", "new-token"}) || tokens.invalidated != 1 {
			t.Fatalf("seen = %v, invalidated = %d", seen, tokens.invalidated)
		}
	})

	t.Run("oversized 401 still invalidates", func(t *testing.T) {
		t.Parallel()
		tokens := &rotatingTokenSource{tokens: []string{"old-token", "new-token"}}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"larger than limit"}`))
		}))
		defer server.Close()
		client := NewClient(ClientOptions{BaseURL: server.URL, Token: tokens, MaxJSONBytes: 1})
		response, err := client.DoJSON(context.Background(), http.MethodGet, "/user", nil, nil, nil)
		if !errors.Is(err, ErrAuthFailed) || tokens.invalidated != 1 || len(response.Body) != 0 {
			t.Fatalf("response=%#v err=%v invalidated=%d", response, err, tokens.invalidated)
		}
	})
}

type failingTokenSource struct{ err error }

func (s failingTokenSource) Token(context.Context) (string, error) { return "", s.err }

func TestClientRedactsTokenSourceErrors(t *testing.T) {
	t.Parallel()
	client := NewClient(ClientOptions{Token: failingTokenSource{err: errors.New("vault ref contains token-secret")}})
	_, err := client.DoJSON(context.Background(), http.MethodGet, "/user", nil, nil, nil)
	if !errors.Is(err, ErrAuthFailed) || strings.Contains(err.Error(), "token-secret") || strings.Contains(err.Error(), "vault") {
		t.Fatalf("err = %v", err)
	}
}

func TestClientStatusMappings(t *testing.T) {
	t.Parallel()
	tests := []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, ErrAuthFailed},
		{http.StatusForbidden, ErrForbidden},
		{http.StatusNotFound, ErrNotFound},
		{http.StatusConflict, ErrPrecondition},
		{http.StatusUnprocessableEntity, ErrPrecondition},
		{http.StatusTooManyRequests, ErrRateLimited},
	}
	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tt.status == http.StatusTooManyRequests {
					w.Header().Set("Retry-After", "7")
				}
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(`{"message":"request failed"}`))
			}))
			defer server.Close()
			client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("token")})
			_, err := client.DoJSON(context.Background(), http.MethodGet, "/resource", nil, nil, nil)
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
			if tt.status == http.StatusTooManyRequests {
				var rate *RateLimitError
				if !errors.As(err, &rate) || rate.RetryAfter != 7*time.Second {
					t.Fatalf("rate = %#v, err = %v", rate, err)
				}
			}
			if tt.status == http.StatusConflict || tt.status == http.StatusUnprocessableEntity {
				var precondition *PreconditionError
				if !errors.As(err, &precondition) || precondition.StatusCode != tt.status {
					t.Fatalf("precondition = %#v, err = %v", precondition, err)
				}
			}
		})
	}
}

func TestRateLimitRetryAfterHTTPDate(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", now.Add(9*time.Second).Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("token"), Now: func() time.Time { return now }})
	_, err := client.DoJSON(context.Background(), http.MethodGet, "/resource", nil, nil, nil)
	var rate *RateLimitError
	if !errors.As(err, &rate) || rate.RetryAfter != 9*time.Second {
		t.Fatalf("rate = %#v, err = %v", rate, err)
	}
}

func TestClientJSONAndRawResponseLimits(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json" {
			_, _ = w.Write([]byte(`{"value":"too large"}`))
			return
		}
		_, _ = w.Write([]byte("0123456789"))
	}))
	defer server.Close()
	client := NewClient(ClientOptions{
		BaseURL:      server.URL,
		Token:        StaticTokenSource("token"),
		MaxJSONBytes: 8,
		MaxRawBytes:  5,
	})
	_, err := client.DoJSON(context.Background(), http.MethodGet, "/json", nil, nil, &map[string]any{})
	var tooLarge *ResponseTooLargeError
	if !errors.As(err, &tooLarge) || tooLarge.Limit != 8 {
		t.Fatalf("json err = %v", err)
	}
	_, err = client.GetRaw(context.Background(), "/raw", nil)
	if !errors.As(err, &tooLarge) || tooLarge.Limit != 5 {
		t.Fatalf("raw err = %v", err)
	}
}

func TestClientNetworkAndTLSErrorsAreStructuredAndRedacted(t *testing.T) {
	t.Parallel()
	t.Run("network", func(t *testing.T) {
		t.Parallel()
		client := NewClient(ClientOptions{BaseURL: "http://127.0.0.1:1", Token: StaticTokenSource("network-secret")})
		_, err := client.DoJSON(context.Background(), http.MethodGet, "/resource", url.Values{"private_token": {"query-secret"}}, nil, nil)
		if !errors.Is(err, ErrNetwork) || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private_token") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("tls", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{}`))
		}))
		defer server.Close()
		client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource("tls-secret")})
		_, err := client.DoJSON(context.Background(), http.MethodGet, "/resource", nil, nil, nil)
		if !errors.Is(err, ErrTLS) || strings.Contains(err.Error(), "tls-secret") || strings.Contains(err.Error(), server.URL) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestClientErrorDiagnosticsNeverLeakRequestOrResponseSecrets(t *testing.T) {
	t.Parallel()
	const token = "header-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"header-secret","private_token":"body-secret","password":"password-secret"}`))
	}))
	defer server.Close()
	client := NewClient(ClientOptions{BaseURL: server.URL, Token: StaticTokenSource(token)})
	response, err := client.DoJSON(context.Background(), http.MethodPost, "/resource", url.Values{
		"access_token": {"query-secret"},
	}, map[string]string{"token": "request-body-secret"}, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if len(response.Header) != 0 {
		t.Fatalf("error response exposed headers: %#v", response.Header)
	}
	for _, secret := range []string{token, "body-secret", "password-secret", "query-secret", "request-body-secret", "access_token", "private_token"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error leaked %q: %v", secret, err)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestClientPreservesRequestCancellation(t *testing.T) {
	t.Parallel()
	client := NewClient(ClientOptions{
		BaseURL: "https://gitlab.example.com/api/v4",
		Token:   StaticTokenSource("token"),
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			<-req.Context().Done()
			return nil, req.Context().Err()
		})},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.DoJSON(ctx, http.MethodGet, "/user", nil, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestTokenSources(t *testing.T) {
	t.Run("env precedence", func(t *testing.T) {
		t.Setenv("AO_PROJECT_GITLAB_TOKEN", "project-token")
		t.Setenv("AO_GITLAB_TOKEN", "global-token")
		token, err := (EnvTokenSource{EnvVars: []string{"AO_PROJECT_GITLAB_TOKEN"}}).Token(context.Background())
		if err != nil || token != "project-token" {
			t.Fatalf("token = %q, err = %v", token, err)
		}
	})

	t.Run("default env", func(t *testing.T) {
		old, existed := os.LookupEnv("AO_GITLAB_TOKEN")
		t.Cleanup(func() {
			if existed {
				_ = os.Setenv("AO_GITLAB_TOKEN", old)
			} else {
				_ = os.Unsetenv("AO_GITLAB_TOKEN")
			}
		})
		_ = os.Setenv("AO_GITLAB_TOKEN", "default-token")
		token, err := (EnvTokenSource{}).Token(context.Background())
		if err != nil || token != "default-token" {
			t.Fatalf("token = %q, err = %v", token, err)
		}
	})

	t.Run("fallback and invalidation", func(t *testing.T) {
		rotating := &rotatingTokenSource{tokens: []string{"vault-one", "vault-two"}}
		source := FallbackTokenSource{StaticTokenSource(""), rotating}
		token, err := source.Token(context.Background())
		if err != nil || token != "vault-one" {
			t.Fatalf("token = %q, err = %v", token, err)
		}
		source.InvalidateToken()
		token, err = source.Token(context.Background())
		if err != nil || token != "vault-two" {
			t.Fatalf("token = %q, err = %v", token, err)
		}
	})
}

func TestTLSClassificationHandlesCertificateErrors(t *testing.T) {
	t.Parallel()
	tests := []error{
		x509.UnknownAuthorityError{},
		x509.HostnameError{},
		&tls.CertificateVerificationError{},
	}
	for _, input := range tests {
		if !isTLSError(input) {
			t.Errorf("isTLSError(%T) = false", input)
		}
	}
}
