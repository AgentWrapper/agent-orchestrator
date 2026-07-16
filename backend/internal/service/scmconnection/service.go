// Package scmconnection manages global SCM connection metadata and write-only credentials.
package scmconnection

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const cleanupTimeout = 5 * time.Second

// GitHubDefaultConnectionID is reserved for the virtual legacy GitHub connection.
const GitHubDefaultConnectionID = "github-default"

// Connection validation statuses exposed by the SCM connection API.
const (
	StatusUnknown           = string(domain.SCMConnectionStatusUnknown)
	StatusConnected         = string(domain.SCMConnectionStatusConnected)
	StatusMissingCredential = string(domain.SCMConnectionStatusMissingCredential)
	StatusUnauthorized      = string(domain.SCMConnectionStatusUnauthorized)
	StatusForbidden         = string(domain.SCMConnectionStatusForbidden)
	StatusUnreachable       = string(domain.SCMConnectionStatusUnreachable)
	StatusTLSError          = string(domain.SCMConnectionStatusTLSError)
	StatusRateLimited       = string(domain.SCMConnectionStatusRateLimited)
)

// Connection is the read model. It deliberately has no credential bytes or reference.
type Connection struct {
	ID                   string             `json:"id"`
	Provider             domain.SCMProvider `json:"provider" enum:"github,gitlab"`
	DisplayName          string             `json:"displayName"`
	WebBaseURL           string             `json:"webBaseUrl"`
	APIBaseURL           string             `json:"apiBaseUrl"`
	CredentialConfigured bool               `json:"credentialConfigured"`
	Status               string             `json:"status" enum:"unknown,connected,missing_credential,unauthorized,forbidden,unreachable,tls_error,rate_limited"`
	Username             string             `json:"username,omitempty"`
}

// CreateInput creates connection metadata and optionally stores a credential.
type CreateInput struct {
	ID          string             `json:"id"`
	Provider    domain.SCMProvider `json:"provider" enum:"github,gitlab"`
	DisplayName string             `json:"displayName"`
	WebBaseURL  string             `json:"webBaseUrl,omitempty"`
	APIBaseURL  string             `json:"apiBaseUrl,omitempty"`
	Token       TokenInput         `json:"token,omitempty" writeOnly:"true"`
}

// UpdateInput replaces mutable metadata. An omitted token retains the current
// credential, an empty token removes it, and any other value replaces it.
type UpdateInput struct {
	Provider    domain.SCMProvider `json:"provider" enum:"github,gitlab"`
	DisplayName string             `json:"displayName"`
	WebBaseURL  string             `json:"webBaseUrl,omitempty"`
	APIBaseURL  string             `json:"apiBaseUrl,omitempty"`
	Token       TokenInput         `json:"token,omitempty" writeOnly:"true"`
}

// Identity is the provider identity returned by a connection test.
type Identity struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName,omitempty"`
}

// Capabilities reports whether the credential can read and mutate provider resources.
type Capabilities struct {
	Read  bool `json:"read"`
	Write bool `json:"write"`
}

// TestResult is the bounded, provider-neutral result of testing a connection.
type TestResult struct {
	Status       string       `json:"status" enum:"connected,missing_credential"`
	Identity     Identity     `json:"identity"`
	Capabilities Capabilities `json:"capabilities"`
}

// ConnectionTestConfig contains only provider-facing test inputs.
type ConnectionTestConfig struct {
	ID         string
	Provider   domain.SCMProvider
	WebBaseURL string
	APIBaseURL string
	Repository string
}

// TestInput identifies the repository whose read/write permissions are tested.
type TestInput struct {
	Repository string `json:"repository" description:"Provider-native repository path, for example owner/repo or group/subgroup/repo."`
}

// ConnectionTester probes one provider connection using a credential supplied
// only for the duration of the call. Implementations return normalized data.
type ConnectionTester interface {
	Test(ctx context.Context, config ConnectionTestConfig, token []byte) (TestResult, error)
}

// CredentialOverrideChecker reports credentials that take precedence over the vault.
type CredentialOverrideChecker interface {
	CredentialOverrideConfigured(ctx context.Context, config ConnectionTestConfig) (bool, error)
}

// Store is the metadata persistence surface used by Service.
type Store interface {
	CreateSCMConnection(ctx context.Context, connection domain.SCMConnection) error
	GetSCMConnection(ctx context.Context, id string) (domain.SCMConnection, bool, error)
	ListSCMConnections(ctx context.Context) ([]domain.SCMConnection, error)
	UpdateSCMConnection(ctx context.Context, connection domain.SCMConnection) (bool, error)
	UpdateSCMConnectionValidation(ctx context.Context, id string, expectedUpdatedAt time.Time, status domain.SCMConnectionStatus, username string) (bool, error)
	DeleteSCMConnection(ctx context.Context, id string) (bool, error)
}

// Manager is the controller-facing SCM connection contract.
type Manager interface {
	Create(ctx context.Context, in CreateInput) (Connection, error)
	List(ctx context.Context) ([]Connection, error)
	Get(ctx context.Context, id string) (Connection, error)
	Update(ctx context.Context, id string, in UpdateInput) (Connection, error)
	Delete(ctx context.Context, id string) error
	Test(ctx context.Context, id, repository string) (TestResult, error)
}

// Deps supplies SCM connection persistence, credentials, testing, and policy.
type Deps struct {
	Store                 Store
	Credentials           ports.CredentialStore
	Tester                ConnectionTester
	AllowInsecureLoopback bool
	Clock                 func() time.Time
	NewCredentialRef      func(id string) (string, error)
}

// Service coordinates metadata and credential writes with compensation.
type Service struct {
	store             Store
	credentials       ports.CredentialStore
	tester            ConnectionTester
	clock             func() time.Time
	newCredentialRef  func(string) (string, error)
	allowLoopbackHTTP bool
	mu                sync.Mutex
}

var _ Manager = (*Service)(nil)

// New creates an SCM connection service.
func New(d Deps) *Service {
	if d.Clock == nil {
		d.Clock = time.Now
	}
	if d.NewCredentialRef == nil {
		d.NewCredentialRef = randomCredentialRef
	}
	return &Service{
		store: d.Store, credentials: d.Credentials, tester: d.Tester,
		clock: d.Clock, newCredentialRef: d.NewCredentialRef,
		allowLoopbackHTTP: d.AllowInsecureLoopback,
	}
}

// Create validates and persists one SCM connection and optional credential.
func (s *Service) Create(ctx context.Context, in CreateInput) (Connection, error) {
	row, err := normalizeCreate(in, s.allowLoopbackHTTP)
	if err != nil {
		return Connection{}, err
	}
	if row.ID == GitHubDefaultConnectionID {
		return Connection{}, apierr.Invalid("RESERVED_SCM_CONNECTION_ID", "SCM connection id is reserved", nil)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok, err := s.store.GetSCMConnection(ctx, row.ID); err != nil {
		return Connection{}, apierr.Internal("SCM_CONNECTION_CREATE_FAILED", "Failed to create SCM connection")
	} else if ok {
		return Connection{}, apierr.Conflict("SCM_CONNECTION_ALREADY_EXISTS", "An SCM connection with this id already exists", nil)
	}
	row.CredentialRef, err = s.newCredentialRef(row.ID)
	if err != nil {
		return Connection{}, apierr.Internal("SCM_CONNECTION_CREATE_FAILED", "Failed to create SCM connection")
	}
	now := s.clock().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	row.Status = domain.SCMConnectionStatusUnknown
	configured := in.Token.Present && in.Token.Value != ""
	if configured {
		if err := s.credentials.Put(ctx, row.CredentialRef, []byte(in.Token.Value)); err != nil {
			return Connection{}, credentialError()
		}
	}
	if err := s.store.CreateSCMConnection(ctx, row); err != nil {
		primaryErr := apierr.Internal("SCM_CONNECTION_CREATE_FAILED", "Failed to create SCM connection")
		var cleanupErr error
		if configured {
			cleanupErr = s.cleanupCredential(ctx, row.CredentialRef)
		}
		if _, exists, getErr := s.store.GetSCMConnection(ctx, row.ID); getErr == nil && exists {
			primaryErr = apierr.Conflict("SCM_CONNECTION_ALREADY_EXISTS", "An SCM connection with this id already exists", nil)
		}
		return Connection{}, errors.Join(primaryErr, cleanupErr)
	}
	return connectionView(row, configured), nil
}

// List returns every SCM connection without credential material.
func (s *Service) List(ctx context.Context) ([]Connection, error) {
	rows, err := s.store.ListSCMConnections(ctx)
	if err != nil {
		return nil, apierr.Internal("SCM_CONNECTIONS_LIST_FAILED", "Failed to load SCM connections")
	}
	out := make([]Connection, 0, len(rows))
	for _, row := range rows {
		configured, err := s.credentialConfigured(ctx, row)
		if err != nil {
			return nil, err
		}
		out = append(out, connectionView(row, configured))
	}
	return out, nil
}

// Get returns one SCM connection without credential material.
func (s *Service) Get(ctx context.Context, id string) (Connection, error) {
	row, err := s.getRow(ctx, id)
	if err != nil {
		return Connection{}, err
	}
	configured, err := s.credentialConfigured(ctx, row)
	if err != nil {
		return Connection{}, err
	}
	return connectionView(row, configured), nil
}

// Update replaces mutable metadata and applies token presence semantics.
func (s *Service) Update(ctx context.Context, id string, in UpdateInput) (Connection, error) {
	id = strings.TrimSpace(id)
	if !connectionIDPattern.MatchString(id) {
		return Connection{}, apierr.Invalid("INVALID_SCM_CONNECTION_ID", "Invalid SCM connection id", nil)
	}
	if id == GitHubDefaultConnectionID {
		return Connection{}, apierr.Invalid("RESERVED_SCM_CONNECTION_ID", "SCM connection id is reserved", nil)
	}
	replacement, err := normalizeUpdate(id, in, s.allowLoopbackHTTP)
	if err != nil {
		return Connection{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	original, err := s.getRow(ctx, id)
	if err != nil {
		return Connection{}, err
	}
	var oldSecret []byte
	var oldConfigured bool
	if in.Token.Present {
		oldSecret, oldConfigured, err = s.credentials.Get(ctx, original.CredentialRef)
		if err != nil {
			return Connection{}, credentialError()
		}
		defer zero(oldSecret)
	}
	replacement.CreatedAt = original.CreatedAt
	replacement.UpdatedAt = s.clock().UTC()
	replacement.CredentialRef = original.CredentialRef

	rotated := in.Token.Present
	var configured bool
	if !rotated {
		configured, err = s.credentialConfigured(ctx, original)
		if err != nil {
			return Connection{}, err
		}
	} else {
		replacement.CredentialRef, err = s.newCredentialRef(id)
		if err != nil || replacement.CredentialRef == original.CredentialRef {
			return Connection{}, apierr.Internal("SCM_CONNECTION_UPDATE_FAILED", "Failed to update SCM connection")
		}
		configured = in.Token.Value != ""
		if configured {
			if err := s.credentials.Put(ctx, replacement.CredentialRef, []byte(in.Token.Value)); err != nil {
				return Connection{}, credentialError()
			}
		}
	}
	if replacement.Provider != original.Provider || replacement.WebBaseURL != original.WebBaseURL ||
		replacement.APIBaseURL != original.APIBaseURL || rotated {
		replacement.Status = domain.SCMConnectionStatusUnknown
		replacement.Username = ""
	} else {
		replacement.Status = original.Status
		replacement.Username = original.Username
	}

	ok, err := s.store.UpdateSCMConnection(ctx, replacement)
	if err != nil || !ok {
		primaryErr := error(apierr.Internal("SCM_CONNECTION_UPDATE_FAILED", "Failed to update SCM connection"))
		var cleanupErr error
		if rotated && configured {
			cleanupErr = s.cleanupCredential(ctx, replacement.CredentialRef)
		}
		if err == nil && !ok {
			primaryErr = notFoundError()
		}
		return Connection{}, errors.Join(primaryErr, cleanupErr)
	}
	if rotated {
		cleanupCtx, cancel := newCleanupContext(ctx)
		defer cancel()
		if err := s.credentials.Delete(cleanupCtx, original.CredentialRef); err != nil {
			primaryErr := error(credentialError())
			if oldConfigured {
				if restoreErr := s.credentials.Put(cleanupCtx, original.CredentialRef, oldSecret); restoreErr != nil {
					return Connection{}, errors.Join(primaryErr, credentialError())
				}
			}
			ok, rollbackErr := s.store.UpdateSCMConnection(cleanupCtx, original)
			if rollbackErr != nil || !ok {
				return Connection{}, errors.Join(
					apierr.Internal("SCM_CONNECTION_UPDATE_FAILED", "Failed to roll back SCM connection"),
					primaryErr,
				)
			}
			var cleanupErr error
			if configured {
				if err := s.credentials.Delete(cleanupCtx, replacement.CredentialRef); err != nil {
					cleanupErr = apierr.Internal("SCM_CREDENTIAL_CLEANUP_FAILED", "Failed to clean up SCM credential")
				}
			}
			return Connection{}, errors.Join(primaryErr, cleanupErr)
		}
	}
	return connectionView(replacement, configured), nil
}

// Delete removes an unreferenced SCM connection and its credential.
func (s *Service) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	row, err := s.getRow(ctx, id)
	if err != nil {
		return err
	}
	deleted, err := s.store.DeleteSCMConnection(ctx, row.ID)
	if errors.Is(err, ports.ErrSCMConnectionReferenced) {
		return apierr.Conflict("SCM_CONNECTION_REFERENCED", "SCM connection is referenced by a project", nil)
	}
	if err != nil {
		return apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to delete SCM connection")
	}
	if !deleted {
		return notFoundError()
	}
	cleanupCtx, cancel := newCleanupContext(ctx)
	defer cancel()
	secret, configured, err := s.credentials.Get(cleanupCtx, row.CredentialRef)
	if err != nil {
		primaryErr := error(credentialError())
		if restoreErr := s.store.CreateSCMConnection(cleanupCtx, row); restoreErr != nil {
			return errors.Join(primaryErr, apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to restore SCM connection"))
		}
		return primaryErr
	}
	defer zero(secret)
	if err := s.credentials.Delete(cleanupCtx, row.CredentialRef); err != nil {
		primaryErr := error(apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to delete SCM connection"))
		metadataErr := s.store.CreateSCMConnection(cleanupCtx, row)
		var credentialRestoreErr error
		if configured {
			credentialRestoreErr = s.credentials.Put(cleanupCtx, row.CredentialRef, secret)
		}
		if metadataErr != nil {
			metadataErr = apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to restore SCM connection")
		}
		if credentialRestoreErr != nil {
			credentialRestoreErr = credentialError()
		}
		return errors.Join(primaryErr, metadataErr, credentialRestoreErr)
	}
	return nil
}

// Test validates one SCM connection and persists its normalized result.
func (s *Service) Test(ctx context.Context, id, repository string) (TestResult, error) {
	repository = strings.TrimSpace(repository)
	if repository == "" {
		return TestResult{}, apierr.Invalid("SCM_REPOSITORY_REQUIRED", "SCM repository is required", nil)
	}
	row, err := s.getRow(ctx, id)
	if err != nil {
		return TestResult{}, err
	}
	if s.tester == nil {
		return TestResult{}, apierr.Internal("SCM_CONNECTION_TEST_UNAVAILABLE", "SCM connection testing is unavailable")
	}
	config := connectionTestConfig(row, repository)
	overrideConfigured, err := s.credentialOverrideConfigured(ctx, config)
	if err != nil {
		return TestResult{}, err
	}
	var token []byte
	ok := false
	if !overrideConfigured {
		token, ok, err = s.credentials.Get(ctx, row.CredentialRef)
		if err != nil {
			return TestResult{}, credentialError()
		}
	}
	if !ok && !overrideConfigured {
		result := TestResult{Status: StatusMissingCredential}
		if err := s.persistValidation(ctx, row, domain.SCMConnectionStatusMissingCredential, ""); err != nil {
			return TestResult{}, err
		}
		return result, nil
	}
	defer zero(token)
	result, err := s.tester.Test(ctx, config, token)
	if err != nil {
		status, username, mapped := mapTestFailure(result, err)
		if persistErr := s.persistValidation(ctx, row, status, username); persistErr != nil {
			return TestResult{}, errors.Join(persistErr, mapped)
		}
		return TestResult{}, mapped
	}
	if result.Status != StatusConnected {
		mapped := apierr.Internal("SCM_CONNECTION_TEST_FAILED", "Failed to test SCM connection")
		if persistErr := s.persistValidation(ctx, row, domain.SCMConnectionStatusUnknown, ""); persistErr != nil {
			return TestResult{}, errors.Join(persistErr, mapped)
		}
		return TestResult{}, mapped
	}
	if persistErr := s.persistValidation(ctx, row, domain.SCMConnectionStatus(result.Status), result.Identity.Username); persistErr != nil {
		return TestResult{}, persistErr
	}
	return result, nil
}

func (s *Service) getRow(ctx context.Context, id string) (domain.SCMConnection, error) {
	row, ok, err := s.store.GetSCMConnection(ctx, strings.TrimSpace(id))
	if err != nil {
		return domain.SCMConnection{}, apierr.Internal("SCM_CONNECTION_LOAD_FAILED", "Failed to load SCM connection")
	}
	if !ok {
		return domain.SCMConnection{}, notFoundError()
	}
	return row, nil
}

func (s *Service) credentialConfigured(ctx context.Context, row domain.SCMConnection) (bool, error) {
	override, err := s.credentialOverrideConfigured(ctx, connectionTestConfig(row, ""))
	if err != nil || override {
		return override, err
	}
	secret, ok, err := s.credentials.Get(ctx, row.CredentialRef)
	zero(secret)
	if err != nil {
		return false, credentialError()
	}
	return ok, nil
}

func (s *Service) credentialOverrideConfigured(ctx context.Context, config ConnectionTestConfig) (bool, error) {
	checker, ok := s.tester.(CredentialOverrideChecker)
	if !ok {
		return false, nil
	}
	configured, err := checker.CredentialOverrideConfigured(ctx, config)
	if err != nil {
		return false, credentialError()
	}
	return configured, nil
}

func connectionTestConfig(row domain.SCMConnection, repository string) ConnectionTestConfig {
	return ConnectionTestConfig{
		ID: row.ID, Provider: row.Provider, WebBaseURL: row.WebBaseURL,
		APIBaseURL: row.APIBaseURL, Repository: repository,
	}
}

func (s *Service) persistValidation(ctx context.Context, row domain.SCMConnection, status domain.SCMConnectionStatus, username string) error {
	ok, err := s.store.UpdateSCMConnectionValidation(ctx, row.ID, row.UpdatedAt, status, username)
	if err != nil {
		return apierr.Internal("SCM_CONNECTION_TEST_STATUS_SAVE_FAILED", "Failed to save SCM connection test status")
	}
	if !ok {
		return apierr.Conflict("SCM_CONNECTION_TEST_STALE", "SCM connection changed while the test was running", nil)
	}
	return nil
}

func (s *Service) cleanupCredential(ctx context.Context, ref string) error {
	cleanupCtx, cancel := newCleanupContext(ctx)
	defer cancel()
	if err := s.credentials.Delete(cleanupCtx, ref); err != nil {
		return apierr.Internal("SCM_CREDENTIAL_CLEANUP_FAILED", "Failed to clean up SCM credential")
	}
	return nil
}

func newCleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
}

func normalizeCreate(in CreateInput, allowLoopbackHTTP bool) (domain.SCMConnection, error) {
	id := strings.TrimSpace(in.ID)
	if !connectionIDPattern.MatchString(id) {
		return domain.SCMConnection{}, apierr.Invalid("INVALID_SCM_CONNECTION_ID", "Invalid SCM connection id", nil)
	}
	return normalizeMetadata(id, in.Provider, in.DisplayName, in.WebBaseURL, in.APIBaseURL, allowLoopbackHTTP)
}

func normalizeUpdate(id string, in UpdateInput, allowLoopbackHTTP bool) (domain.SCMConnection, error) {
	return normalizeMetadata(id, in.Provider, in.DisplayName, in.WebBaseURL, in.APIBaseURL, allowLoopbackHTTP)
}

func normalizeMetadata(id string, provider domain.SCMProvider, displayName, webRaw, apiRaw string, allowLoopbackHTTP bool) (domain.SCMConnection, error) {
	if !provider.IsKnown() {
		return domain.SCMConnection{}, apierr.Invalid("INVALID_SCM_PROVIDER", "Unsupported SCM provider", nil)
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return domain.SCMConnection{}, apierr.Invalid("SCM_CONNECTION_DISPLAY_NAME_REQUIRED", "displayName is required", nil)
	}
	webRaw = strings.TrimSpace(webRaw)
	apiRaw = strings.TrimSpace(apiRaw)
	if webRaw == "" {
		if provider == domain.SCMProviderGitLab {
			webRaw = "https://gitlab.com"
		} else {
			webRaw = "https://github.com"
		}
	}
	webBaseURL, err := normalizeBaseURL(webRaw, allowLoopbackHTTP)
	if err != nil {
		return domain.SCMConnection{}, invalidURLError()
	}
	if apiRaw == "" {
		switch provider {
		case domain.SCMProviderGitLab:
			apiRaw = strings.TrimSuffix(webBaseURL, "/") + "/api/v4"
		case domain.SCMProviderGitHub:
			if webBaseURL != "https://github.com" {
				return domain.SCMConnection{}, invalidURLError()
			}
			apiRaw = "https://api.github.com"
		}
	}
	apiBaseURL, err := normalizeBaseURL(apiRaw, allowLoopbackHTTP)
	if err != nil {
		return domain.SCMConnection{}, invalidURLError()
	}
	return domain.SCMConnection{
		ID: id, Provider: provider, DisplayName: displayName,
		WebBaseURL: webBaseURL, APIBaseURL: apiBaseURL,
	}, nil
}

func normalizeBaseURL(raw string, allowLoopbackHTTP bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" || u.Opaque != "" || u.User != nil ||
		strings.Contains(raw, "?") || strings.Contains(raw, "#") {
		return "", errors.New("invalid base URL")
	}
	if u.Scheme != "https" {
		if !allowLoopbackHTTP || u.Scheme != "http" || !isLoopbackHost(u.Hostname()) {
			return "", errors.New("base URL must use HTTPS")
		}
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	u.RawPath = strings.TrimSuffix(u.RawPath, "/")
	return u.String(), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func connectionView(row domain.SCMConnection, configured bool) Connection {
	status := string(row.Status)
	if status == "" {
		status = StatusUnknown
	}
	username := row.Username
	if !configured {
		status = StatusMissingCredential
		username = ""
	}
	return Connection{
		ID: row.ID, Provider: row.Provider, DisplayName: row.DisplayName,
		WebBaseURL: row.WebBaseURL, APIBaseURL: row.APIBaseURL,
		CredentialConfigured: configured, Status: status, Username: username,
	}
}

func mapTestFailure(result TestResult, err error) (domain.SCMConnectionStatus, string, *apierr.Error) {
	var failure *TestFailure
	if !errors.As(err, &failure) {
		return domain.SCMConnectionStatusUnknown, "", apierr.Internal("SCM_CONNECTION_TEST_FAILED", "Failed to test SCM connection")
	}
	switch failure.Kind {
	case TestFailureAuth:
		return domain.SCMConnectionStatusUnauthorized, "", apierr.New(apierr.KindUnauthorized, "SCM_AUTH_FAILED", "SCM authentication failed", nil)
	case TestFailureForbidden:
		return domain.SCMConnectionStatusForbidden, "", apierr.New(apierr.KindForbidden, "SCM_FORBIDDEN", "SCM access is forbidden", nil)
	case TestFailureUnreachable:
		return domain.SCMConnectionStatusUnreachable, "", apierr.New(apierr.KindUnavailable, "SCM_INSTANCE_UNREACHABLE", "SCM instance is unreachable", nil)
	case TestFailureTLS:
		return domain.SCMConnectionStatusTLSError, "", apierr.New(apierr.KindUnavailable, "SCM_TLS_FAILED", "SCM TLS validation failed", nil)
	case TestFailureRateLimited:
		return domain.SCMConnectionStatusRateLimited, "", apierr.New(apierr.KindRateLimited, "SCM_RATE_LIMITED", "SCM rate limit exceeded", nil)
	case TestFailureRepoNotFound:
		return domain.SCMConnectionStatusConnected, result.Identity.Username, apierr.New(apierr.KindNotFound, "SCM_REPO_NOT_FOUND", "SCM repository was not found", nil)
	case TestFailureWriteScopeMissing:
		return domain.SCMConnectionStatusConnected, result.Identity.Username, apierr.New(apierr.KindForbidden, "SCM_WRITE_SCOPE_MISSING", "SCM credential lacks write access", nil)
	default:
		return domain.SCMConnectionStatusUnknown, "", apierr.Internal("SCM_CONNECTION_TEST_FAILED", "Failed to test SCM connection")
	}
}

func randomCredentialRef(id string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return "scm/" + id + "/" + hex.EncodeToString(value[:]), nil
}

func zero(value []byte) {
	for i := range value {
		value[i] = 0
	}
}

func credentialError() *apierr.Error {
	return apierr.Internal("SCM_CREDENTIAL_STORE_FAILED", "Failed to access SCM credential")
}

func notFoundError() *apierr.Error {
	return apierr.NotFound("SCM_CONNECTION_NOT_FOUND", "Unknown SCM connection")
}

func invalidURLError() *apierr.Error {
	return apierr.Invalid("INVALID_SCM_CONNECTION_URL", "SCM connection URLs must be absolute HTTPS URLs", nil)
}

var connectionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
