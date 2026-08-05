package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
)

const (
	githubUserAuthAttemptTTL = 10 * time.Minute
	githubUserRefreshSkew    = 5 * time.Minute
)

type githubUserConnectionResponse struct {
	Connected     bool                     `json:"connected"`
	Login         string                   `json:"login,omitempty"`
	AvatarURL     string                   `json:"avatarUrl,omitempty"`
	Installations []githubUserInstallation `json:"installations"`
	LastSyncedAt  *time.Time               `json:"lastSyncedAt,omitempty"`
}

type githubUserInstallation struct {
	GitHubInstallationID int64  `json:"githubInstallationId"`
	AccountLogin         string `json:"accountLogin"`
	AccountType          string `json:"accountType"`
	RepositorySelection  string `json:"repositorySelection"`
	CanCreateRepository  bool   `json:"canCreateRepository"`
	UnavailableReason    string `json:"unavailableReason,omitempty"`
}

func (s *Server) createGitHubUserAuthorization(w http.ResponseWriter, r *http.Request) {
	if !s.githubUserAuthorizationConfigured() {
		writeError(w, r, http.StatusServiceUnavailable, "GITHUB_USER_AUTH_UNAVAILABLE", "GitHub user authorization is not configured.")
		return
	}
	principal, ok := cloudauth.PrincipalFromContext(r.Context())
	if !ok || strings.TrimSpace(principal.UserID) == "" {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
		return
	}
	state, err := randomGitHubOAuthValue(32)
	if err != nil {
		s.internalError(w, r, "generate GitHub OAuth state", err)
		return
	}
	verifier, err := randomGitHubOAuthValue(48)
	if err != nil {
		s.internalError(w, r, "generate GitHub PKCE verifier", err)
		return
	}
	stateHash := sha256.Sum256([]byte(state))
	verifierEncrypted, verifierNonce, err := s.secretCipher.Encrypt(
		[]byte(verifier),
		githubUserOAuthAssociatedData(clouddomain.UserID(principal.UserID), stateHash[:]),
	)
	if err != nil {
		s.internalError(w, r, "encrypt GitHub PKCE verifier", err)
		return
	}
	if _, err := s.githubStore.CreateGitHubUserAuthAttempt(
		r.Context(),
		clouddomain.UserID(principal.UserID),
		stateHash[:],
		verifierEncrypted,
		verifierNonce,
		githubUserAuthAttemptTTL,
	); err != nil {
		s.internalError(w, r, "create GitHub user authorization", err)
		return
	}
	challengeHash := sha256.Sum256([]byte(verifier))
	authorizeURL, err := s.githubApp.userClient.UserAuthorizationURL(
		s.githubApp.clientID,
		s.githubApp.userCallbackURL,
		state,
		base64.RawURLEncoding.EncodeToString(challengeHash[:]),
	)
	if err != nil {
		s.internalError(w, r, "build GitHub user authorization URL", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"authorizeUrl": authorizeURL})
}

func (s *Server) githubUserCallback(w http.ResponseWriter, r *http.Request) {
	setGitHubInstallPrivacyHeaders(w)
	if !s.githubUserAuthorizationConfigured() {
		s.redirectGitHubUserResult(w, r, "configuration_error")
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		s.log.Warn("GitHub user authorization rejected", "error", providerError)
		s.redirectGitHubUserResult(w, r, "authorization_rejected")
		return
	}
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if state == "" || code == "" {
		s.redirectGitHubUserResult(w, r, "invalid_callback")
		return
	}
	stateHash := sha256.Sum256([]byte(state))
	attempt, err := s.githubStore.GetGitHubUserAuthAttempt(r.Context(), stateHash[:])
	if err != nil {
		s.log.Warn("GitHub user authorization state rejected", "error", err)
		s.redirectGitHubUserResult(w, r, "invalid_state")
		return
	}
	verifier, err := s.secretCipher.Decrypt(
		attempt.CodeVerifierEncrypted,
		attempt.CodeVerifierNonce,
		githubUserOAuthAssociatedData(attempt.UserID, stateHash[:]),
	)
	if err != nil {
		s.log.Error("GitHub PKCE verifier decryption failed", "error", err)
		s.redirectGitHubUserResult(w, r, "authorization_failed")
		return
	}
	token, err := s.githubApp.userClient.ExchangeUserCode(
		r.Context(),
		s.githubApp.clientID,
		s.githubApp.clientSecret,
		code,
		s.githubApp.userCallbackURL,
		string(verifier),
	)
	if err != nil {
		s.log.Warn("GitHub user token exchange failed", "error", err)
		s.redirectGitHubUserResult(w, r, "authorization_failed")
		return
	}
	user, err := s.githubApp.userClient.GetUser(r.Context(), token.Token())
	if err != nil {
		s.log.Warn("GitHub user verification failed", "error", err)
		s.redirectGitHubUserResult(w, r, "authorization_failed")
		return
	}
	input, err := s.encryptGitHubUserConnection(attempt.UserID, user, token)
	if err != nil {
		s.log.Error("GitHub user credential encryption failed", "error", err)
		s.redirectGitHubUserResult(w, r, "authorization_failed")
		return
	}
	if _, err := s.githubStore.CompleteGitHubUserAuthorization(r.Context(), attempt.ID, input); err != nil {
		if errors.Is(err, cloudpostgres.ErrGitHubUserConnectionConflict) {
			s.redirectGitHubUserResult(w, r, "account_already_connected")
			return
		}
		s.log.Error("GitHub user authorization persistence failed", "error", err)
		s.redirectGitHubUserResult(w, r, "authorization_failed")
		return
	}
	s.redirectGitHubUserResult(w, r, "connected")
}

func (s *Server) getGitHubUser(w http.ResponseWriter, r *http.Request) {
	if !s.githubUserAuthorizationConfigured() {
		writeJSON(w, http.StatusOK, githubUserConnectionResponse{
			Installations: []githubUserInstallation{},
		})
		return
	}
	principal, ok := cloudauth.PrincipalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
		return
	}
	connection, accessToken, err := s.githubUserAccessToken(
		r.Context(),
		clouddomain.UserID(principal.UserID),
	)
	if errors.Is(err, cloudpostgres.ErrGitHubUserConnectionNotFound) {
		writeJSON(w, http.StatusOK, githubUserConnectionResponse{
			Installations: []githubUserInstallation{},
		})
		return
	}
	if errors.Is(err, errGitHubUserReauthorizationRequired) {
		writeError(w, r, http.StatusUnauthorized, "GITHUB_REAUTHORIZATION_REQUIRED", "Reconnect GitHub to continue.")
		return
	}
	if err != nil {
		s.internalError(w, r, "load GitHub user connection", err)
		return
	}
	installations, err := s.githubApp.userClient.ListUserInstallations(r.Context(), accessToken)
	if err != nil {
		var apiError *cloudgithubapp.APIError
		if errors.As(err, &apiError) && apiError.StatusCode == http.StatusUnauthorized {
			_ = s.githubStore.DeleteGitHubUserConnection(r.Context(), connection.UserID)
			writeError(w, r, http.StatusUnauthorized, "GITHUB_REAUTHORIZATION_REQUIRED", "Reconnect GitHub to continue.")
			return
		}
		s.internalError(w, r, "list GitHub user installations", err)
		return
	}
	result := make([]githubUserInstallation, 0, len(installations))
	for _, installation := range installations {
		canCreate := strings.EqualFold(installation.RepositorySelection, "all") &&
			strings.EqualFold(installation.Permissions["administration"], "write")
		reason := ""
		if !strings.EqualFold(installation.RepositorySelection, "all") {
			reason = "Configure the GitHub App for all repositories before creating a scratch repository."
		} else if !strings.EqualFold(installation.Permissions["administration"], "write") {
			reason = "The GitHub App requires repository administration write access."
		}
		result = append(result, githubUserInstallation{
			GitHubInstallationID: installation.ID,
			AccountLogin:         installation.Account.Login,
			AccountType:          installation.Account.Type,
			RepositorySelection:  installation.RepositorySelection,
			CanCreateRepository:  canCreate,
			UnavailableReason:    reason,
		})
	}
	lastSynced := connection.LastSyncedAt
	writeJSON(w, http.StatusOK, githubUserConnectionResponse{
		Connected:     true,
		Login:         connection.GitHubLogin,
		AvatarURL:     connection.GitHubAvatarURL,
		Installations: result,
		LastSyncedAt:  &lastSynced,
	})
}

func (s *Server) deleteGitHubUser(w http.ResponseWriter, r *http.Request) {
	principal, ok := cloudauth.PrincipalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
		return
	}
	userID := clouddomain.UserID(principal.UserID)
	if _, accessToken, err := s.githubUserAccessToken(r.Context(), userID); err == nil {
		if revokeErr := s.githubApp.userClient.RevokeUserAuthorization(
			r.Context(),
			s.githubApp.clientID,
			s.githubApp.clientSecret,
			accessToken,
		); revokeErr != nil && s.log != nil {
			s.log.Warn("GitHub user authorization revocation failed", "err", revokeErr)
		}
	}
	err := s.githubStore.DeleteGitHubUserConnection(r.Context(), userID)
	if err != nil && !errors.Is(err, cloudpostgres.ErrGitHubUserConnectionNotFound) {
		s.internalError(w, r, "disconnect GitHub user", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) githubUserAccessToken(
	ctx context.Context,
	userID clouddomain.UserID,
) (clouddomain.GitHubUserConnection, string, error) {
	s.githubApp.userTokenMu.Lock()
	defer s.githubApp.userTokenMu.Unlock()

	connection, err := s.githubStore.GitHubUserConnection(ctx, userID)
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	accessToken, err := s.secretCipher.Decrypt(
		connection.AccessTokenEncrypted,
		connection.AccessTokenNonce,
		githubUserTokenAssociatedData(userID, connection.GitHubUserID, "access"),
	)
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	if connection.AccessTokenExpiresAt == nil ||
		connection.AccessTokenExpiresAt.After(s.githubApp.now().Add(githubUserRefreshSkew)) {
		return connection, string(accessToken), nil
	}
	if len(connection.RefreshTokenEncrypted) == 0 || connection.RefreshTokenExpiresAt == nil ||
		!connection.RefreshTokenExpiresAt.After(s.githubApp.now()) {
		_ = s.githubStore.DeleteGitHubUserConnection(ctx, userID)
		return clouddomain.GitHubUserConnection{}, "", errGitHubUserReauthorizationRequired
	}
	refreshToken, err := s.secretCipher.Decrypt(
		connection.RefreshTokenEncrypted,
		connection.RefreshTokenNonce,
		githubUserTokenAssociatedData(userID, connection.GitHubUserID, "refresh"),
	)
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	rotated, err := s.githubApp.userClient.RefreshUserAccessToken(
		ctx,
		s.githubApp.clientID,
		s.githubApp.clientSecret,
		string(refreshToken),
	)
	if err != nil {
		if latest, latestToken, latestErr := s.concurrentlyRefreshedGitHubUserToken(
			ctx,
			connection,
		); latestErr == nil {
			return latest, latestToken, nil
		}
		return clouddomain.GitHubUserConnection{}, "", errGitHubUserReauthorizationRequired
	}
	user, err := s.githubApp.userClient.GetUser(ctx, rotated.Token())
	if err != nil || user.ID != connection.GitHubUserID {
		_ = s.githubStore.DeleteGitHubUserConnection(ctx, userID)
		return clouddomain.GitHubUserConnection{}, "", errGitHubUserReauthorizationRequired
	}
	input, err := s.encryptGitHubUserConnection(userID, user, rotated)
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	input.ExpectedUpdatedAt = connection.UpdatedAt
	updatedConnection, err := s.githubStore.UpdateGitHubUserConnectionTokens(ctx, userID, input)
	if errors.Is(err, cloudpostgres.ErrGitHubUserConnectionRefreshConflict) {
		return s.concurrentlyRefreshedGitHubUserToken(ctx, connection)
	}
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	return updatedConnection, rotated.Token(), nil
}

func (s *Server) concurrentlyRefreshedGitHubUserToken(
	ctx context.Context,
	previous clouddomain.GitHubUserConnection,
) (clouddomain.GitHubUserConnection, string, error) {
	latest, err := s.githubStore.GitHubUserConnection(ctx, previous.UserID)
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	if !latest.UpdatedAt.After(previous.UpdatedAt) {
		return clouddomain.GitHubUserConnection{}, "", errGitHubUserReauthorizationRequired
	}
	plaintext, err := s.secretCipher.Decrypt(
		latest.AccessTokenEncrypted,
		latest.AccessTokenNonce,
		githubUserTokenAssociatedData(latest.UserID, latest.GitHubUserID, "access"),
	)
	if err != nil {
		return clouddomain.GitHubUserConnection{}, "", err
	}
	if latest.AccessTokenExpiresAt != nil &&
		!latest.AccessTokenExpiresAt.After(s.githubApp.now()) {
		return clouddomain.GitHubUserConnection{}, "", errGitHubUserReauthorizationRequired
	}
	return latest, string(plaintext), nil
}

func (s *Server) encryptGitHubUserConnection(
	userID clouddomain.UserID,
	user cloudgithubapp.User,
	token cloudgithubapp.UserAccessToken,
) (cloudpostgres.GitHubUserConnectionInput, error) {
	accessEncrypted, accessNonce, err := s.secretCipher.Encrypt(
		[]byte(token.Token()),
		githubUserTokenAssociatedData(userID, user.ID, "access"),
	)
	if err != nil {
		return cloudpostgres.GitHubUserConnectionInput{}, err
	}
	input := cloudpostgres.GitHubUserConnectionInput{
		GitHubUserID:         user.ID,
		GitHubLogin:          strings.TrimSpace(user.Login),
		GitHubAvatarURL:      strings.TrimSpace(user.AvatarURL),
		AccessTokenEncrypted: accessEncrypted,
		AccessTokenNonce:     accessNonce,
		AccessTokenExpiresAt: token.ExpiresAt,
	}
	if refreshToken := strings.TrimSpace(token.RefreshToken()); refreshToken != "" {
		refreshEncrypted, refreshNonce, err := s.secretCipher.Encrypt(
			[]byte(refreshToken),
			githubUserTokenAssociatedData(userID, user.ID, "refresh"),
		)
		if err != nil {
			return cloudpostgres.GitHubUserConnectionInput{}, err
		}
		input.RefreshTokenEncrypted = refreshEncrypted
		input.RefreshTokenNonce = refreshNonce
		input.RefreshTokenExpiresAt = token.RefreshExpiresAt
	}
	return input, nil
}

func (s *Server) githubUserAuthorizationConfigured() bool {
	return s.githubApp != nil &&
		s.githubStore != nil &&
		s.secretCipher != nil &&
		s.githubApp.userClient != nil &&
		s.githubApp.clientID != "" &&
		s.githubApp.clientSecret != "" &&
		s.githubApp.userCallbackURL != ""
}

func (s *Server) redirectGitHubUserResult(w http.ResponseWriter, r *http.Request, result string) {
	target, err := url.Parse(s.webOrigin)
	if err != nil || target.Scheme == "" || target.Host == "" {
		http.Error(w, "GitHub authorization redirect is unavailable", http.StatusInternalServerError)
		return
	}
	target.Path = "/app"
	query := target.Query()
	query.Set("settings", "github")
	query.Set("github", result)
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func githubUserOAuthAssociatedData(userID clouddomain.UserID, stateHash []byte) string {
	return "github-user-oauth:" + string(userID) + ":" +
		base64.RawURLEncoding.EncodeToString(stateHash)
}

func githubUserTokenAssociatedData(userID clouddomain.UserID, githubUserID int64, kind string) string {
	return fmt.Sprintf("github-user-token:%s:%d:%s", userID, githubUserID, kind)
}

func randomGitHubOAuthValue(size int) (string, error) {
	if size <= 0 {
		return "", errors.New("OAuth random value size must be positive")
	}
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

var errGitHubUserReauthorizationRequired = errors.New("GitHub user reauthorization required")
