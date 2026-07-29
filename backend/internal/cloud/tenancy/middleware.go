package tenancy

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// Claims is the authenticated principal data the tenancy middleware needs.
type Claims struct {
	Subject   string
	OrgIDs    []string
	SessionID string
}

// TokenVerifier verifies an access token and returns its tenant-bearing claims.
type TokenVerifier interface {
	VerifyAccessToken(token string) (Claims, error)
}

// MembershipStore checks current organization membership at request time.
type MembershipStore interface {
	IsOrgMember(ctx context.Context, userID, orgID string) (bool, error)
}

// Middleware authenticates a bearer access token and scopes the request to the
// selected organization. X-AO-Org-ID is optional when the token has exactly one
// org membership.
func Middleware(verifier TokenVerifier, memberships MembershipStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if verifier == nil || memberships == nil {
				envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "AUTH_NOT_CONFIGURED",
					"Cloud authentication is not configured", nil)
				return
			}
			token := bearerToken(r)
			if token == "" {
				envelope.WriteAPIError(w, r, http.StatusUnauthorized, "unauthorized", "ACCESS_TOKEN_REQUIRED",
					"Missing bearer access token", nil)
				return
			}
			claims, err := verifier.VerifyAccessToken(token)
			if err != nil {
				envelope.WriteAPIError(w, r, http.StatusUnauthorized, "unauthorized", "ACCESS_TOKEN_INVALID",
					"Invalid bearer access token", nil)
				return
			}
			orgID := strings.TrimSpace(r.Header.Get("X-AO-Org-ID"))
			if orgID == "" && len(claims.OrgIDs) == 1 {
				orgID = claims.OrgIDs[0]
			}
			if orgID == "" {
				envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "ORG_REQUIRED",
					"X-AO-Org-ID is required when the token can access multiple orgs", nil)
				return
			}
			if !slices.Contains(claims.OrgIDs, orgID) {
				envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "ORG_FORBIDDEN",
					"Token is not authorized for this org", nil)
				return
			}
			if claims.SessionID != "" {
				if !sessionActivityPath(r, claims.SessionID) {
					envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "SESSION_TOKEN_FORBIDDEN",
						"Session token is only authorized for that session's activity route", nil)
					return
				}
				next.ServeHTTP(w, r.WithContext(WithScope(r.Context(), Scope{UserID: claims.Subject, OrgID: orgID})))
				return
			}
			ok, err := memberships.IsOrgMember(r.Context(), claims.Subject, orgID)
			if err != nil {
				envelope.WriteError(w, r, err)
				return
			}
			if !ok {
				envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "ORG_FORBIDDEN",
					"Token is not authorized for this org", nil)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithScope(r.Context(), Scope{UserID: claims.Subject, OrgID: orgID})))
		})
	}
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
}

func sessionActivityPath(r *http.Request, sessionID string) bool {
	if r.Method != http.MethodPost {
		return false
	}
	return r.URL.Path == "/api/v1/sessions/"+sessionID+"/activity"
}
