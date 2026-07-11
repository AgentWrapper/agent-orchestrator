package pr

import (
	"context"
	"errors"
	"strconv"
	"testing"
)

type fakeMergeExecutor struct{}

func (fakeMergeExecutor) MergePR(_ context.Context, prID string) (MergeResult, error) {
	n, _ := strconv.Atoi(prID)
	return MergeResult{PRNumber: n, Method: "squash"}, nil
}

type fakeResolveExecutor struct{}

func (fakeResolveExecutor) ResolveComments(_ context.Context, _ string, ids []string) (ResolveResult, error) {
	return ResolveResult{Resolved: len(ids)}, nil
}

func TestMerge_ReturnsSquash(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{
		MainCI: fakeMainCIGate{status: MainCIStatus{State: MainCISuccess}},
		Merge:  fakeMergeExecutor{},
	})
	res, err := svc.Merge(context.Background(), "42")
	if err != nil {
		t.Fatal(err)
	}
	if res.Method != "squash" {
		t.Errorf("method = %q, want squash", res.Method)
	}
	if res.PRNumber != 42 {
		t.Errorf("PRNumber = %d, want 42", res.PRNumber)
	}
}

type fakeMainCIGate struct {
	status MainCIStatus
	err    error
}

func (f fakeMainCIGate) Check(_ context.Context, _ string) (MainCIStatus, error) {
	return f.status, f.err
}

func TestMerge_BlocksWhenMainCIIsRed(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{
		MainCI: fakeMainCIGate{status: MainCIStatus{
			State:      MainCIFailing,
			SHA:        "fee462ed",
			FailedJobs: []string{"go", "cli-e2e"},
		}},
		Merge: fakeMergeExecutor{},
	})

	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrMainCIRed) {
		t.Fatalf("err = %v, want ErrMainCIRed", err)
	}
}

func TestMerge_AllowsMainCIFixPRDuringFreeze(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{
		MainCI: fakeMainCIGate{status: MainCIStatus{
			State:      MainCIFailing,
			SHA:        "fee462ed",
			FailedJobs: []string{"go", "cli-e2e"},
			FixPR:      true,
		}},
		Merge: fakeMergeExecutor{},
	})

	res, err := svc.Merge(context.Background(), "42")
	if err != nil {
		t.Fatalf("Merge fix PR during freeze: %v", err)
	}
	if res.Method != "squash" || res.PRNumber != 42 {
		t.Fatalf("res = %+v", res)
	}
}

func TestMerge_BlocksWhenMainCIIsUnknown(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{
		MainCI: fakeMainCIGate{status: MainCIStatus{State: MainCIUnknown}},
		Merge:  fakeMergeExecutor{},
	})

	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestMerge_BlocksWhenMainCIIsPending(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{
		MainCI: fakeMainCIGate{status: MainCIStatus{State: MainCIPending}},
		Merge:  fakeMergeExecutor{},
	})

	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestMerge_BlocksWhenMainCIStateIsEmpty(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{
		MainCI: fakeMainCIGate{status: MainCIStatus{State: ""}},
		Merge:  fakeMergeExecutor{},
	})

	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestNewActionServiceWithDepsPanicsWhenMergeExecutorHasNoMainCIGate(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewActionServiceWithDeps did not panic")
		}
	}()
	_ = NewActionServiceWithDeps(ActionDeps{Merge: fakeMergeExecutor{}})
}

func TestMerge_FailsClosedWithoutExecutor(t *testing.T) {
	_, err := NewActionService().Merge(context.Background(), "42")
	if !errors.Is(err, ErrActionUnavailable) {
		t.Fatalf("err = %v, want ErrActionUnavailable", err)
	}
}

func TestMerge_FailsClosedWhenMainCIGateMissing(t *testing.T) {
	svc := &ActionService{merge: fakeMergeExecutor{}}
	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrPRPreconditions) {
		t.Fatalf("err = %v, want ErrPRPreconditions", err)
	}
}

func TestResolveComments_ReturnsOK(t *testing.T) {
	svc := NewActionServiceWithDeps(ActionDeps{Resolve: fakeResolveExecutor{}})
	res, err := svc.ResolveComments(context.Background(), "1", []string{"T1", "T2"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Resolved != 2 {
		t.Fatalf("Resolved = %d, want 2", res.Resolved)
	}
}

func TestResolveComments_FailsClosedWithoutExecutor(t *testing.T) {
	_, err := NewActionService().ResolveComments(context.Background(), "1", nil)
	if !errors.Is(err, ErrActionUnavailable) {
		t.Fatalf("err = %v, want ErrActionUnavailable", err)
	}
}
