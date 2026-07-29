package auth

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// Handler exposes cloud auth endpoints.
type Handler struct {
	Store  Store
	Issuer *Issuer
	Google GoogleProvider
	Now    func() time.Time
}

// Register mounts cloud authentication routes.
func (h *Handler) Register(r chi.Router) {
	r.Get("/auth/google/login", h.googleLogin)
	r.Get("/auth/google/callback", h.googleCallback)
	r.Post("/auth/refresh", h.refresh)
	r.Post("/auth/device/code", h.deviceCode)
	r.Post("/auth/device/approve", h.deviceApprove)
	r.Post("/auth/device/token", h.deviceToken)
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) googleLogin(w http.ResponseWriter, r *http.Request) {
	if h.Google == nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "GOOGLE_AUTH_NOT_CONFIGURED", "Google OAuth is not configured", nil)
		return
	}
	state, err := randomToken(18)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	http.Redirect(w, r, h.Google.AuthCodeURL(state), http.StatusFound)
}

func (h *Handler) googleCallback(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil || h.Issuer == nil || h.Google == nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "AUTH_NOT_CONFIGURED", "Cloud auth is not configured", nil)
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "CODE_REQUIRED", "code is required", nil)
		return
	}
	profile, err := h.Google.Exchange(r.Context(), code)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	user, orgs, err := h.Store.UpsertGoogleUser(r.Context(), profile)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	h.writeTokenPair(w, r, user, orgs)
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	user, orgs, ok, err := h.Store.ConsumeRefreshToken(r.Context(), HashRefreshToken(in.RefreshToken), h.now())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusUnauthorized, "unauthorized", "REFRESH_TOKEN_INVALID", "Invalid refresh token", nil)
		return
	}
	h.writeTokenPair(w, r, user, orgs)
}

func (h *Handler) deviceCode(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ClientName string `json:"clientName"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	deviceCode, err := randomToken(32)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	userCode, err := randomUserCode()
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	now := h.now()
	rec := DeviceCode{
		ID:             uuid.NewString(),
		DeviceCodeHash: HashRefreshToken(deviceCode),
		UserCode:       userCode,
		ClientName:     strings.TrimSpace(in.ClientName),
		ExpiresAt:      now.Add(10 * time.Minute),
		CreatedAt:      now,
	}
	if err := h.Store.CreateDeviceCode(r.Context(), rec); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, map[string]any{
		"deviceCode":      deviceCode,
		"userCode":        userCode,
		"verificationUri": "/auth/device/approve",
		"expiresIn":       int(time.Until(rec.ExpiresAt).Seconds()),
		"interval":        5,
	})
}

func (h *Handler) deviceApprove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID   string `json:"userId"`
		UserCode string `json:"userCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	ok, err := h.Store.ApproveDeviceCode(r.Context(), strings.TrimSpace(in.UserID), strings.TrimSpace(in.UserCode), h.now())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "DEVICE_CODE_NOT_FOUND", "Unknown or expired device code", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) deviceToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceCode string `json:"deviceCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	_, user, orgs, ok, err := h.Store.PollDeviceCode(r.Context(), HashRefreshToken(in.DeviceCode), h.now())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "AUTHORIZATION_PENDING", "Device authorization is pending", nil)
		return
	}
	h.writeTokenPair(w, r, user, orgs)
}

func (h *Handler) writeTokenPair(w http.ResponseWriter, r *http.Request, user User, orgs []Org) {
	orgIDs := make([]string, 0, len(orgs))
	for _, org := range orgs {
		orgIDs = append(orgIDs, org.ID)
	}
	pair, err := h.Issuer.Issue(user.ID, orgIDs)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	now := h.now()
	if err := h.Store.StoreRefreshToken(r.Context(), APIToken{
		ID:        uuid.NewString(),
		UserID:    user.ID,
		TokenHash: HashRefreshToken(pair.RefreshToken),
		Kind:      "refresh",
		ExpiresAt: now.Add(h.Issuer.RefreshTokenTTL()),
		CreatedAt: now,
	}); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, map[string]any{
		"accessToken":  pair.AccessToken,
		"refreshToken": pair.RefreshToken,
		"expiresAt":    pair.ExpiresAt,
		"user":         user,
		"orgs":         orgs,
	})
}

func randomUserCode() (string, error) {
	code, err := randomToken(5)
	if err != nil {
		return "", err
	}
	code = strings.ToUpper(strings.ReplaceAll(code, "_", "A"))
	if len(code) > 8 {
		code = code[:8]
	}
	return code, nil
}
