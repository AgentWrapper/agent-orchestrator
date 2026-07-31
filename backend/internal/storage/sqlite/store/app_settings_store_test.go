package store_test

import (
	"context"
	"testing"
)

func TestAppSettingRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// Absent key reads as "" with no error.
	got, err := s.GetAppSetting(ctx, "pipelines.enabled")
	if err != nil {
		t.Fatalf("GetAppSetting (absent): %v", err)
	}
	if got != "" {
		t.Errorf("absent key = %q, want empty string", got)
	}

	// First write inserts.
	if err := s.SetAppSetting(ctx, "pipelines.enabled", "true"); err != nil {
		t.Fatalf("SetAppSetting insert: %v", err)
	}
	if got, err = s.GetAppSetting(ctx, "pipelines.enabled"); err != nil || got != "true" {
		t.Fatalf("after insert got (%q, %v), want (\"true\", nil)", got, err)
	}

	// Second write to the same key upserts (last write wins).
	if err := s.SetAppSetting(ctx, "pipelines.enabled", "false"); err != nil {
		t.Fatalf("SetAppSetting upsert: %v", err)
	}
	if got, err = s.GetAppSetting(ctx, "pipelines.enabled"); err != nil || got != "false" {
		t.Fatalf("after upsert got (%q, %v), want (\"false\", nil)", got, err)
	}
}
