package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func TestValidSessionEnvironmentNameRejectsRuntimeOverrides(t *testing.T) {
	for _, name := range []string{
		"AO_WORKER_TOKEN",
		"PATH",
		"GITHUB_TOKEN",
		"ANTHROPIC_API_KEY",
		"bad-name",
		"1TOKEN",
		"",
	} {
		if validSessionEnvironmentName(name) {
			t.Fatalf("validSessionEnvironmentName(%q) = true", name)
		}
	}
	for _, name := range []string{"DATABASE_URL", "_PRIVATE_TOKEN", "NEXT_PUBLIC_API_URL"} {
		if !validSessionEnvironmentName(name) {
			t.Fatalf("validSessionEnvironmentName(%q) = false", name)
		}
	}
}

func TestValidateSessionEnvironmentLimitsAggregateSize(t *testing.T) {
	values := map[string]string{}
	for index := 0; index < maxSessionEnvironmentVariables+1; index++ {
		values["KEY_"+string(rune('A'+index%26))+string(rune('a'+index/26))] = "value"
	}
	if err := validateSessionEnvironment(values); err == nil {
		t.Fatal("validateSessionEnvironment() accepted too many values")
	}
}

func TestSessionEnvironmentManagerAuthorization(t *testing.T) {
	projectID := clouddomain.ProjectID("project-one")
	session := clouddomain.Session{
		ID:        "session-one",
		OrgID:     "org-one",
		AccountID: "org-one",
		ProjectID: projectID,
	}
	tests := []struct {
		name       string
		role       string
		shared     *sharedProjectAccess
		authorized bool
	}{
		{name: "owner", role: "owner", authorized: true},
		{name: "admin", role: "admin", authorized: true},
		{name: "ordinary member", role: "member"},
		{
			name: "trusted collaborator",
			shared: &sharedProjectAccess{
				ProjectIDs:      map[clouddomain.ProjectID]struct{}{projectID: {}},
				Roles:           map[clouddomain.ProjectID]string{projectID: "editor"},
				ManagedProjects: map[clouddomain.ProjectID]struct{}{projectID: {}},
			},
			authorized: true,
		},
		{
			name: "standard collaborator",
			shared: &sharedProjectAccess{
				ProjectIDs: map[clouddomain.ProjectID]struct{}{projectID: {}},
				Roles:      map[clouddomain.ProjectID]string{projectID: "editor"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := &Server{store: &sessionEnvironmentAuthStore{session: session}}
			request := httptest.NewRequest(http.MethodGet, "/environment", nil)
			route := chi.NewRouteContext()
			route.URLParams.Add("sessionId", string(session.ID))
			ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
			ctx = cloudauth.ContextWithPrincipal(ctx, cloudauth.Principal{UserID: "user-one"})
			ctx = context.WithValue(ctx, accountContextKey{}, clouddomain.Account{ID: "org-one"})
			ctx = context.WithValue(ctx, orgContextKey{}, clouddomain.UserOrganization{
				Membership: clouddomain.OrgMembership{Role: test.role},
			})
			if test.shared != nil {
				ctx = context.WithValue(ctx, sharedProjectAccessContextKey{}, *test.shared)
			}
			recorder := httptest.NewRecorder()
			_, _, authorized := server.authorizeSessionEnvironmentManager(
				recorder,
				request.WithContext(ctx),
			)
			if authorized != test.authorized {
				t.Fatalf("authorized = %v, status = %d", authorized, recorder.Code)
			}
		})
	}
}

type sessionEnvironmentAuthStore struct {
	store
	session clouddomain.Session
}

func (s *sessionEnvironmentAuthStore) GetSession(
	context.Context,
	clouddomain.AccountID,
	clouddomain.SessionID,
) (clouddomain.Session, error) {
	return s.session, nil
}
