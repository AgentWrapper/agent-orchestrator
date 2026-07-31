package github

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func newMergeTestProvider(baseURL string) *Provider {
	client := NewClient(ClientOptions{
		HTTPClient: http.DefaultClient,
		RESTBase:   baseURL,
	})
	return &Provider{client: client, logger: slog.Default()}
}

func TestMergePR_SendsHeadSHAPrecondition(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"merged": true, "sha": "merged-sha-123"})
	}))
	defer srv.Close()

	p := newMergeTestProvider(srv.URL)
	sha, err := p.MergePR(context.Background(), "acme", "widgets", 9, "headsha123", "squash")
	if err != nil {
		t.Fatalf("MergePR() error = %v", err)
	}
	if sha != "merged-sha-123" {
		t.Fatalf("sha = %q, want %q", sha, "merged-sha-123")
	}
	if gotMethod != http.MethodPut {
		t.Fatalf("method = %q, want PUT", gotMethod)
	}
	if gotPath != "/repos/acme/widgets/pulls/9/merge" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBody["sha"] != "headsha123" {
		t.Fatalf("body sha = %q, want %q", gotBody["sha"], "headsha123")
	}
	if gotBody["merge_method"] != "squash" {
		t.Fatalf("body merge_method = %q, want %q", gotBody["merge_method"], "squash")
	}
}

func TestMergePR_OmitsPreconditionWhenHeadSHAEmpty(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"merged": true, "sha": "abc"})
	}))
	defer srv.Close()

	p := newMergeTestProvider(srv.URL)
	if _, err := p.MergePR(context.Background(), "acme", "widgets", 9, "", "squash"); err != nil {
		t.Fatalf("MergePR() error = %v", err)
	}
	if _, ok := gotBody["sha"]; ok {
		t.Fatalf("expected no sha precondition in body, got %v", gotBody)
	}
}

func TestMergePR_MapsStatusCodesToTypedErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   error
	}{
		{"not mergeable", http.StatusMethodNotAllowed, ports.ErrSCMPRNotMergeable},
		{"precondition failed", http.StatusConflict, ports.ErrSCMPRPreconditions},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message":"nope"}`))
			}))
			defer srv.Close()

			p := newMergeTestProvider(srv.URL)
			_, err := p.MergePR(context.Background(), "acme", "widgets", 9, "sha", "squash")
			if !errors.Is(err, tc.want) {
				t.Fatalf("status %d: err = %v, want %v", tc.status, err, tc.want)
			}
		})
	}
}

func TestMergePR_NotMergedInResponseBodyIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"merged": false})
	}))
	defer srv.Close()

	p := newMergeTestProvider(srv.URL)
	_, err := p.MergePR(context.Background(), "acme", "widgets", 9, "sha", "squash")
	if !errors.Is(err, ErrProviderPRNotMergeable) {
		t.Fatalf("err = %v, want ErrProviderPRNotMergeable", err)
	}
}

func TestRepoMergeSettings_DefaultsAbsentFieldsToAllowed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer srv.Close()

	p := newMergeTestProvider(srv.URL)
	settings, err := p.RepoMergeSettings(context.Background(), "acme", "widgets")
	if err != nil {
		t.Fatalf("RepoMergeSettings() error = %v", err)
	}
	want := ports.SCMRepoMergeSettings{AllowMergeCommit: true, AllowSquash: true, AllowRebase: true}
	if settings != want {
		t.Fatalf("settings = %#v, want %#v", settings, want)
	}
}

func TestRepoMergeSettings_HonorsExplicitFalse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"allow_merge_commit": false,
			"allow_squash_merge": true,
			"allow_rebase_merge": false,
		})
	}))
	defer srv.Close()

	p := newMergeTestProvider(srv.URL)
	settings, err := p.RepoMergeSettings(context.Background(), "acme", "widgets")
	if err != nil {
		t.Fatalf("RepoMergeSettings() error = %v", err)
	}
	want := ports.SCMRepoMergeSettings{AllowMergeCommit: false, AllowSquash: true, AllowRebase: false}
	if settings != want {
		t.Fatalf("settings = %#v, want %#v", settings, want)
	}
}
