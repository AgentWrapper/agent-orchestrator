package pr

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakePRStore struct {
	pr  domain.PullRequest
	ok  bool
	err error
}

func (f *fakePRStore) GetPR(_ context.Context, _ string) (domain.PullRequest, bool, error) {
	return f.pr, f.ok, f.err
}

type fakeSCMMerger struct {
	sha string
	err error
}

func (f *fakeSCMMerger) MergePR(_ context.Context, _, _ string, _ int, _ string) (string, error) {
	return f.sha, f.err
}

func TestMerge_Success(t *testing.T) {
	store := &fakePRStore{ok: true, pr: domain.PullRequest{
		Number: 42, Repo: "acme/widgets", Mergeability: domain.MergeMergeable,
	}}
	scm := &fakeSCMMerger{sha: "abc123"}
	svc := NewActionService(store, scm)

	id := base64.RawURLEncoding.EncodeToString([]byte("https://github.com/acme/widgets/pull/42"))
	res, err := svc.Merge(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if res.PRNumber != 42 || res.Method != "squash" {
		t.Fatalf("res = %#v", res)
	}
}

func TestMerge_NotFound(t *testing.T) {
	store := &fakePRStore{ok: false}
	svc := NewActionService(store, &fakeSCMMerger{})
	id := base64.RawURLEncoding.EncodeToString([]byte("https://github.com/acme/widgets/pull/99"))
	_, err := svc.Merge(context.Background(), id)
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestMerge_NotMergeable(t *testing.T) {
	store := &fakePRStore{ok: true, pr: domain.PullRequest{Mergeability: domain.MergeBlocked}}
	svc := NewActionService(store, &fakeSCMMerger{})
	_, err := svc.Merge(context.Background(), base64.RawURLEncoding.EncodeToString([]byte("x")))
	if !errors.Is(err, ErrPRNotMergeable) {
		t.Fatalf("err = %v, want ErrPRNotMergeable", err)
	}
}

func TestMerge_AlreadyMerged(t *testing.T) {
	store := &fakePRStore{ok: true, pr: domain.PullRequest{Merged: true}}
	svc := NewActionService(store, &fakeSCMMerger{})
	_, err := svc.Merge(context.Background(), base64.RawURLEncoding.EncodeToString([]byte("x")))
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestMerge_NilSCM(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, nil)
	_, err := svc.Merge(context.Background(), base64.RawURLEncoding.EncodeToString([]byte("x")))
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions (SCM unavailable)", err)
	}
}

func TestMerge_BadID(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, &fakeSCMMerger{})
	_, err := svc.Merge(context.Background(), "not-valid-base64!!!")
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
}

func TestResolveComments_ReturnsOK(t *testing.T) {
	svc := NewActionService(&fakePRStore{}, &fakeSCMMerger{})
	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if err != nil {
		t.Fatal(err)
	}
}
