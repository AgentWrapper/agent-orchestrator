package localgh

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// GitOperation validates a Git smart-HTTP request and returns the least
// privilege credential operation needed to serve it.
func GitOperation(method, suffix string, query url.Values) (CredentialOperation, error) {
	suffix = strings.Trim(strings.TrimSpace(suffix), "/")
	switch {
	case method == http.MethodGet && suffix == "info/refs":
		switch query.Get("service") {
		case "git-upload-pack":
			return OperationGitUploadPack, nil
		case "git-receive-pack":
			return OperationGitReceivePack, nil
		}
	case method == http.MethodPost && suffix == "git-upload-pack":
		return OperationGitUploadPack, nil
	case method == http.MethodPost && suffix == "git-receive-pack":
		return OperationGitReceivePack, nil
	}
	return "", fmt.Errorf("unsupported Git smart HTTP request")
}

// ProxyRepository forwards an authenticated Git smart-HTTP request to GitHub.
func (c *Client) ProxyRepository(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	owner, repository, suffix string,
) error {
	if _, err := GitOperation(r.Method, suffix, r.URL.Query()); err != nil {
		return err
	}
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
			request.Out.URL.RawQuery = ""
			if strings.Trim(strings.TrimSpace(suffix), "/") == "info/refs" {
				request.Out.URL.RawQuery = url.Values{
					"service": {r.URL.Query().Get("service")},
				}.Encode()
			}
			request.Out.Host = "github.com"
			request.Out.Header = make(http.Header)
			copyGitRequestHeaders(request.Out.Header, request.In.Header)
			request.Out.Header.Set("Authorization", githubGitAuthorization(token))
			request.Out.Header.Set("User-Agent", "ao-cloud-git-proxy")
		},
		ModifyResponse: func(response *http.Response) error {
			contentType := response.Header.Get("Content-Type")
			cacheControl := response.Header.Get("Cache-Control")
			response.Header = make(http.Header)
			if contentType != "" {
				response.Header.Set("Content-Type", contentType)
			}
			if cacheControl != "" {
				response.Header.Set("Cache-Control", cacheControl)
			}
			return nil
		},
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, proxyErr error) {
			http.Error(writer, "GitHub proxy failed", http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
	return nil
}

func copyGitRequestHeaders(destination, source http.Header) {
	const maxGitHeaderBytes = 8 << 10
	remaining := 16 << 10
	for _, name := range []string{"Accept", "Content-Type", "Git-Protocol"} {
		for _, value := range source.Values(name) {
			if len(value) <= maxGitHeaderBytes && len(value) <= remaining {
				destination.Add(name, value)
				remaining -= len(value)
			}
		}
	}
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
