package localgh

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httputil"
	"strings"
)

// ProxyRepository forwards an authenticated Git smart-HTTP request to GitHub.
func (c *Client) ProxyRepository(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	owner, repository, suffix string,
) error {
	token, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	targetPath := "/" + owner + "/" + repository + ".git"
	if suffix != "" {
		targetPath += "/" + strings.TrimLeft(suffix, "/")
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.Out.URL.Scheme = "https"
			request.Out.URL.Host = "github.com"
			request.Out.URL.Path = targetPath
			request.Out.Host = "github.com"
			request.Out.Header.Set("Authorization", githubGitAuthorization(token))
			request.Out.Header.Set("User-Agent", "ao-cloud-local-git-proxy")
		},
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, proxyErr error) {
			http.Error(writer, "GitHub proxy failed", http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
	return nil
}

func githubGitAuthorization(token string) string {
	credentials := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	return "Basic " + credentials
}

// ParseRepositoryURL extracts an owner and repository from a GitHub URL.
func ParseRepositoryURL(repositoryURL string) (owner, repository string, ok bool) {
	value := strings.TrimSuffix(strings.TrimSpace(repositoryURL), ".git")
	value = strings.TrimPrefix(value, "https://github.com/")
	parts := strings.Split(value, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" ||
		strings.Contains(parts[0], "..") || strings.Contains(parts[1], "..") {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// ProxyURL builds the AO Cloud Git proxy URL for a GitHub repository.
func ProxyURL(baseURL, repositoryURL string) (string, error) {
	owner, repository, ok := ParseRepositoryURL(repositoryURL)
	if !ok {
		return "", fmt.Errorf("unsupported GitHub repository URL %q", repositoryURL)
	}
	return strings.TrimRight(baseURL, "/") + "/api/cloud/v1/git/" + owner + "/" + repository + ".git", nil
}
