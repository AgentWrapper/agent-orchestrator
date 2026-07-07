package httpd

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

// fakeMobileBridge is a no-op mobileBridge implementation. Its type is
// unexported to httpd, but the controllers.MobileController.Bridge field is
// exported and structurally typed, so any value with matching method
// signatures satisfies it from outside the package.
type fakeMobileBridge struct{}

func (fakeMobileBridge) Status() controllers.MobileStatusResponse {
	return controllers.MobileStatusResponse{}
}

func (fakeMobileBridge) Enable() (controllers.MobileStatusResponse, error) {
	return controllers.MobileStatusResponse{}, nil
}

func (fakeMobileBridge) Disable() error { return nil }

func (fakeMobileBridge) Regenerate() (controllers.MobileStatusResponse, error) {
	return controllers.MobileStatusResponse{}, nil
}

// newTestRouterWithMobile builds a bare router with only the mobile control
// routes mounted, backed by a fake bridge — enough to exercise the
// loopback gate without a real LAN listener.
func newTestRouterWithMobile(t *testing.T) chi.Router {
	t.Helper()
	r := chi.NewRouter()
	mountMobile(r, &controllers.MobileController{Bridge: fakeMobileBridge{}})
	return r
}

func TestMobileStatusRouteIsLoopbackGated(t *testing.T) {
	r := newTestRouterWithMobile(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/status", nil)
	req.Host = "192.168.1.9:3011" // non-loopback → must be refused
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-loopback status: got %d want 403", w.Code)
	}
}
