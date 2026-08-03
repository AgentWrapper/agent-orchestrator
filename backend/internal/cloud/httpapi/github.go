package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
)

const (
	githubInstallStateAudience = "ao-cloud-github-install"
	githubInstallStateTTL      = 10 * time.Minute
	maxGitHubWebhookBodyBytes  = int64(25 << 20)
)

var githubEventNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// GitHubAppClient is the App-authenticated subset of the GitHub client used by
// the install flow and durable webhook processor.
// AO login remains the human identity boundary; this integration deliberately
// does not add GitHub user OAuth.
type GitHubAppClient interface {
	GetInstallation(context.Context, int64) (cloudgithubapp.Installation, error)
	ListInstallationRepositories(context.Context, int64) ([]cloudgithubapp.Repository, error)
}

// RepositoryRefresh performs a canonical provider refresh for active SCM
// targets linked to one organization repository.
type RepositoryRefresh func(context.Context, clouddomain.OrgID, int64) error

type githubStore interface {
	CreateGitHubInstallAttempt(context.Context, clouddomain.OrgID, clouddomain.UserID, json.RawMessage, time.Duration) (string, clouddomain.GitHubInstallAttempt, error)
	RecordPendingGitHubInstallation(context.Context, clouddomain.OrgID, clouddomain.UserID, string, cloudpostgres.GitHubPendingInstallationInput) (clouddomain.GitHubInstallAttempt, error)
	GetPendingGitHubInstallation(context.Context, clouddomain.OrgID, clouddomain.UserID, string) (clouddomain.GitHubInstallAttempt, error)
	ConfirmGitHubInstallation(context.Context, clouddomain.OrgID, clouddomain.UserID, string, cloudpostgres.GitHubInstallationConfirmation) ([]clouddomain.GitHubRepositoryGrant, error)
	BindGitHubInstallation(context.Context, clouddomain.OrgID, clouddomain.UserID, cloudpostgres.GitHubInstallationInput) (clouddomain.GitHubInstallation, error)
	ListGitHubInstallations(context.Context, clouddomain.OrgID) ([]clouddomain.GitHubInstallation, error)
	FindGitHubInstallationByGitHubID(context.Context, int64) (clouddomain.GitHubInstallation, error)
	DisconnectGitHubInstallation(context.Context, clouddomain.OrgID, int64) error
	UpdateGitHubInstallationStatus(context.Context, clouddomain.OrgID, int64, cloudpostgres.GitHubInstallationStatusUpdate) (clouddomain.GitHubInstallation, error)
	FullSyncGitHubRepositories(context.Context, clouddomain.OrgID, int64, []clouddomain.GitHubRepository) ([]clouddomain.GitHubRepositoryGrant, error)
	ListActiveGitHubRepositories(context.Context, clouddomain.OrgID) ([]clouddomain.GitHubGrantedRepository, error)
	FindActiveGitHubRepositoryGrant(context.Context, clouddomain.OrgID, int64) (clouddomain.GitHubRepositoryGrant, error)
	InsertGitHubWebhookDelivery(context.Context, cloudpostgres.GitHubWebhookDeliveryInput) (clouddomain.GitHubWebhookDelivery, bool, error)
	ClaimNextGitHubWebhookDelivery(context.Context) (clouddomain.GitHubWebhookDelivery, bool, error)
	MarkGitHubWebhookDeliveryProcessed(context.Context, string) error
	MarkGitHubWebhookDeliveryFailed(context.Context, string, string, *time.Time) error
}

// GitHubAppConfig configures the GitHub App HTTP surface. Secret byte slices
// are copied when the option is applied.
type GitHubAppConfig struct {
	Mode              string
	AppID             int64
	ClientID          string
	AppSlug           string
	StateSecret       []byte
	WebhookSecret     []byte
	Client            GitHubAppClient
	RepositoryRefresh RepositoryRefresh
	Now               func() time.Time
	ProcessorInterval time.Duration
}

// Option customizes optional AO Cloud HTTP capabilities without breaking
// existing constructor call sites.
type Option func(*Server)

// WithGitHubApp enables the GitHub App install and webhook layer.
func WithGitHubApp(config GitHubAppConfig) Option {
	return func(server *Server) {
		now := config.Now
		if now == nil {
			now = time.Now
		}
		interval := config.ProcessorInterval
		if interval <= 0 {
			interval = time.Second
		}
		server.githubApp = &githubAppRuntime{
			mode:              strings.TrimSpace(config.Mode),
			appID:             config.AppID,
			clientID:          strings.TrimSpace(config.ClientID),
			appSlug:           strings.TrimSpace(config.AppSlug),
			stateSecret:       append([]byte(nil), config.StateSecret...),
			webhookSecret:     append([]byte(nil), config.WebhookSecret...),
			client:            config.Client,
			repositoryRefresh: config.RepositoryRefresh,
			now:               now,
			processorInterval: interval,
		}
	}
}

type githubAppRuntime struct {
	mode              string
	appID             int64
	clientID          string
	appSlug           string
	stateSecret       []byte
	webhookSecret     []byte
	client            GitHubAppClient
	repositoryRefresh RepositoryRefresh
	now               func() time.Time
	processorInterval time.Duration
}

type githubInstallState struct {
	Version   int    `json:"v"`
	Audience  string `json:"aud"`
	Nonce     string `json:"nonce"`
	OrgID     string `json:"org"`
	UserID    string `json:"user"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func signGitHubInstallState(secret []byte, state githubInstallState) (string, error) {
	if len(secret) == 0 {
		return "", errors.New("GitHub install state secret is missing")
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return "", fmt.Errorf("encode GitHub install state: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(encoded))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + signature, nil
}

func verifyGitHubInstallState(secret []byte, encoded string, now time.Time) (githubInstallState, error) {
	var state githubInstallState
	payloadPart, signaturePart, ok := strings.Cut(encoded, ".")
	if !ok || payloadPart == "" || signaturePart == "" || strings.Contains(signaturePart, ".") {
		return state, errInvalidGitHubInstallState
	}
	signature, err := base64.RawURLEncoding.DecodeString(signaturePart)
	if err != nil || len(signature) != sha256.Size {
		return state, errInvalidGitHubInstallState
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(payloadPart))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return state, errInvalidGitHubInstallState
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil {
		return state, errInvalidGitHubInstallState
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return githubInstallState{}, errInvalidGitHubInstallState
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return githubInstallState{}, errInvalidGitHubInstallState
	}
	nowUnix := now.UTC().Unix()
	if state.Version != 1 ||
		state.Audience != githubInstallStateAudience ||
		strings.TrimSpace(state.Nonce) == "" ||
		strings.TrimSpace(state.OrgID) == "" ||
		strings.TrimSpace(state.UserID) == "" ||
		state.IssuedAt > nowUnix+30 ||
		state.ExpiresAt <= nowUnix ||
		state.ExpiresAt <= state.IssuedAt ||
		state.ExpiresAt-state.IssuedAt > int64(githubInstallStateTTL/time.Second) {
		return githubInstallState{}, errInvalidGitHubInstallState
	}
	return state, nil
}

func (s *Server) getGitHub(w http.ResponseWriter, r *http.Request) {
	if s.githubMode() != "github-app" {
		writeJSON(w, http.StatusOK, map[string]any{
			"mode":          s.githubMode(),
			"appSlug":       "",
			"installations": []clouddomain.GitHubInstallation{},
			"repositories":  []clouddomain.GitHubGrantedRepository{},
		})
		return
	}
	org, _ := orgFromContext(r.Context())
	state, err := s.loadGitHubState(r.Context(), org.Organization.ID)
	if err != nil {
		s.internalError(w, r, "load GitHub App state", err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) createGitHubInstall(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	org, _ := orgFromContext(r.Context())
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	nonce, _, err := s.githubStore.CreateGitHubInstallAttempt(
		r.Context(),
		org.Organization.ID,
		clouddomain.UserID(principal.UserID),
		json.RawMessage(`{}`),
		githubInstallStateTTL,
	)
	if err != nil {
		s.internalError(w, r, "create GitHub install attempt", err)
		return
	}
	now := s.githubApp.now().UTC()
	state, err := signGitHubInstallState(s.githubApp.stateSecret, githubInstallState{
		Version:   1,
		Audience:  githubInstallStateAudience,
		Nonce:     nonce,
		OrgID:     string(org.Organization.ID),
		UserID:    principal.UserID,
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(githubInstallStateTTL).Unix(),
	})
	if err != nil {
		s.internalError(w, r, "sign GitHub install state", err)
		return
	}
	target := url.URL{
		Scheme: "https",
		Host:   "github.com",
		Path:   "/apps/" + s.githubApp.appSlug + "/installations/new",
	}
	query := target.Query()
	query.Set("state", state)
	target.RawQuery = query.Encode()
	writeJSON(w, http.StatusOK, map[string]string{"installUrl": target.String()})
}

func (s *Server) githubInstallCallback(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	setGitHubInstallPrivacyHeaders(w)
	stateValue := strings.TrimSpace(r.URL.Query().Get("state"))
	claims, err := verifyGitHubInstallState(s.githubApp.stateSecret, stateValue, s.githubApp.now())
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_STATE", "GitHub installation state is invalid or expired.")
		return
	}
	installationID, err := parsePositiveInt64(r.URL.Query().Get("installation_id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation ID is invalid.")
		return
	}
	installation, err := s.githubApp.client.GetInstallation(r.Context(), installationID)
	if err != nil || !s.isConfiguredGitHubInstallation(installation) {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation does not belong to this application.")
		return
	}
	repositories, err := s.githubApp.client.ListInstallationRepositories(r.Context(), installationID)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation repositories could not be verified.")
		return
	}
	for _, repository := range repositories {
		if _, err := githubRepository(repository); err != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation returned invalid repository metadata.")
			return
		}
	}
	_, err = s.githubStore.RecordPendingGitHubInstallation(
		r.Context(),
		clouddomain.OrgID(claims.OrgID),
		clouddomain.UserID(claims.UserID),
		claims.Nonce,
		cloudpostgres.GitHubPendingInstallationInput{
			InstallationID:      installation.ID,
			AccountID:           installation.Account.ID,
			AccountLogin:        installation.Account.Login,
			AccountType:         installation.Account.Type,
			RepositorySelection: installation.RepositorySelection,
			RepositoryCount:     len(repositories),
		},
	)
	if errors.Is(err, cloudpostgres.ErrGitHubInstallAttemptConflict) {
		writeError(w, r, http.StatusConflict, "GITHUB_INSTALLATION_CONFLICT", "Another GitHub installation already completed this setup callback.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrInvalidGitHubInstallAttempt) {
		writeError(w, r, http.StatusConflict, "GITHUB_STATE_USED", "GitHub installation state is invalid, expired, or already used.")
		return
	}
	if err != nil {
		s.internalError(w, r, "record pending GitHub installation", err)
		return
	}
	target, err := url.Parse(s.webOrigin)
	if err != nil ||
		(target.Scheme != "http" && target.Scheme != "https") ||
		target.Host == "" ||
		target.User != nil {
		s.internalError(w, r, "build GitHub callback redirect", errors.New("AO web public URL is invalid"))
		return
	}
	target.Path = "/app/github/callback"
	target.RawPath = ""
	target.RawQuery = ""
	target.Fragment = ""
	query := target.Query()
	query.Set("state", stateValue)
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (s *Server) pendingGitHubInstall(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	setGitHubInstallPrivacyHeaders(w)
	var input struct {
		State string `json:"state"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	claims, orgID, userID, ok := s.authorizeGitHubInstallState(w, r, input.State)
	if !ok {
		return
	}
	attempt, err := s.githubStore.GetPendingGitHubInstallation(r.Context(), orgID, userID, claims.Nonce)
	if errors.Is(err, cloudpostgres.ErrInvalidGitHubInstallAttempt) {
		writeError(w, r, http.StatusConflict, "GITHUB_STATE_USED", "GitHub installation state is invalid, expired, or already used.")
		return
	}
	if err != nil {
		s.internalError(w, r, "load pending GitHub installation", err)
		return
	}
	pending, ok := pendingGitHubInstallationSummary(attempt)
	if !ok {
		s.internalError(w, r, "load pending GitHub installation", errors.New("pending GitHub installation is incomplete"))
		return
	}
	writeJSON(w, http.StatusOK, pending)
}

func (s *Server) confirmGitHubInstall(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	setGitHubInstallPrivacyHeaders(w)
	var input struct {
		State string `json:"state"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	claims, orgID, userID, ok := s.authorizeGitHubInstallState(w, r, input.State)
	if !ok {
		return
	}
	pendingAttempt, err := s.githubStore.GetPendingGitHubInstallation(r.Context(), orgID, userID, claims.Nonce)
	if errors.Is(err, cloudpostgres.ErrInvalidGitHubInstallAttempt) {
		writeError(w, r, http.StatusConflict, "GITHUB_STATE_USED", "GitHub installation state is invalid, expired, or already used.")
		return
	}
	if err != nil {
		s.internalError(w, r, "load pending GitHub installation", err)
		return
	}
	if pendingAttempt.PendingGitHubInstallationID == nil {
		writeError(w, r, http.StatusConflict, "GITHUB_INSTALLATION_NOT_PENDING", "GitHub installation has not completed its verified setup callback.")
		return
	}
	installation, err := s.githubApp.client.GetInstallation(r.Context(), *pendingAttempt.PendingGitHubInstallationID)
	if err != nil || !s.isConfiguredGitHubInstallation(installation) {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation does not belong to this application.")
		return
	}
	repositories, err := s.githubApp.client.ListInstallationRepositories(r.Context(), installation.ID)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation repositories could not be verified.")
		return
	}
	domainRepositories, err := githubRepositories(repositories)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation returned invalid repository metadata.")
		return
	}
	if !matchesPendingGitHubInstallation(pendingAttempt, installation, len(repositories)) {
		writeError(w, r, http.StatusConflict, "GITHUB_INSTALLATION_CHANGED", "The GitHub account or repository selection changed. Start the connection again to review the current access.")
		return
	}
	installationInput, err := githubInstallationInput(installation)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation returned invalid metadata.")
		return
	}
	_, err = s.githubStore.ConfirmGitHubInstallation(
		r.Context(),
		orgID,
		userID,
		claims.Nonce,
		cloudpostgres.GitHubInstallationConfirmation{
			Installation: installationInput,
			Repositories: domainRepositories,
		},
	)
	if errors.Is(err, cloudpostgres.ErrInvalidGitHubInstallAttempt) {
		writeError(w, r, http.StatusConflict, "GITHUB_STATE_USED", "GitHub installation state is invalid, expired, or already used.")
		return
	}
	if errors.Is(err, cloudpostgres.ErrGitHubInstallationConflict) {
		writeError(w, r, http.StatusConflict, "GITHUB_INSTALLATION_CONFLICT", "This GitHub installation is already connected to another organization.")
		return
	}
	if err != nil {
		s.internalError(w, r, "confirm GitHub installation", err)
		return
	}
	state, err := s.loadGitHubState(r.Context(), orgID)
	if err != nil {
		s.internalError(w, r, "load confirmed GitHub App state", err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) authorizeGitHubInstallState(
	w http.ResponseWriter,
	r *http.Request,
	stateValue string,
) (githubInstallState, clouddomain.OrgID, clouddomain.UserID, bool) {
	claims, err := verifyGitHubInstallState(
		s.githubApp.stateSecret,
		strings.TrimSpace(stateValue),
		s.githubApp.now(),
	)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_STATE", "GitHub installation state is invalid or expired.")
		return githubInstallState{}, "", "", false
	}
	org, _ := orgFromContext(r.Context())
	principal, _ := cloudauth.PrincipalFromContext(r.Context())
	if claims.OrgID != string(org.Organization.ID) || claims.UserID != principal.UserID {
		writeError(w, r, http.StatusForbidden, "GITHUB_STATE_FORBIDDEN", "GitHub installation state belongs to another user or organization.")
		return githubInstallState{}, "", "", false
	}
	return claims, org.Organization.ID, clouddomain.UserID(principal.UserID), true
}

func pendingGitHubInstallationSummary(
	attempt clouddomain.GitHubInstallAttempt,
) (clouddomain.GitHubPendingInstallation, bool) {
	if attempt.PendingGitHubInstallationID == nil ||
		attempt.PendingGitHubAccountID == nil ||
		attempt.PendingAccountLogin == nil ||
		attempt.PendingAccountType == nil ||
		attempt.PendingRepositorySelection == nil ||
		attempt.PendingRepositoryCount == nil {
		return clouddomain.GitHubPendingInstallation{}, false
	}
	return clouddomain.GitHubPendingInstallation{
		AccountLogin:        *attempt.PendingAccountLogin,
		AccountType:         *attempt.PendingAccountType,
		RepositorySelection: *attempt.PendingRepositorySelection,
		RepositoryCount:     *attempt.PendingRepositoryCount,
	}, true
}

func matchesPendingGitHubInstallation(
	attempt clouddomain.GitHubInstallAttempt,
	installation cloudgithubapp.Installation,
	repositoryCount int,
) bool {
	return attempt.PendingGitHubInstallationID != nil &&
		*attempt.PendingGitHubInstallationID == installation.ID &&
		attempt.PendingGitHubAccountID != nil &&
		*attempt.PendingGitHubAccountID == installation.Account.ID &&
		attempt.PendingAccountLogin != nil &&
		*attempt.PendingAccountLogin == strings.TrimSpace(installation.Account.Login) &&
		attempt.PendingAccountType != nil &&
		*attempt.PendingAccountType == strings.TrimSpace(installation.Account.Type) &&
		attempt.PendingRepositorySelection != nil &&
		*attempt.PendingRepositorySelection == strings.TrimSpace(installation.RepositorySelection) &&
		attempt.PendingRepositoryCount != nil &&
		*attempt.PendingRepositoryCount == repositoryCount
}

func setGitHubInstallPrivacyHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func (s *Server) syncGitHub(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	org, _ := orgFromContext(r.Context())
	installations, err := s.githubStore.ListGitHubInstallations(r.Context(), org.Organization.ID)
	if err != nil {
		s.internalError(w, r, "list GitHub installations for sync", err)
		return
	}
	for _, binding := range installations {
		if binding.Status != "active" && binding.Status != "suspended" {
			continue
		}
		installation, err := s.githubApp.client.GetInstallation(r.Context(), binding.GitHubInstallationID)
		if handled, cleanupErr := s.markDeletedGitHubInstallationOnNotFound(r.Context(), binding, err); handled {
			if cleanupErr != nil {
				s.internalError(w, r, "mark missing GitHub installation deleted", cleanupErr)
				return
			}
			continue
		}
		if err != nil {
			s.internalError(w, r, "load GitHub installation for sync", err)
			return
		}
		if !s.isConfiguredGitHubInstallation(installation) {
			s.internalError(w, r, "load GitHub installation for sync", errors.New("GitHub installation does not belong to configured App"))
			return
		}
		if _, err := s.bindAndSyncGitHubInstallation(
			r.Context(),
			org.Organization.ID,
			binding.InstalledByUserID,
			installation,
		); err != nil {
			if handled, cleanupErr := s.markDeletedGitHubInstallationOnNotFound(r.Context(), binding, err); handled {
				if cleanupErr != nil {
					s.internalError(w, r, "mark missing GitHub installation deleted", cleanupErr)
					return
				}
				continue
			}
			s.internalError(w, r, "sync GitHub installation", err)
			return
		}
	}
	state, err := s.loadGitHubState(r.Context(), org.Organization.ID)
	if err != nil {
		s.internalError(w, r, "load synced GitHub App state", err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) deleteGitHubInstallation(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	installationID, err := parsePositiveInt64(chi.URLParam(r, "installationId"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_INSTALLATION", "GitHub installation ID is invalid.")
		return
	}
	org, _ := orgFromContext(r.Context())
	err = s.githubStore.DisconnectGitHubInstallation(r.Context(), org.Organization.ID, installationID)
	if errors.Is(err, cloudpostgres.ErrGitHubInstallationNotFound) {
		writeError(w, r, http.StatusNotFound, "GITHUB_INSTALLATION_NOT_FOUND", "GitHub installation was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, "disconnect GitHub installation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) githubWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHubApp(w, r) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxGitHubWebhookBodyBytes))
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeError(w, r, http.StatusRequestEntityTooLarge, "GITHUB_WEBHOOK_TOO_LARGE", "GitHub webhook payload is too large.")
			return
		}
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_WEBHOOK", "GitHub webhook payload could not be read.")
		return
	}
	if !cloudgithubapp.VerifyWebhookSignature(
		s.githubApp.webhookSecret,
		body,
		strings.TrimSpace(r.Header.Get("X-Hub-Signature-256")),
	) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_GITHUB_SIGNATURE", "GitHub webhook signature is invalid.")
		return
	}
	deliveryID := strings.TrimSpace(r.Header.Get("X-GitHub-Delivery"))
	parsedDeliveryID, err := uuid.Parse(deliveryID)
	if err != nil || parsedDeliveryID.String() != strings.ToLower(deliveryID) {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_DELIVERY", "GitHub delivery header is invalid.")
		return
	}
	event := strings.TrimSpace(r.Header.Get("X-GitHub-Event"))
	if !githubEventNamePattern.MatchString(event) || !allowedGitHubWebhookEvent(event) {
		writeError(w, r, http.StatusBadRequest, "UNSUPPORTED_GITHUB_EVENT", "GitHub webhook event is not supported.")
		return
	}
	var envelope struct {
		Action       string `json:"action"`
		Installation *struct {
			ID int64 `json:"id"`
		} `json:"installation"`
		Repository *struct {
			ID int64 `json:"id"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_WEBHOOK", "GitHub webhook payload must be valid JSON.")
		return
	}
	var installationID, repositoryID *int64
	if envelope.Installation != nil && envelope.Installation.ID > 0 {
		value := envelope.Installation.ID
		installationID = &value
	}
	if envelope.Repository != nil && envelope.Repository.ID > 0 {
		value := envelope.Repository.ID
		repositoryID = &value
	}
	if event != "ping" && installationID == nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_GITHUB_WEBHOOK", "GitHub webhook installation is missing.")
		return
	}
	delivery, inserted, err := s.githubStore.InsertGitHubWebhookDelivery(r.Context(), cloudpostgres.GitHubWebhookDeliveryInput{
		DeliveryID:     deliveryID,
		Event:          event,
		Action:         strings.TrimSpace(envelope.Action),
		InstallationID: installationID,
		RepositoryID:   repositoryID,
		Payload:        body,
	})
	if errors.Is(err, cloudpostgres.ErrGitHubWebhookReplayConflict) {
		writeError(w, r, http.StatusConflict, "GITHUB_WEBHOOK_REPLAY_CONFLICT", "GitHub delivery ID conflicts with an earlier payload.")
		return
	}
	if err != nil {
		s.internalError(w, r, "store GitHub webhook delivery", err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted":   true,
		"duplicate":  !inserted,
		"deliveryId": delivery.DeliveryID,
	})
}

func (s *Server) githubMode() string {
	if s.githubApp != nil && s.githubApp.mode != "" {
		return s.githubApp.mode
	}
	if s.localGitHub != nil {
		return "local-gh"
	}
	return "disabled"
}

func (s *Server) requireGitHubApp(w http.ResponseWriter, r *http.Request) bool {
	if s.githubApp == nil ||
		s.githubApp.mode != "github-app" ||
		s.githubApp.appID <= 0 ||
		s.githubApp.appSlug == "" ||
		len(s.githubApp.stateSecret) == 0 ||
		len(s.githubApp.webhookSecret) == 0 ||
		s.githubApp.client == nil ||
		s.githubStore == nil {
		writeError(w, r, http.StatusNotFound, "GITHUB_APP_NOT_CONFIGURED", "GitHub App is not configured for this deployment.")
		return false
	}
	return true
}

func (s *Server) isConfiguredGitHubInstallation(installation cloudgithubapp.Installation) bool {
	return installation.ID > 0 &&
		installation.AppID == s.githubApp.appID &&
		(s.githubApp.clientID == "" || installation.ClientID == s.githubApp.clientID)
}

func (s *Server) loadGitHubState(ctx context.Context, orgID clouddomain.OrgID) (map[string]any, error) {
	if s.githubStore == nil {
		return nil, errors.New("GitHub store is unavailable")
	}
	installations, err := s.githubStore.ListGitHubInstallations(ctx, orgID)
	if err != nil {
		return nil, err
	}
	repositories, err := s.githubStore.ListActiveGitHubRepositories(ctx, orgID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"mode":          s.githubMode(),
		"appSlug":       s.githubApp.appSlug,
		"installations": installations,
		"repositories":  repositories,
	}, nil
}

func (s *Server) bindAndSyncGitHubInstallation(
	ctx context.Context,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	installation cloudgithubapp.Installation,
) ([]clouddomain.GitHubRepositoryGrant, error) {
	input, err := githubInstallationInput(installation)
	if err != nil {
		return nil, err
	}
	if _, err := s.githubStore.BindGitHubInstallation(ctx, orgID, userID, input); err != nil {
		return nil, err
	}
	if input.Status == "suspended" {
		return []clouddomain.GitHubRepositoryGrant{}, nil
	}
	repositories, err := s.githubApp.client.ListInstallationRepositories(ctx, installation.ID)
	if err != nil {
		return nil, err
	}
	return s.syncKnownGitHubRepositories(ctx, orgID, installation.ID, repositories)
}

func (s *Server) syncKnownGitHubRepositories(
	ctx context.Context,
	orgID clouddomain.OrgID,
	installationID int64,
	repositories []cloudgithubapp.Repository,
) ([]clouddomain.GitHubRepositoryGrant, error) {
	domainRepositories, err := githubRepositories(repositories)
	if err != nil {
		return nil, err
	}
	return s.githubStore.FullSyncGitHubRepositories(ctx, orgID, installationID, domainRepositories)
}

func githubRepositories(
	repositories []cloudgithubapp.Repository,
) ([]clouddomain.GitHubRepository, error) {
	domainRepositories := make([]clouddomain.GitHubRepository, 0, len(repositories))
	for _, repository := range repositories {
		converted, err := githubRepository(repository)
		if err != nil {
			return nil, err
		}
		domainRepositories = append(domainRepositories, converted)
	}
	return domainRepositories, nil
}

func (s *Server) markDeletedGitHubInstallationOnNotFound(
	ctx context.Context,
	binding clouddomain.GitHubInstallation,
	err error,
) (bool, error) {
	if !isGitHubAPINotFound(err) {
		return false, nil
	}
	_, updateErr := s.githubStore.UpdateGitHubInstallationStatus(
		ctx,
		binding.OrgID,
		binding.GitHubInstallationID,
		cloudpostgres.GitHubInstallationStatusUpdate{
			Status:     "deleted",
			OccurredAt: s.githubApp.now().UTC(),
		},
	)
	return true, updateErr
}

func isGitHubAPINotFound(err error) bool {
	var apiError *cloudgithubapp.APIError
	return errors.As(err, &apiError) && apiError.StatusCode == http.StatusNotFound
}

func githubInstallationInput(installation cloudgithubapp.Installation) (cloudpostgres.GitHubInstallationInput, error) {
	permissions, err := json.Marshal(installation.Permissions)
	if err != nil {
		return cloudpostgres.GitHubInstallationInput{}, fmt.Errorf("encode GitHub installation permissions: %w", err)
	}
	status := "active"
	if installation.SuspendedAt != nil {
		status = "suspended"
	}
	return cloudpostgres.GitHubInstallationInput{
		InstallationID:      installation.ID,
		AccountID:           installation.Account.ID,
		AccountLogin:        installation.Account.Login,
		AccountType:         installation.Account.Type,
		Status:              status,
		RepositorySelection: installation.RepositorySelection,
		Permissions:         permissions,
		Events:              append([]string(nil), installation.Events...),
	}, nil
}

func githubRepository(repository cloudgithubapp.Repository) (clouddomain.GitHubRepository, error) {
	metadata, err := json.Marshal(struct {
		NodeID     string `json:"nodeId,omitempty"`
		URL        string `json:"apiUrl,omitempty"`
		IsTemplate bool   `json:"isTemplate,omitempty"`
	}{
		NodeID:     repository.NodeID,
		URL:        repository.URL,
		IsTemplate: repository.IsTemplate,
	})
	if err != nil {
		return clouddomain.GitHubRepository{}, fmt.Errorf("encode GitHub repository metadata: %w", err)
	}
	var updatedAt *time.Time
	if !repository.UpdatedAt.IsZero() {
		value := repository.UpdatedAt
		updatedAt = &value
	}
	return clouddomain.GitHubRepository{
		ID:              repository.ID,
		OwnerAccountID:  repository.Owner.ID,
		Name:            repository.Name,
		FullName:        repository.FullName,
		HTMLURL:         repository.HTMLURL,
		CloneURL:        repository.CloneURL,
		SSHURL:          repository.SSHURL,
		DefaultBranch:   repository.DefaultBranch,
		Visibility:      repository.Visibility,
		Private:         repository.Private,
		Archived:        repository.Archived,
		Disabled:        repository.Disabled,
		Metadata:        metadata,
		GitHubUpdatedAt: updatedAt,
	}, nil
}

func allowedGitHubWebhookEvent(event string) bool {
	switch event {
	case "installation",
		"installation_repositories",
		"pull_request",
		"pull_request_review",
		"pull_request_review_thread",
		"check_run",
		"check_suite",
		"status",
		"ping":
		return true
	default:
		return false
	}
}

func parsePositiveInt64(value string) (int64, error) {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed <= 0 {
		return 0, errors.New("value must be a positive integer")
	}
	return parsed, nil
}

var errInvalidGitHubInstallState = errors.New("invalid GitHub install state")
