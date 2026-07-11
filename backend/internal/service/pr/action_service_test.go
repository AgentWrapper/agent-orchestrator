package pr

import (
	"context"
	"errors"
	"testing"
)

func TestMerge_ReturnsSquash(t *testing.T) {
	svc := NewActionService()
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
	})

	res, err := svc.Merge(context.Background(), "42")
	if err != nil {
		t.Fatalf("Merge fix PR during freeze: %v", err)
	}
	if res.Method != "squash" || res.PRNumber != 42 {
		t.Fatalf("res = %+v", res)
	}
}

func TestResolveComments_ReturnsOK(t *testing.T) {
	svc := NewActionService()
	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if err != nil {
		t.Fatal(err)
	}
}
