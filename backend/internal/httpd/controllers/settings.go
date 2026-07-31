package controllers

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// PipelinesEnabledSettingKey is the app_settings key holding the persisted
// pipelines feature flag. The daemon reads it at boot (see
// backend/internal/daemon.resolvePipelinesEnabled) and this controller
// reads/writes it from the Settings UI. The value is a strconv-formatted bool.
const PipelinesEnabledSettingKey = "pipelines.enabled"

// SettingsStore is the controller-facing global app-settings contract. It is a
// tiny key/value store the daemon persists in its own SQLite DB so the value is
// visible to both the Electron supervisor and a headless `ao start`.
type SettingsStore interface {
	GetAppSetting(ctx context.Context, key string) (string, error)
	SetAppSetting(ctx context.Context, key, value string) error
}

// SettingsController owns the ungated /settings routes. These are deliberately
// NOT behind the pipelines flag: the pipelines toggle has to be reachable in
// order to turn the flag on.
type SettingsController struct {
	Store SettingsStore
}

// PipelinesSettingResponse is the wire shape for the persisted pipelines flag.
type PipelinesSettingResponse struct {
	Enabled bool `json:"enabled"`
}

// SetPipelinesSettingRequest is the PUT body toggling the persisted flag.
type SetPipelinesSettingRequest struct {
	Enabled bool `json:"enabled"`
}

// Register mounts the settings REST routes on the supplied router.
func (c *SettingsController) Register(r chi.Router) {
	r.Get("/settings/pipelines", c.getPipelines)
	r.Put("/settings/pipelines", c.setPipelines)
}

func (c *SettingsController) getPipelines(w http.ResponseWriter, r *http.Request) {
	if c.Store == nil {
		writeInternalError(w, r)
		return
	}
	raw, err := c.Store.GetAppSetting(r.Context(), PipelinesEnabledSettingKey)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	// A missing/blank/garbage value parses to false — the safe default.
	enabled, _ := strconv.ParseBool(raw)
	envelope.WriteJSON(w, http.StatusOK, PipelinesSettingResponse{Enabled: enabled})
}

func (c *SettingsController) setPipelines(w http.ResponseWriter, r *http.Request) {
	if c.Store == nil {
		writeInternalError(w, r)
		return
	}
	var in SetPipelinesSettingRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if err := c.Store.SetAppSetting(r.Context(), PipelinesEnabledSettingKey, strconv.FormatBool(in.Enabled)); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelinesSettingResponse(in))
}

func writeInternalError(w http.ResponseWriter, r *http.Request) {
	envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "INTERNAL_ERROR", "Internal server error", nil)
}
