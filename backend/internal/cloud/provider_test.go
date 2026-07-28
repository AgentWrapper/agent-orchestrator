package cloud

import (
	"context"
	"testing"
)

// fakeProvider is a stand-in sandbox backend used to prove the supervisor talks
// only to the SandboxProvider interface — the same seam a real e2b/Fly/Modal
// provider would slot into.
type fakeProvider struct{ name string }

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) Create(context.Context, CreateSandboxRequest) (*Sandbox, error) {
	return &Sandbox{ID: "fake-1", State: "started"}, nil
}
func (f *fakeProvider) Get(_ context.Context, id string) (*Sandbox, error) {
	return &Sandbox{ID: id, State: "started"}, nil
}
func (f *fakeProvider) Start(context.Context, string) error     { return nil }
func (f *fakeProvider) Delete(context.Context, string) error    { return nil }
func (f *fakeProvider) List(context.Context) ([]Sandbox, error) { return nil, nil }
func (f *fakeProvider) Exec(context.Context, Sandbox, ExecuteRequest) (*ExecuteResponse, error) {
	return &ExecuteResponse{}, nil
}
func (f *fakeProvider) UploadFile(context.Context, Sandbox, string, []byte) error { return nil }
func (f *fakeProvider) SignedPreview(context.Context, string, int, int) (*SignedPreviewURL, error) {
	return &SignedPreviewURL{}, nil
}

var _ SandboxProvider = (*fakeProvider)(nil)

func TestSupervisorUsesInjectedProvider(t *testing.T) {
	fp := &fakeProvider{name: "fake"}
	s := NewSupervisor(SupervisorConfig{
		APIKey:      func() string { return "cred" },
		NewProvider: func(string) (SandboxProvider, error) { return fp, nil },
	})
	p, err := s.client()
	if err != nil {
		t.Fatalf("client(): %v", err)
	}
	if p.Name() != "fake" {
		t.Fatalf("provider = %q, want the injected fake", p.Name())
	}
}

func TestSupervisorDefaultsToDaytonaProvider(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "cred" }})
	p, err := s.client()
	if err != nil {
		t.Fatalf("client(): %v", err)
	}
	if p.Name() != "daytona" {
		t.Fatalf("default provider = %q, want daytona", p.Name())
	}
}

func TestDaytonaProviderFactory(t *testing.T) {
	if _, err := DaytonaProviderFactory(""); err == nil {
		t.Fatal("empty credential must error")
	}
	p, err := DaytonaProviderFactory("k")
	if err != nil {
		t.Fatalf("factory: %v", err)
	}
	if p.Name() != "daytona" {
		t.Fatalf("name = %q, want daytona", p.Name())
	}
}
