package auth

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHTTPGoogleProviderValidatesTokenInfoClaims(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Host {
		case "oauth2.googleapis.com":
			if req.Method == http.MethodPost {
				return jsonResponse(`{"id_token":"id-token"}`), nil
			}
			return jsonResponse(`{
				"iss":"https://accounts.google.com",
				"aud":"wrong-client",
				"sub":"google-1",
				"email":"a@example.com",
				"email_verified":"true"
			}`), nil
		default:
			t.Fatalf("unexpected request URL %s", req.URL.String())
			return nil, nil
		}
	})}
	provider := NewHTTPGoogleProvider(GoogleConfig{
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		RedirectURL:  "http://127.0.0.1/callback",
	}, client)

	if _, err := provider.Exchange(context.Background(), "code"); err == nil {
		t.Fatalf("google tokeninfo with wrong audience succeeded")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func jsonResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}
