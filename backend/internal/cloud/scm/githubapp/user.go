package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// UserAccessToken is a GitHub App user-to-server credential. Its values are
// deliberately redacted and should be encrypted immediately by the caller.
type UserAccessToken struct {
	value            string
	refreshValue     string
	ExpiresAt        *time.Time
	RefreshExpiresAt *time.Time
}

// Token returns the short-lived user access token for an immediate operation.
func (token UserAccessToken) Token() string { return token.value }

// RefreshToken returns the rotating refresh credential.
func (token UserAccessToken) RefreshToken() string { return token.refreshValue }

func (UserAccessToken) String() string   { return "[REDACTED GitHub user token]" }
func (UserAccessToken) GoString() string { return "[REDACTED GitHub user token]" }

// User is the verified GitHub identity associated with a user access token.
type User struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	HTMLURL   string `json:"html_url"`
}

// UserAuthorizationURL builds GitHub's authorization-code URL with PKCE.
func (c *Client) UserAuthorizationURL(clientID, redirectURI, state, codeChallenge string) (string, error) {
	if strings.TrimSpace(clientID) == "" || strings.TrimSpace(redirectURI) == "" ||
		strings.TrimSpace(state) == "" || strings.TrimSpace(codeChallenge) == "" {
		return "", errors.New("GitHub user authorization parameters are required")
	}
	target := *c.oauthBaseURL
	target.Path = strings.TrimRight(c.oauthBaseURL.Path, "/") + "/login/oauth/authorize"
	query := target.Query()
	query.Set("client_id", clientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	query.Set("code_challenge", codeChallenge)
	query.Set("code_challenge_method", "S256")
	query.Set("allow_signup", "false")
	target.RawQuery = query.Encode()
	return target.String(), nil
}

// ExchangeUserCode exchanges one authorization code and PKCE verifier.
func (c *Client) ExchangeUserCode(
	ctx context.Context,
	clientID, clientSecret, code, redirectURI, codeVerifier string,
) (UserAccessToken, error) {
	values := url.Values{
		"client_id":     {strings.TrimSpace(clientID)},
		"client_secret": {strings.TrimSpace(clientSecret)},
		"code":          {strings.TrimSpace(code)},
		"redirect_uri":  {strings.TrimSpace(redirectURI)},
		"code_verifier": {strings.TrimSpace(codeVerifier)},
	}
	if values.Get("client_id") == "" || values.Get("client_secret") == "" ||
		values.Get("code") == "" || values.Get("redirect_uri") == "" ||
		values.Get("code_verifier") == "" {
		return UserAccessToken{}, errors.New("GitHub user token exchange parameters are required")
	}
	return c.exchangeUserToken(ctx, values)
}

// RefreshUserAccessToken rotates an expiring user access/refresh token pair.
func (c *Client) RefreshUserAccessToken(
	ctx context.Context,
	clientID, clientSecret, refreshToken string,
) (UserAccessToken, error) {
	values := url.Values{
		"client_id":     {strings.TrimSpace(clientID)},
		"client_secret": {strings.TrimSpace(clientSecret)},
		"grant_type":    {"refresh_token"},
		"refresh_token": {strings.TrimSpace(refreshToken)},
	}
	if values.Get("client_id") == "" || values.Get("client_secret") == "" ||
		values.Get("refresh_token") == "" {
		return UserAccessToken{}, errors.New("GitHub user token refresh parameters are required")
	}
	return c.exchangeUserToken(ctx, values)
}

func (c *Client) exchangeUserToken(ctx context.Context, values url.Values) (UserAccessToken, error) {
	target := *c.oauthBaseURL
	target.Path = strings.TrimRight(c.oauthBaseURL.Path, "/") + "/login/oauth/access_token"

	requestCtx := ctx
	cancel := func() {}
	if c.requestTimeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, c.requestTimeout)
	}
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		target.String(),
		strings.NewReader(values.Encode()),
	)
	if err != nil {
		return UserAccessToken{}, fmt.Errorf("build GitHub user token request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("User-Agent", c.userAgent)
	response, err := c.http.Do(request)
	if err != nil {
		return UserAccessToken{}, fmt.Errorf("perform GitHub user token request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	payload, tooLarge, err := readBounded(response.Body, c.maxErrorBytes)
	if err != nil {
		return UserAccessToken{}, fmt.Errorf("read GitHub user token response: %w", err)
	}
	if tooLarge {
		return UserAccessToken{}, &ResponseTooLargeError{Limit: c.maxErrorBytes}
	}
	var result struct {
		AccessToken           string `json:"access_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshToken          string `json:"refresh_token"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Error                 string `json:"error"`
		ErrorDescription      string `json:"error_description"`
	}
	if err := json.Unmarshal(payload, &result); err != nil {
		return UserAccessToken{}, fmt.Errorf("decode GitHub user token response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices ||
		result.Error != "" {
		message := strings.TrimSpace(result.ErrorDescription)
		if message == "" {
			message = strings.TrimSpace(result.Error)
		}
		if message == "" {
			message = response.Status
		}
		return UserAccessToken{}, fmt.Errorf("GitHub user authorization failed: %s", message)
	}
	result.AccessToken = strings.TrimSpace(result.AccessToken)
	if result.AccessToken == "" {
		return UserAccessToken{}, errors.New("GitHub user authorization returned an empty access token")
	}
	token := UserAccessToken{
		value:        result.AccessToken,
		refreshValue: strings.TrimSpace(result.RefreshToken),
	}
	if result.ExpiresIn > 0 {
		expiresAt := c.now().Add(time.Duration(result.ExpiresIn) * time.Second)
		token.ExpiresAt = &expiresAt
	}
	if result.RefreshTokenExpiresIn > 0 {
		refreshExpiresAt := c.now().Add(time.Duration(result.RefreshTokenExpiresIn) * time.Second)
		token.RefreshExpiresAt = &refreshExpiresAt
	}
	if token.refreshValue != "" && token.RefreshExpiresAt == nil {
		return UserAccessToken{}, errors.New("GitHub user authorization omitted refresh token expiry")
	}
	return token, nil
}

// GetUser verifies the GitHub identity represented by a user access token.
func (c *Client) GetUser(ctx context.Context, token string) (User, error) {
	var user User
	if err := c.doUserREST(ctx, token, http.MethodGet, "/user", nil, &user); err != nil {
		return User{}, fmt.Errorf("get authenticated GitHub user: %w", err)
	}
	if user.ID <= 0 || strings.TrimSpace(user.Login) == "" {
		return User{}, errors.New("GitHub returned an invalid authenticated user")
	}
	return user, nil
}

// ListUserInstallations lists this App's installations visible to the user.
func (c *Client) ListUserInstallations(ctx context.Context, token string) ([]Installation, error) {
	installations := make([]Installation, 0)
	for page := 1; page <= c.maxPaginationPage; page++ {
		var envelope struct {
			Installations []Installation `json:"installations"`
		}
		path := "/user/installations?per_page=100&page=" + strconv.Itoa(page)
		if err := c.doUserREST(ctx, token, http.MethodGet, path, nil, &envelope); err != nil {
			return nil, fmt.Errorf("list GitHub user installations: %w", err)
		}
		installations = append(installations, envelope.Installations...)
		if len(envelope.Installations) < 100 {
			return installations, nil
		}
	}
	return nil, errors.New("GitHub user installations exceeded pagination limit")
}

// RevokeUserAuthorization invalidates the provider-side grant before AO
// deletes its encrypted credential.
func (c *Client) RevokeUserAuthorization(
	ctx context.Context,
	clientID, clientSecret, token string,
) error {
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)
	token = strings.TrimSpace(token)
	if clientID == "" || clientSecret == "" || token == "" {
		return errors.New("GitHub user authorization revocation parameters are required")
	}
	target, err := c.restURL("/applications/" + url.PathEscape(clientID) + "/grant")
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"access_token": token})
	if err != nil {
		return fmt.Errorf("encode GitHub user authorization revocation: %w", err)
	}
	requestCtx := ctx
	cancel := func() {}
	if c.requestTimeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, c.requestTimeout)
	}
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodDelete,
		target,
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("build GitHub user authorization revocation: %w", err)
	}
	request.SetBasicAuth(clientID, clientSecret)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Api-Version", APIVersion)
	request.Header.Set("User-Agent", c.userAgent)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("perform GitHub user authorization revocation: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusNotFound {
		return nil
	}
	return c.decodeAPIError(response)
}

// CreateRepositoryAsUser creates and initializes a personal or organization
// repository through a user-to-server token.
func (c *Client) CreateRepositoryAsUser(
	ctx context.Context,
	token, accountLogin, accountType, name string,
	private bool,
) (Repository, error) {
	accountLogin = strings.TrimSpace(accountLogin)
	accountType = strings.ToLower(strings.TrimSpace(accountType))
	name = strings.TrimSpace(name)
	if accountLogin == "" || name == "" {
		return Repository{}, errors.New("GitHub repository owner and name are required")
	}
	path := "/user/repos"
	if accountType == "organization" {
		path = "/orgs/" + url.PathEscape(accountLogin) + "/repos"
	} else if accountType != "user" {
		return Repository{}, fmt.Errorf("unsupported GitHub account type %q", accountType)
	}
	var repository Repository
	if err := c.doUserREST(ctx, token, http.MethodPost, path, map[string]any{
		"name":      name,
		"private":   private,
		"auto_init": true,
	}, &repository); err != nil {
		return Repository{}, fmt.Errorf("create GitHub repository as user: %w", err)
	}
	return repository, nil
}

// DeleteRepositoryAsUser removes a scratch repository during rollback.
func (c *Client) DeleteRepositoryAsUser(ctx context.Context, token, owner, name string) error {
	owner = strings.TrimSpace(owner)
	name = strings.TrimSpace(name)
	if owner == "" || name == "" {
		return errors.New("GitHub repository owner and name are required")
	}
	if err := c.doUserREST(
		ctx,
		token,
		http.MethodDelete,
		"/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name),
		nil,
		nil,
	); err != nil {
		return fmt.Errorf("delete GitHub repository as user: %w", err)
	}
	return nil
}

func (c *Client) doUserREST(
	ctx context.Context,
	token, method, path string,
	input, output any,
) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("GitHub user access token is empty")
	}
	target, err := c.restURL(path)
	if err != nil {
		return err
	}
	_, err = c.doURL(ctx, method, target, token, input, output)
	return err
}

var _ fmt.Stringer = UserAccessToken{}
