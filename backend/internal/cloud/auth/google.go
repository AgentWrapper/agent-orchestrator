package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// GoogleProfile is the normalized identity returned by Google OAuth.
type GoogleProfile struct {
	Subject     string
	Email       string
	DisplayName string
}

// GoogleProvider exchanges an authorization code for a Google identity. Tests
// replace this interface; production uses HTTPGoogleProvider.
type GoogleProvider interface {
	AuthCodeURL(state string) string
	Exchange(ctx context.Context, code string) (GoogleProfile, error)
}

// GoogleConfig is loaded from AO_CLOUD_GOOGLE_* environment variables.
type GoogleConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

// HTTPGoogleProvider implements the OAuth authorization-code exchange against
// Google's tokeninfo endpoint after receiving an id_token.
type HTTPGoogleProvider struct {
	cfg    GoogleConfig
	client *http.Client
}

// NewHTTPGoogleProvider returns a Google OAuth provider backed by HTTP.
func NewHTTPGoogleProvider(cfg GoogleConfig, client *http.Client) *HTTPGoogleProvider {
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPGoogleProvider{cfg: cfg, client: client}
}

// AuthCodeURL returns the Google authorization URL for the supplied state.
func (p *HTTPGoogleProvider) AuthCodeURL(state string) string {
	v := url.Values{}
	v.Set("client_id", p.cfg.ClientID)
	v.Set("redirect_uri", p.cfg.RedirectURL)
	v.Set("response_type", "code")
	v.Set("scope", "openid email profile")
	v.Set("state", state)
	v.Set("access_type", "offline")
	v.Set("prompt", "consent")
	return "https://accounts.google.com/o/oauth2/v2/auth?" + v.Encode()
}

// Exchange exchanges an OAuth authorization code for a verified Google profile.
func (p *HTTPGoogleProvider) Exchange(ctx context.Context, code string) (GoogleProfile, error) {
	if p.cfg.ClientID == "" || p.cfg.ClientSecret == "" || p.cfg.RedirectURL == "" {
		return GoogleProfile{}, fmt.Errorf("google oauth is not configured")
	}
	form := url.Values{}
	form.Set("client_id", p.cfg.ClientID)
	form.Set("client_secret", p.cfg.ClientSecret)
	form.Set("redirect_uri", p.cfg.RedirectURL)
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return GoogleProfile{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.client.Do(req)
	if err != nil {
		return GoogleProfile{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return GoogleProfile{}, fmt.Errorf("google token exchange failed: %s", resp.Status)
	}
	var tokenResp struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return GoogleProfile{}, err
	}
	if tokenResp.IDToken == "" {
		return GoogleProfile{}, fmt.Errorf("google token response missing id_token")
	}
	infoURL := "https://oauth2.googleapis.com/tokeninfo?id_token=" + url.QueryEscape(tokenResp.IDToken)
	infoReq, err := http.NewRequestWithContext(ctx, http.MethodGet, infoURL, http.NoBody)
	if err != nil {
		return GoogleProfile{}, err
	}
	infoResp, err := p.client.Do(infoReq)
	if err != nil {
		return GoogleProfile{}, err
	}
	defer func() { _ = infoResp.Body.Close() }()
	if infoResp.StatusCode/100 != 2 {
		return GoogleProfile{}, fmt.Errorf("google id token verification failed: %s", infoResp.Status)
	}
	var info struct {
		Subject string `json:"sub"`
		Email   string `json:"email"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(infoResp.Body).Decode(&info); err != nil {
		return GoogleProfile{}, err
	}
	return GoogleProfile{Subject: info.Subject, Email: info.Email, DisplayName: info.Name}, nil
}
