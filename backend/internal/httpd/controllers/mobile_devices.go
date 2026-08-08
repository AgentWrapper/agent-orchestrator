package controllers

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// DeviceRoster is the management view of the push-device registry, satisfied by
// *mobilebridge.DeviceRegistry.
type DeviceRoster interface {
	List() []mobilebridge.PushDevice
	SetMuted(installID string, muted bool) error
	Delete(installID string) error
}

// LiveSet reports which install ids are currently running the app, satisfied by
// *presence.Tracker.
type LiveSet interface {
	Live() map[string]bool
}

// MobileDevicesController owns the desktop-only roster routes. They are mounted
// under /api/v1/mobile, which lanControlBlock 404s on the LAN listener, so a
// paired phone can neither enumerate the household's devices nor unmute itself.
type MobileDevicesController struct {
	Registry DeviceRoster
	Presence LiveSet
}

// writeRegistryUnavailable answers a request with 503 DEVICE_REGISTRY_UNAVAILABLE.
// Shared by List/Mute/Remove for the one failure mode they all guard against: a
// device registry that failed to load (e.g. a corrupt push-devices.json),
// which must not prevent the daemon from starting or the rest of the app from
// working.
func writeRegistryUnavailable(w http.ResponseWriter, r *http.Request) {
	envelope.WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "DEVICE_REGISTRY_UNAVAILABLE",
		"The mobile device registry failed to load; device management is unavailable until the daemon restarts with a valid registry", nil)
}

// List handles GET /api/v1/mobile/devices.
func (c *MobileDevicesController) List(w http.ResponseWriter, r *http.Request) {
	if c.Registry == nil {
		writeRegistryUnavailable(w, r)
		return
	}
	devices := c.Registry.List()
	live := map[string]bool{}
	if c.Presence != nil {
		live = c.Presence.Live()
	}
	out := make([]MobileDeviceResponse, 0, len(devices))
	for _, d := range devices {
		out = append(out, MobileDeviceResponse{
			InstallID:            d.InstallID,
			Token:                d.Token,
			Platform:             d.Platform,
			DeviceName:           d.DeviceName,
			Muted:                d.Muted,
			Live:                 live[d.InstallID],
			NotificationsEnabled: d.Token != "",
			CreatedAt:            d.CreatedAt,
			LastSeenAt:           d.LastSeenAt,
		})
	}
	// Live devices first, then most-recently-seen, so the phone you are holding
	// is at the top of the list.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Live != out[j].Live {
			return out[i].Live
		}
		return out[i].LastSeenAt.After(out[j].LastSeenAt)
	})
	envelope.WriteJSON(w, http.StatusOK, MobileDevicesResponse{Devices: out})
}

// Mute handles PATCH /api/v1/mobile/devices/{installId}.
func (c *MobileDevicesController) Mute(w http.ResponseWriter, r *http.Request) {
	if c.Registry == nil {
		writeRegistryUnavailable(w, r)
		return
	}
	installID := chi.URLParam(r, "installId")
	var req MuteDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if err := c.Registry.SetMuted(installID, req.Muted); err != nil {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "DEVICE_NOT_FOUND", "Unknown device", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, map[string]bool{"muted": req.Muted})
}

// Remove handles DELETE /api/v1/mobile/devices/{installId}.
func (c *MobileDevicesController) Remove(w http.ResponseWriter, r *http.Request) {
	if c.Registry == nil {
		writeRegistryUnavailable(w, r)
		return
	}
	if err := c.Registry.Delete(chi.URLParam(r, "installId")); err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "DEVICE_DELETE_FAILED", "Could not remove device", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
