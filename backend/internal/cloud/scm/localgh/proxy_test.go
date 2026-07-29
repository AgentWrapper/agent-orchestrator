package localgh

import (
	"context"
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
