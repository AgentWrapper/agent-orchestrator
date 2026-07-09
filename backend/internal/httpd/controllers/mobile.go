package controllers

import (
	"context"
	"net/http"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

const mobileUnencryptedWarning = "Traffic on this connection is not encrypted. Only use it on a network you trust."

type mobileBridge interface {
	Status() MobileStatusResponse
	Enable() (MobileStatusResponse, error)
	Disable() error
	Regenerate() (MobileStatusResponse, error)
}

// MobileController exposes the Connect Mobile bridge control endpoints
// (status/enable/disable/regenerate) over the loopback API, delegating to a
// mobileBridge and stamping the unencrypted-LAN warning onto every response.
type MobileController struct{ Bridge mobileBridge }

// withWarning stamps the constant unencrypted-LAN warning onto any bridge
// response. The warning is not bridge-specific state — it's always present —
// so the controller guarantees it here rather than trusting every mobileBridge
// implementation (including test fakes) to set it.
func withWarning(res MobileStatusResponse) MobileStatusResponse {
	res.Warning = mobileUnencryptedWarning
	return res
}

// Status returns the current bridge status.
func (c *MobileController) Status(w http.ResponseWriter, r *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, withWarning(c.Bridge.Status()))
}

// Enable turns the bridge on and returns the resulting status (with password).
func (c *MobileController) Enable(w http.ResponseWriter, r *http.Request) {
	res, err := c.Bridge.Enable()
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "MOBILE_ENABLE", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, withWarning(res))
}

// Disable turns the bridge off and returns the resulting status.
func (c *MobileController) Disable(w http.ResponseWriter, r *http.Request) {
	if err := c.Bridge.Disable(); err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "MOBILE_DISABLE", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, withWarning(c.Bridge.Status()))
}

// Regenerate rotates the connection password and returns the resulting status.
func (c *MobileController) Regenerate(w http.ResponseWriter, r *http.Request) {
	res, err := c.Bridge.Regenerate()
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "MOBILE_REGEN", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, withWarning(res))
}

// LANController is the runtime hook set the concrete bridge needs. httpd's
// LANManager + authState satisfy it (adapter wired in daemon.go).
type LANController interface {
	Start(port int) (int, error)
	Stop(ctx context.Context) error
	Running() bool
	BoundPort() int
	SetPasswordHash(hash string)
	PasswordHash() string
}

// BridgeService is the production mobileBridge. It persists state and drives
// the LAN listener. Password plaintext exists only transiently in the response.
type BridgeService struct {
	LAN         LANController
	ConfigPath  string
	DefaultPort int
}

func (b *BridgeService) currentHost() string { return mobilebridge.AutopickLANIP() }

// Status reports the current bridge state, host, and port. The plaintext
// password is included only while the bridge is enabled (loopback route only).
func (b *BridgeService) Status() MobileStatusResponse {
	st, _ := mobilebridge.Load(b.ConfigPath)
	enabled := st.Enabled && b.LAN.Running()
	res := MobileStatusResponse{
		Enabled: enabled,
		Host:    b.currentHost(),
		Port:    b.LAN.BoundPort(),
		Warning: mobileUnencryptedWarning,
	}
	// Only surface the password while the bridge is actually enabled. This route
	// is reachable only on the loopback listener (the LAN listener 404s
	// /api/v1/mobile via lanControlBlock), so the plaintext never reaches a phone.
	if enabled {
		res.Password = st.Password
	}
	return res
}

func (b *BridgeService) enableWithPassword(pw string) (MobileStatusResponse, error) {
	// Snapshot state so we can roll back the in-memory side effects (armed hash,
	// running listener) if we fail before durable state is written. Otherwise a
	// failed enable would leave a LAN listener open on 0.0.0.0 with the new
	// password while persisted state/UI still say the bridge is off.
	prevHash := b.LAN.PasswordHash()
	wasRunning := b.LAN.Running()

	// The persisted password is plaintext; the auth hash is derived in memory.
	b.LAN.SetPasswordHash(mobilebridge.HashPassword(pw))
	port, err := b.LAN.Start(b.DefaultPort)
	if err != nil {
		b.LAN.SetPasswordHash(prevHash) // Start failed: undo the hash swap.
		return MobileStatusResponse{}, err
	}
	if err := mobilebridge.Save(b.ConfigPath, mobilebridge.State{Enabled: true, Password: pw, LastPort: port}); err != nil {
		// Persist failed after the listener came up. Roll back so reality matches
		// the unchanged persisted state (and the UI's "enable failed"). A rotate on
		// an already-running listener (wasRunning) keeps serving on the prior hash;
		// a fresh enable tears the listener back down.
		if !wasRunning {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = b.LAN.Stop(ctx)
		}
		b.LAN.SetPasswordHash(prevHash)
		return MobileStatusResponse{}, err
	}
	return b.Status(), nil
}

// Enable generates a fresh password, arms the auth hash, and starts the LAN
// listener, persisting the enabled state.
func (b *BridgeService) Enable() (MobileStatusResponse, error) {
	pw, err := mobilebridge.GeneratePassword()
	if err != nil {
		return MobileStatusResponse{}, err
	}
	return b.enableWithPassword(pw)
}

// Regenerate rotates the connection password on the running listener, which
// drops the currently paired phone (it authenticates against the new hash).
func (b *BridgeService) Regenerate() (MobileStatusResponse, error) {
	pw, err := mobilebridge.GeneratePassword()
	if err != nil {
		return MobileStatusResponse{}, err
	}
	return b.enableWithPassword(pw) // rotate → drops current phone (new hash)
}

// Disable stops the LAN listener and persists the disabled state.
func (b *BridgeService) Disable() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.LAN.Stop(ctx); err != nil {
		return err
	}
	st, _ := mobilebridge.Load(b.ConfigPath)
	st.Enabled = false
	return mobilebridge.Save(b.ConfigPath, st)
}
