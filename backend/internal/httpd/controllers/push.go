package controllers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// PushRegistry is the controller-facing push-device registry contract, satisfied
// by *mobilebridge.DeviceRegistry.
type PushRegistry interface {
	Upsert(dev mobilebridge.PushDevice) error
	Delete(token string) error
}

// PushController owns the /push/devices routes: a paired phone registers (and
// unregisters) its Expo push token so the daemon's dispatcher can reach it. The
// routes live on the REST surface behind the shared Bearer auth, so only a phone
// holding the connection password can register.
type PushController struct {
	Registry PushRegistry
	// Now stamps CreatedAt/LastSeenAt; overridable in tests. Defaults to time.Now.
	Now func() time.Time
}

// Register mounts the push-device routes on the supplied router.
func (c *PushController) Register(r chi.Router) {
	r.Post("/push/devices", c.register)
	r.Delete("/push/devices/{token}", c.unregister)
}

func (c *PushController) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func (c *PushController) register(w http.ResponseWriter, r *http.Request) {
	if c.Registry == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/push/devices")
		return
	}
	var req RegisterPushDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if !mobilebridge.ValidPushToken(req.Token) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PUSH_TOKEN",
			"token must be a well-formed Expo push token", nil)
		return
	}
	now := c.now()
	dev := mobilebridge.PushDevice{
		Token:      req.Token,
		Platform:   req.Platform,
		DeviceName: req.DeviceName,
		CreatedAt:  now,
		LastSeenAt: now,
	}
	if err := c.Registry.Upsert(dev); err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "PUSH_REGISTER", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PushDeviceEnvelope{Device: PushDeviceResponse{
		Token:      dev.Token,
		Platform:   dev.Platform,
		DeviceName: dev.DeviceName,
		CreatedAt:  dev.CreatedAt,
		LastSeenAt: dev.LastSeenAt,
	}})
}

func (c *PushController) unregister(w http.ResponseWriter, r *http.Request) {
	if c.Registry == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/push/devices/{token}")
		return
	}
	// chi decodes the percent-encoded token (the Expo token's [ ] brackets are
	// URL-encoded by the client). Deleting an unknown token is a clean no-op.
	token := chi.URLParam(r, "token")
	if err := c.Registry.Delete(token); err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "PUSH_UNREGISTER", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, UnregisterPushDeviceResponse{Token: token, Deleted: true})
}
