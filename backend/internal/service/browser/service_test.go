package browser

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type fakeSessions struct {
	session domain.Session
	err     error
}

func (f fakeSessions) Get(_ context.Context, _ domain.SessionID) (domain.Session, error) {
	return f.session, f.err
}

type fakeRuntime struct {
	action string
}

func (f *fakeRuntime) Status() browserruntime.Status {
	return browserruntime.Status{Connected: true}
}

func (f *fakeRuntime) Execute(
	_ context.Context,
	_ domain.SessionID,
	action string,
	_ map[string]interface{},
) (browserruntime.Result, error) {
	f.action = action
	return browserruntime.Result{RequestID: "r1"}, nil
}

func TestServiceRequiresOwningCapabilityAndLiveSession(t *testing.T) {
	authority := &Authority{key: []byte("01234567890123456789012345678901")}
	runtime := &fakeRuntime{}
	service := New(fakeSessions{session: domain.Session{SessionRecord: domain.SessionRecord{ID: "s1"}}}, runtime, authority)

	if _, err := service.Status(context.Background(), "s1", "wrong"); apiErrorCode(err) != "BROWSER_CAPABILITY_INVALID" {
		t.Fatalf("wrong capability error = %v", err)
	}
	token := authority.Token("s1")
	if _, err := service.Status(context.Background(), "s1", token); err != nil {
		t.Fatalf("valid capability: %v", err)
	}
	if _, action, err := service.Execute(context.Background(), "s1", token, " SNAPSHOT ", nil); err != nil || action != "snapshot" || runtime.action != "snapshot" {
		t.Fatalf("execute action=%q runtime=%q err=%v", action, runtime.action, err)
	}
	if _, _, err := service.Execute(context.Background(), "s1", token, "eval", nil); apiErrorCode(err) != "BROWSER_ACTION_UNSUPPORTED" {
		t.Fatalf("unsupported action error = %v", err)
	}

	terminated := New(
		fakeSessions{session: domain.Session{SessionRecord: domain.SessionRecord{ID: "s1", IsTerminated: true}}},
		runtime,
		authority,
	)
	if _, err := terminated.Status(context.Background(), "s1", token); apiErrorCode(err) != "SESSION_TERMINATED" {
		t.Fatalf("terminated error = %v", err)
	}
}

func TestAuthorityPersistsStableSecret(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadAuthority(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadAuthority(dir)
	if err != nil {
		t.Fatal(err)
	}
	if first.Token("s1") == "" || first.Token("s1") != second.Token("s1") || first.Token("s1") == first.Token("s2") {
		t.Fatal("authority tokens are not stable and session-scoped")
	}
}

func apiErrorCode(err error) string {
	var target *apierr.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
