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
	storepkg "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

const (
	StatusUnknown           = "unknown"
	StatusConnected         = "connected"
	StatusMissingCredential = "missing_credential"
	StatusUnauthorized      = "unauthorized"
	StatusForbidden         = "forbidden"
	StatusUnreachable       = "unreachable"
	StatusTLSError          = "tls_error"
	StatusRateLimited       = "rate_limited"
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
	Token       *string            `json:"token,omitempty" writeOnly:"true"`
}

// UpdateInput replaces mutable metadata. An omitted token retains the current
// credential, an empty token removes it, and any other value replaces it.
type UpdateInput struct {
	Provider    domain.SCMProvider `json:"provider" enum:"github,gitlab"`
	DisplayName string             `json:"displayName"`
	WebBaseURL  string             `json:"webBaseUrl,omitempty"`
	APIBaseURL  string             `json:"apiBaseUrl,omitempty"`
	Token       *string            `json:"token,omitempty" writeOnly:"true"`
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
	Status       string       `json:"status" enum:"connected,missing_credential,unauthorized,forbidden,unreachable,tls_error,rate_limited"`
	Identity     Identity     `json:"identity"`
	Capabilities Capabilities `json:"capabilities"`
}

// ConnectionTester probes one provider connection using a credential supplied
// only for the duration of the call. Implementations return normalized data.
type ConnectionTester interface {
	Test(ctx context.Context, connection domain.SCMConnection, token []byte) (TestResult, error)
}

// Store is the metadata persistence surface used by Service.
type Store interface {
	CreateSCMConnection(ctx context.Context, connection domain.SCMConnection) error
	GetSCMConnection(ctx context.Context, id string) (domain.SCMConnection, bool, error)
	ListSCMConnections(ctx context.Context) ([]domain.SCMConnection, error)
	UpdateSCMConnection(ctx context.Context, connection domain.SCMConnection) (bool, error)
	DeleteSCMConnection(ctx context.Context, id string) (bool, error)
}

// Manager is the controller-facing SCM connection contract.
type Manager interface {
	Create(ctx context.Context, in CreateInput) (Connection, error)
	List(ctx context.Context) ([]Connection, error)
	Get(ctx context.Context, id string) (Connection, error)
	Update(ctx context.Context, id string, in UpdateInput) (Connection, error)
	Delete(ctx context.Context, id string) error
	Test(ctx context.Context, id string) (TestResult, error)
}

type Deps struct {
	Store            Store
	Credentials      ports.CredentialStore
	Tester           ConnectionTester
	Clock            func() time.Time
	NewCredentialRef func(id string) (string, error)
}

// Service coordinates metadata and credential writes with compensation.
type Service struct {
	store            Store
	credentials      ports.CredentialStore
	tester           ConnectionTester
	clock            func() time.Time
	newCredentialRef func(string) (string, error)
	mu               sync.Mutex
}

var _ Manager = (*Service)(nil)

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
	}
}

func (s *Service) Create(ctx context.Context, in CreateInput) (Connection, error) {
	row, err := normalizeCreate(in)
	if err != nil {
		return Connection{}, err
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
	configured := in.Token != nil && *in.Token != ""
	if configured {
		if err := s.credentials.Put(ctx, row.CredentialRef, []byte(*in.Token)); err != nil {
			return Connection{}, credentialError()
		}
	}
	if err := s.store.CreateSCMConnection(ctx, row); err != nil {
		if configured {
			_ = s.credentials.Delete(ctx, row.CredentialRef)
		}
		if _, exists, getErr := s.store.GetSCMConnection(ctx, row.ID); getErr == nil && exists {
			return Connection{}, apierr.Conflict("SCM_CONNECTION_ALREADY_EXISTS", "An SCM connection with this id already exists", nil)
		}
		return Connection{}, apierr.Internal("SCM_CONNECTION_CREATE_FAILED", "Failed to create SCM connection")
	}
	return connectionView(row, configured), nil
}

func (s *Service) List(ctx context.Context) ([]Connection, error) {
	rows, err := s.store.ListSCMConnections(ctx)
	if err != nil {
		return nil, apierr.Internal("SCM_CONNECTIONS_LIST_FAILED", "Failed to load SCM connections")
	}
	out := make([]Connection, 0, len(rows))
	for _, row := range rows {
		configured, err := s.credentialConfigured(ctx, row.CredentialRef)
		if err != nil {
			return nil, err
		}
		out = append(out, connectionView(row, configured))
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id string) (Connection, error) {
	row, err := s.getRow(ctx, id)
	if err != nil {
		return Connection{}, err
	}
	configured, err := s.credentialConfigured(ctx, row.CredentialRef)
	if err != nil {
		return Connection{}, err
	}
	return connectionView(row, configured), nil
}

func (s *Service) Update(ctx context.Context, id string, in UpdateInput) (Connection, error) {
	id = strings.TrimSpace(id)
	if !connectionIDPattern.MatchString(id) {
		return Connection{}, apierr.Invalid("INVALID_SCM_CONNECTION_ID", "Invalid SCM connection id", nil)
	}
	replacement, err := normalizeUpdate(id, in)
	if err != nil {
		return Connection{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	original, err := s.getRow(ctx, id)
	if err != nil {
		return Connection{}, err
	}
	replacement.CreatedAt = original.CreatedAt
	replacement.UpdatedAt = s.clock().UTC()
	replacement.CredentialRef = original.CredentialRef

	rotated := in.Token != nil
	configured := false
	if !rotated {
		configured, err = s.credentialConfigured(ctx, original.CredentialRef)
		if err != nil {
			return Connection{}, err
		}
	} else {
		replacement.CredentialRef, err = s.newCredentialRef(id)
		if err != nil || replacement.CredentialRef == original.CredentialRef {
			return Connection{}, apierr.Internal("SCM_CONNECTION_UPDATE_FAILED", "Failed to update SCM connection")
		}
		configured = *in.Token != ""
		if configured {
			if err := s.credentials.Put(ctx, replacement.CredentialRef, []byte(*in.Token)); err != nil {
				return Connection{}, credentialError()
			}
		}
	}

	ok, err := s.store.UpdateSCMConnection(ctx, replacement)
	if err != nil || !ok {
		if rotated && configured {
			_ = s.credentials.Delete(ctx, replacement.CredentialRef)
		}
		if err == nil && !ok {
			return Connection{}, notFoundError()
		}
		return Connection{}, apierr.Internal("SCM_CONNECTION_UPDATE_FAILED", "Failed to update SCM connection")
	}
	if rotated {
		if err := s.credentials.Delete(ctx, original.CredentialRef); err != nil {
			_, rollbackErr := s.store.UpdateSCMConnection(ctx, original)
			if configured {
				_ = s.credentials.Delete(ctx, replacement.CredentialRef)
			}
			if rollbackErr != nil {
				return Connection{}, apierr.Internal("SCM_CONNECTION_UPDATE_FAILED", "Failed to update SCM connection")
			}
			return Connection{}, credentialError()
		}
	}
	return connectionView(replacement, configured), nil
}

func (s *Service) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	row, err := s.getRow(ctx, id)
	if err != nil {
		return err
	}
	deleted, err := s.store.DeleteSCMConnection(ctx, row.ID)
	if errors.Is(err, storepkg.ErrSCMConnectionReferenced) {
		return apierr.Conflict("SCM_CONNECTION_REFERENCED", "SCM connection is referenced by a project", nil)
	}
	if err != nil {
		return apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to delete SCM connection")
	}
	if !deleted {
		return notFoundError()
	}
	secret, configured, err := s.credentials.Get(ctx, row.CredentialRef)
	if err != nil {
		if restoreErr := s.store.CreateSCMConnection(ctx, row); restoreErr != nil {
			return apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to delete SCM connection")
		}
		return credentialError()
	}
	if err := s.credentials.Delete(ctx, row.CredentialRef); err != nil {
		restoreErr := s.store.CreateSCMConnection(ctx, row)
		if restoreErr == nil && configured {
			restoreErr = s.credentials.Put(ctx, row.CredentialRef, secret)
		}
		if restoreErr != nil {
			return apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to delete SCM connection")
		}
		return apierr.Internal("SCM_CONNECTION_DELETE_FAILED", "Failed to delete SCM connection")
	}
	return nil
}

func (s *Service) Test(ctx context.Context, id string) (TestResult, error) {
	row, err := s.getRow(ctx, id)
	if err != nil {
		return TestResult{}, err
	}
	token, ok, err := s.credentials.Get(ctx, row.CredentialRef)
	if err != nil {
		return TestResult{}, credentialError()
	}
	if !ok {
		return TestResult{Status: StatusMissingCredential}, nil
	}
	defer zero(token)
	if s.tester == nil {
		return TestResult{}, apierr.Internal("SCM_CONNECTION_TEST_UNAVAILABLE", "SCM connection testing is unavailable")
	}
	result, err := s.tester.Test(ctx, row, token)
	if err != nil || !validTestStatus(result.Status) {
		return TestResult{}, apierr.Internal("SCM_CONNECTION_TEST_FAILED", "Failed to test SCM connection")
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

func (s *Service) credentialConfigured(ctx context.Context, ref string) (bool, error) {
	secret, ok, err := s.credentials.Get(ctx, ref)
	zero(secret)
	if err != nil {
		return false, credentialError()
	}
	return ok, nil
}

func normalizeCreate(in CreateInput) (domain.SCMConnection, error) {
	id := strings.TrimSpace(in.ID)
	if !connectionIDPattern.MatchString(id) {
		return domain.SCMConnection{}, apierr.Invalid("INVALID_SCM_CONNECTION_ID", "Invalid SCM connection id", nil)
	}
	return normalizeMetadata(id, in.Provider, in.DisplayName, in.WebBaseURL, in.APIBaseURL)
}

func normalizeUpdate(id string, in UpdateInput) (domain.SCMConnection, error) {
	return normalizeMetadata(id, in.Provider, in.DisplayName, in.WebBaseURL, in.APIBaseURL)
}

func normalizeMetadata(id string, provider domain.SCMProvider, displayName, webRaw, apiRaw string) (domain.SCMConnection, error) {
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
	webBaseURL, err := normalizeBaseURL(webRaw)
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
	apiBaseURL, err := normalizeBaseURL(apiRaw)
	if err != nil {
		return domain.SCMConnection{}, invalidURLError()
	}
	return domain.SCMConnection{
		ID: id, Provider: provider, DisplayName: displayName,
		WebBaseURL: webBaseURL, APIBaseURL: apiBaseURL,
	}, nil
}

func normalizeBaseURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", errors.New("invalid base URL")
	}
	if u.Scheme != "https" {
		if u.Scheme != "http" || !isLoopbackHost(u.Hostname()) {
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
	status := StatusUnknown
	if !configured {
		status = StatusMissingCredential
	}
	return Connection{
		ID: row.ID, Provider: row.Provider, DisplayName: row.DisplayName,
		WebBaseURL: row.WebBaseURL, APIBaseURL: row.APIBaseURL,
		CredentialConfigured: configured, Status: status,
	}
}

func validTestStatus(status string) bool {
	switch status {
	case StatusConnected, StatusMissingCredential, StatusUnauthorized, StatusForbidden,
		StatusUnreachable, StatusTLSError, StatusRateLimited:
		return true
	default:
		return false
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
	return apierr.Invalid("INVALID_SCM_CONNECTION_URL", "SCM connection URLs must be absolute HTTPS URLs; loopback HTTP is allowed for development", nil)
}

var connectionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
