package localgh

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestProxyURLAcceptsOnlyGitHubOwnerRepository(t *testing.T) {
	got, err := ProxyURL("https://cloud.example", "https://github.com/aoagents/agent-orchestrator.git")
	if err != nil {
		t.Fatalf("ProxyURL() error = %v", err)
	}
	want := "https://cloud.example/api/cloud/v1/git/aoagents/agent-orchestrator.git"
	if got != want {
		t.Fatalf("ProxyURL() = %q, want %q", got, want)
	}
	if _, err := ProxyURL("https://cloud.example", "https://example.com/repo"); err == nil {
		t.Fatal("ProxyURL(non-GitHub) error = nil")
	}
}

func TestStaticTokenSource(t *testing.T) {
	token, err := StaticTokenSource(" hosted-token ").Token(context.Background())
	if err != nil {
		t.Fatalf("Token() error = %v", err)
	}
	if token != "hosted-token" {
		t.Fatalf("Token() = %q", token)
	}
}

func TestGitHubGitAuthorizationUsesBasicTokenCredentials(t *testing.T) {
	header := githubGitAuthorization("secret-token")
	encoded := strings.TrimPrefix(header, "Basic ")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("DecodeString() error = %v", err)
	}
	if string(decoded) != "x-access-token:secret-token" {
		t.Fatalf("credentials = %q", decoded)
	}
}

func TestProxyRepositoryReplacesWorkerAuthorizationWithoutExposingInstallationToken(t *testing.T) {
	const (
		workerToken       = "worker-token"
		installationToken = "installation-token"
	)
	var upstreamAuthorization string
	originalTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		upstreamAuthorization = request.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header: http.Header{
				"Content-Type":     {"application/x-git-upload-pack-result"},
				"X-Upstream-Token": {installationToken},
			},
			Body:    io.NopCloser(strings.NewReader("git response")),
			Request: request,
		}, nil
	})
	defer func() { http.DefaultTransport = originalTransport }()

	client := NewWithTokenSource(StaticTokenSource(installationToken), nil)
	request := httptest.NewRequest(
		http.MethodPost,
		"https://cloud.example/api/cloud/v1/git/acme/repository.git/git-upload-pack",
		strings.NewReader("git request"),
	)
	request.SetBasicAuth("ao-worker", workerToken)
	response := httptest.NewRecorder()

	if err := client.ProxyRepository(
		context.Background(),
		response,
		request,
		"acme",
		"repository",
		"git-upload-pack",
	); err != nil {
		t.Fatalf("ProxyRepository() error = %v", err)
	}

	if upstreamAuthorization != githubGitAuthorization(installationToken) {
		t.Fatalf("upstream Authorization = %q", upstreamAuthorization)
	}
	if upstreamAuthorization == request.Header.Get("Authorization") ||
		strings.Contains(upstreamAuthorization, workerToken) {
		t.Fatal("worker proxy credential was forwarded to GitHub")
	}
	if strings.Contains(response.Body.String(), installationToken) ||
		response.Header().Get("X-Upstream-Token") != "" {
		t.Fatal("installation token was exposed in the proxy response")
	}
}

func TestGitOperationDownscopesUploadAndReceivePack(t *testing.T) {
	tests := []struct {
		name      string
		method    string
		suffix    string
		query     url.Values
		operation CredentialOperation
	}{
		{
			name:      "upload discovery",
			method:    http.MethodGet,
			suffix:    "info/refs",
			query:     url.Values{"service": {"git-upload-pack"}},
			operation: OperationGitUploadPack,
		},
		{
			name:      "receive discovery",
			method:    http.MethodGet,
			suffix:    "info/refs",
			query:     url.Values{"service": {"git-receive-pack"}},
			operation: OperationGitReceivePack,
		},
		{
			name:      "upload",
			method:    http.MethodPost,
			suffix:    "git-upload-pack",
			operation: OperationGitUploadPack,
		},
		{
			name:      "receive",
			method:    http.MethodPost,
			suffix:    "git-receive-pack",
			operation: OperationGitReceivePack,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operation, err := GitOperation(test.method, test.suffix, test.query)
			if err != nil || operation != test.operation {
				t.Fatalf("GitOperation() = %q, %v; want %q", operation, err, test.operation)
			}
		})
	}
	for _, request := range []struct {
		method string
		suffix string
		query  url.Values
	}{
		{http.MethodDelete, "git-receive-pack", nil},
		{http.MethodPost, "objects/info/packs", nil},
		{http.MethodGet, "info/refs", url.Values{"service": {"unknown"}}},
	} {
		if _, err := GitOperation(request.method, request.suffix, request.query); err == nil {
			t.Fatalf("GitOperation(%q, %q) accepted unsupported request", request.method, request.suffix)
		}
	}
}
