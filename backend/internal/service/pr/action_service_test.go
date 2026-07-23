package pr

import (
	"context"
	"errors"
	"testing"
)

func TestMerge_ReturnsUnavailable(t *testing.T) {
	svc := NewActionService()
	_, err := svc.Merge(context.Background(), "42")
	if !errors.Is(err, ErrPRActionsUnavailable) {
		t.Fatalf("err = %v, want ErrPRActionsUnavailable", err)
	}
}

func TestResolveComments_ReturnsUnavailable(t *testing.T) {
	svc := NewActionService()
	_, err := svc.ResolveComments(context.Background(), "1", nil)
	if !errors.Is(err, ErrPRActionsUnavailable) {
		t.Fatalf("err = %v, want ErrPRActionsUnavailable", err)
	}
}
