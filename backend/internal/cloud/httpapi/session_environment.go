package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudworker "github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

const (
	maxSessionEnvironmentVariables = 100
	maxSessionEnvironmentValueSize = 64 << 10
	maxSessionEnvironmentTotalSize = 128 << 10
)

var sessionEnvironmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type sessionEnvironmentResponse struct {
	Revision    int64    `json:"revision"`
	Names       []string `json:"names"`
	UpdatedAt   string   `json:"updatedAt,omitempty"`
	WillRestart bool     `json:"willRestart,omitempty"`
}

func (s *Server) getSessionEnvironment(w http.ResponseWriter, r *http.Request) {
	_, session, ok := s.authorizeSessionEnvironmentManager(w, r)
	if !ok {
		return
	}
	values, environment, err := s.loadSessionEnvironment(r, session.OrgID, session.ID)
	if err != nil {
		s.internalError(w, r, "load session environment", err)
		return
	}
	defer clear(values)
	writeJSON(w, http.StatusOK, sessionEnvironmentMetadata(environment, values, false))
}

func (s *Server) updateSessionEnvironment(w http.ResponseWriter, r *http.Request) {
	principal, session, ok := s.authorizeSessionEnvironmentManager(w, r)
	if !ok {
		return
	}
	var input struct {
		ExpectedRevision int64 `json:"expectedRevision"`
		Upserts          []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"upserts"`
		Removals []string `json:"removals"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	values, _, err := s.loadSessionEnvironment(r, session.OrgID, session.ID)
	if err != nil {
		s.internalError(w, r, "load session environment for update", err)
		return
	}
	defer clear(values)
	for _, name := range input.Removals {
		name = strings.TrimSpace(name)
		if !validSessionEnvironmentName(name) {
			writeError(w, r, http.StatusBadRequest, "INVALID_ENVIRONMENT_NAME", "Environment variable names must be valid and cannot replace AO runtime values.")
			return
		}
		delete(values, name)
	}
	for _, upsert := range input.Upserts {
		name := strings.TrimSpace(upsert.Name)
		if !validSessionEnvironmentName(name) {
			writeError(w, r, http.StatusBadRequest, "INVALID_ENVIRONMENT_NAME", "Environment variable names must be valid and cannot replace AO runtime values.")
			return
		}
		if upsert.Value == "" || len(upsert.Value) > maxSessionEnvironmentValueSize {
			writeError(w, r, http.StatusBadRequest, "INVALID_ENVIRONMENT_VALUE", "Environment variable values must be non-empty and no larger than 64 KiB.")
			return
		}
		values[name] = upsert.Value
	}
	if err := validateSessionEnvironment(values); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_SESSION_ENVIRONMENT", err.Error())
		return
	}
	plaintext, err := json.Marshal(values)
	if err != nil {
		s.internalError(w, r, "encode session environment", err)
		return
	}
	encrypted, nonce, err := s.secretCipher.Encrypt(
		plaintext,
		sessionEnvironmentAssociatedData(session.OrgID, session.ID),
	)
	clear(plaintext)
	if err != nil {
		s.internalError(w, r, "encrypt session environment", err)
		return
	}
	environment, err := s.store.UpdateSessionEnvironment(
		r.Context(),
		session.OrgID,
		session.ID,
		principal.UserID,
		input.ExpectedRevision,
		encrypted,
		nonce,
	)
	if errors.Is(err, cloudpostgres.ErrSessionEnvironmentConflict) {
		writeError(w, r, http.StatusConflict, "ENVIRONMENT_CHANGED", "Environment variables changed elsewhere. Reload and try again.")
		return
	}
	if err != nil {
		s.internalError(w, r, "save session environment", err)
		return
	}
	willRestart := sessionHasCapability(session, "environment.sync.v1")
	if willRestart {
		if err := s.workerHub.Send(session.ID, cloudworkerhub.Command{
			Type:     "environment_sync",
			Revision: environment.Revision,
		}); err != nil {
			s.internalError(w, r, "queue session environment update", err)
			return
		}
	}
	writeJSON(w, http.StatusOK, sessionEnvironmentMetadata(environment, values, willRestart))
}

func (s *Server) workerEnvironment(w http.ResponseWriter, r *http.Request) {
	claims := workerFromContext(r.Context())
	if !cloudworker.HasScope(claims, "worker:terminal") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "worker:terminal scope is required.")
		return
	}
	values, environment, err := s.loadSessionEnvironment(r, clouddomain.OrgID(claims.AccountID), claims.SessionID)
	if err != nil {
		s.internalError(w, r, "load worker session environment", err)
		return
	}
	defer clear(values)
	writeJSON(w, http.StatusOK, map[string]any{
		"revision": environment.Revision,
		"values":   values,
	})
}

func (s *Server) authorizeSessionEnvironmentManager(
	w http.ResponseWriter,
	r *http.Request,
) (cloudauth.Principal, clouddomain.Session, bool) {
	principal, ok := cloudauth.PrincipalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "A valid AO Cloud login is required.")
		return cloudauth.Principal{}, clouddomain.Session{}, false
	}
	account, _ := accountFromContext(r.Context())
	sessionID := clouddomain.SessionID(strings.TrimSpace(chi.URLParam(r, "sessionId")))
	session, err := s.store.GetSession(r.Context(), account.ID, sessionID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The cloud session does not exist.")
		return cloudauth.Principal{}, clouddomain.Session{}, false
	}
	if err != nil {
		s.internalError(w, r, "load session environment owner", err)
		return cloudauth.Principal{}, clouddomain.Session{}, false
	}
	if shared, sharedOK := sharedProjectAccessFromContext(r.Context()); sharedOK {
		if !shared.canManageProject(session.ProjectID) {
			writeError(w, r, http.StatusForbidden, "PROJECT_SHARE_MANAGER_REQUIRED", "Only trusted project collaborators can manage environment variables.")
			return cloudauth.Principal{}, clouddomain.Session{}, false
		}
	} else {
		org, orgOK := orgFromContext(r.Context())
		if !orgOK || !orgRoleAtLeast(org.Membership.Role, "admin") {
			writeError(w, r, http.StatusForbidden, "ORG_ROLE_REQUIRED", "Only organization owners and admins can manage environment variables.")
			return cloudauth.Principal{}, clouddomain.Session{}, false
		}
	}
	return principal, session, true
}

func (s *Server) loadSessionEnvironment(
	r *http.Request,
	orgID clouddomain.OrgID,
	sessionID clouddomain.SessionID,
) (map[string]string, cloudpostgres.SessionEnvironment, error) {
	environment, err := s.store.GetSessionEnvironment(r.Context(), orgID, sessionID)
	if err != nil {
		return nil, cloudpostgres.SessionEnvironment{}, err
	}
	if environment.Revision == 0 {
		return map[string]string{}, environment, nil
	}
	plaintext, err := s.secretCipher.Decrypt(
		environment.EncryptedValues,
		environment.ValuesNonce,
		sessionEnvironmentAssociatedData(orgID, sessionID),
	)
	if err != nil {
		return nil, cloudpostgres.SessionEnvironment{}, err
	}
	defer clear(plaintext)
	values := map[string]string{}
	if err := json.Unmarshal(plaintext, &values); err != nil {
		return nil, cloudpostgres.SessionEnvironment{}, err
	}
	return values, environment, nil
}

func sessionEnvironmentMetadata(
	environment cloudpostgres.SessionEnvironment,
	values map[string]string,
	willRestart bool,
) sessionEnvironmentResponse {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	response := sessionEnvironmentResponse{
		Revision:    environment.Revision,
		Names:       names,
		WillRestart: willRestart,
	}
	if !environment.UpdatedAt.IsZero() {
		response.UpdatedAt = environment.UpdatedAt.UTC().Format(time.RFC3339Nano)
	}
	return response
}

func sessionEnvironmentAssociatedData(orgID clouddomain.OrgID, sessionID clouddomain.SessionID) string {
	return "session-env:v1:" + string(orgID) + ":" + string(sessionID)
}

func validSessionEnvironmentName(name string) bool {
	if len(name) > 128 || !sessionEnvironmentNamePattern.MatchString(name) {
		return false
	}
	upper := strings.ToUpper(name)
	if strings.HasPrefix(upper, "AO_") {
		return false
	}
	switch upper {
	case "HOME", "PATH", "PWD", "OLDPWD", "SHELL", "SHLVL", "TERM",
		"CLAUDE_CONFIG_DIR", "CODEX_HOME", "GH_REPO", "GITHUB_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CURSOR_API_KEY":
		return false
	default:
		return true
	}
}

func validateSessionEnvironment(values map[string]string) error {
	if len(values) > maxSessionEnvironmentVariables {
		return errors.New("a session can have at most 100 environment variables")
	}
	total := 0
	for name, value := range values {
		if !validSessionEnvironmentName(name) || value == "" || len(value) > maxSessionEnvironmentValueSize {
			return errors.New("the environment contains an invalid name or value")
		}
		total += len(name) + len(value)
	}
	if total > maxSessionEnvironmentTotalSize {
		return errors.New("the environment can contain at most 128 KiB")
	}
	return nil
}

func sessionHasCapability(session clouddomain.Session, capability string) bool {
	for _, current := range session.Capabilities {
		if current == capability {
			return true
		}
	}
	return false
}
