package cloud

import "testing"

func TestNotifyReady_FiresSnapshotWhenReady(t *testing.T) {
	fired := make(chan CloudSession, 1)
	s := NewSupervisor(SupervisorConfig{
		APIKey:         func() string { return "k" },
		OnSessionReady: func(cs CloudSession) { fired <- cs },
	})
	s.sessions["box1"] = &CloudSession{
		SessionID: "sess1", PreviewURL: "https://p/box1", TenantID: "acme", LocalProjectID: "proj",
	}
	s.notifyReady("box1")

	select {
	case cs := <-fired:
		if cs.SessionID != "sess1" || cs.PreviewURL != "https://p/box1" || cs.TenantID != "acme" {
			t.Fatalf("snapshot = %+v", cs)
		}
	default:
		t.Fatal("OnSessionReady did not fire for a ready session")
	}
}

func TestNotifyReady_SkipsWhenNotReady(t *testing.T) {
	fired := false
	s := NewSupervisor(SupervisorConfig{
		APIKey:         func() string { return "k" },
		OnSessionReady: func(CloudSession) { fired = true },
	})
	// No SessionID / PreviewURL yet (still provisioning) → must not fire.
	s.sessions["box1"] = &CloudSession{TenantID: "acme"}
	s.notifyReady("box1")
	if fired {
		t.Fatal("OnSessionReady fired before the session was ready")
	}
}

func TestSetLocationHooks_Wires(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "k" }})
	if s.cfg.OnSessionReady != nil {
		t.Fatal("hook should start nil")
	}
	got := make(chan CloudSession, 1)
	s.SetLocationHooks(func(cs CloudSession) { got <- cs }, nil)
	s.sessions["b"] = &CloudSession{SessionID: "x", PreviewURL: "u"}
	s.notifyReady("b")
	select {
	case <-got:
	default:
		t.Fatal("SetLocationHooks did not wire OnSessionReady")
	}
}
