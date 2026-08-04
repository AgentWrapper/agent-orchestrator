package review

import (
	"context"
	"errors"
	"testing"
)

func TestTriggerRejectsAnUnknownHarnessOverride(t *testing.T) {
	eng := New(Deps{})

	_, err := eng.Trigger(context.Background(), "mer-1", "not-a-reviewer")
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}
