package controlplane

import "testing"

func TestLocationRegistry_RegisterLookupRemove(t *testing.T) {
	r := NewInMemoryLocationRegistry()

	sandbox := SessionLocation{
		SessionID: "w1", TenantID: "acme", ProjectID: "proj", Kind: "worker",
		Type: LocationSandbox, SandboxID: "sb-1", PreviewURL: "https://preview/sb-1",
	}
	daemon := SessionLocation{
		SessionID: "orch1", TenantID: "acme", ProjectID: "proj", Kind: "orchestrator",
		Type: LocationDaemon, DaemonID: "daemon-A",
	}
	r.Register(sandbox)
	r.Register(daemon)

	got, ok := r.Lookup("acme", "w1")
	if !ok || got.Type != LocationSandbox || got.PreviewURL != "https://preview/sb-1" {
		t.Fatalf("sandbox lookup = %+v ok=%v", got, ok)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("Register should stamp UpdatedAt")
	}
	got, ok = r.Lookup("acme", "orch1")
	if !ok || got.Type != LocationDaemon || got.DaemonID != "daemon-A" {
		t.Fatalf("daemon lookup = %+v ok=%v", got, ok)
	}

	r.Remove("acme", "w1")
	if _, ok := r.Lookup("acme", "w1"); ok {
		t.Fatal("w1 should be gone after Remove")
	}
	if _, ok := r.Lookup("acme", "orch1"); !ok {
		t.Fatal("Remove must not affect other sessions")
	}
}

func TestLocationRegistry_TenantIsolation(t *testing.T) {
	r := NewInMemoryLocationRegistry()
	r.Register(SessionLocation{SessionID: "s", TenantID: "acme", Type: LocationDaemon, DaemonID: "d"})
	if _, ok := r.Lookup("other", "s"); ok {
		t.Fatal("another tenant must not see acme's session")
	}
	if n := len(r.ListForTenant("other")); n != 0 {
		t.Fatalf("other tenant list = %d, want 0", n)
	}
	if n := len(r.ListForTenant("acme")); n != 1 {
		t.Fatalf("acme list = %d, want 1", n)
	}
}

func TestLocationRegistry_RemoveDaemonDropsOnlyThatDaemon(t *testing.T) {
	r := NewInMemoryLocationRegistry()
	r.Register(SessionLocation{SessionID: "a", TenantID: "acme", Type: LocationDaemon, DaemonID: "d1"})
	r.Register(SessionLocation{SessionID: "b", TenantID: "acme", Type: LocationDaemon, DaemonID: "d1"})
	r.Register(SessionLocation{SessionID: "c", TenantID: "acme", Type: LocationDaemon, DaemonID: "d2"})
	r.Register(SessionLocation{SessionID: "d", TenantID: "acme", Type: LocationSandbox, SandboxID: "sb"})

	r.RemoveDaemon("acme", "d1")

	if _, ok := r.Lookup("acme", "a"); ok {
		t.Fatal("d1 session a should be dropped")
	}
	if _, ok := r.Lookup("acme", "b"); ok {
		t.Fatal("d1 session b should be dropped")
	}
	if _, ok := r.Lookup("acme", "c"); !ok {
		t.Fatal("d2 session c must survive")
	}
	if _, ok := r.Lookup("acme", "d"); !ok {
		t.Fatal("sandbox session d must survive")
	}
}

func TestLocationRegistry_SameOwnerRefreshOverwrites(t *testing.T) {
	r := NewInMemoryLocationRegistry()
	r.Register(SessionLocation{SessionID: "s", TenantID: "acme", Type: LocationDaemon, DaemonID: "d1", ProjectID: "old"})
	// Same owner (daemon d1) re-registers → refresh wins.
	r.Register(SessionLocation{SessionID: "s", TenantID: "acme", Type: LocationDaemon, DaemonID: "d1", ProjectID: "new"})
	got, _ := r.Lookup("acme", "s")
	if got.ProjectID != "new" {
		t.Fatalf("same-owner refresh should overwrite, got %+v", got)
	}
}

// Ownership guard (audit #1/#4): a DIFFERENT host must not steal an existing
// routing key. The first owner survives.
func TestLocationRegistry_RejectsCrossOwnerOverwrite(t *testing.T) {
	r := NewInMemoryLocationRegistry()
	r.Register(SessionLocation{SessionID: "s", TenantID: "acme", Type: LocationSandbox, SandboxID: "sb-victim", PreviewURL: "https://p/victim"})
	// A different host tries to hijack routing key "s" as its own daemon session.
	r.Register(SessionLocation{SessionID: "s", TenantID: "acme", Type: LocationDaemon, DaemonID: "attacker"})
	got, ok := r.Lookup("acme", "s")
	if !ok || got.Type != LocationSandbox || got.SandboxID != "sb-victim" {
		t.Fatalf("cross-owner overwrite must be refused; got %+v", got)
	}
	// A different sandbox id also can't steal it.
	r.Register(SessionLocation{SessionID: "s", TenantID: "acme", Type: LocationSandbox, SandboxID: "sb-other"})
	got, _ = r.Lookup("acme", "s")
	if got.SandboxID != "sb-victim" {
		t.Fatalf("different sandbox must not steal routing key; got %+v", got)
	}
}

func TestLocationRegistry_IgnoresEmptyKeys(t *testing.T) {
	r := NewInMemoryLocationRegistry()
	r.Register(SessionLocation{SessionID: "", TenantID: "acme", Type: LocationDaemon, DaemonID: "d"})
	r.Register(SessionLocation{SessionID: "s", TenantID: "", Type: LocationDaemon, DaemonID: "d"})
	if n := len(r.ListForTenant("acme")); n != 0 {
		t.Fatalf("empty-key registrations must be ignored, got %d", n)
	}
}
