package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestNotificationStore_InsertListAndDedupe(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.NotificationRecord{
		ID:        "ntf_1",
		SessionID: sess.ID,
		ProjectID: sess.ProjectID,
		Type:      domain.NotificationNeedsInput,
		Title:     "checkout-flow needs input",
		Status:    domain.NotificationUnread,
		CreatedAt: now,
	}
	created, inserted, err := s.CreateNotification(ctx, rec)
	if err != nil || !inserted {
		t.Fatalf("CreateNotification inserted=%v err=%v", inserted, err)
	}
	if created.ID != rec.ID || created.Title != rec.Title {
		t.Fatalf("created = %+v", created)
	}
	dup := rec
	dup.ID = "ntf_2"
	_, inserted, err = s.CreateNotification(ctx, dup)
	if err != nil || inserted {
		t.Fatalf("duplicate inserted=%v err=%v, want false nil", inserted, err)
	}
	rows, err := s.ListNotifications(ctx, domain.NotificationListUnread, time.Time{}, "", 10)
	if err != nil {
		t.Fatalf("ListNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "ntf_1" {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestNotificationStore_MarkReadReopensUnreadDedupe(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.NotificationRecord{
		ID:        "ntf_1",
		SessionID: sess.ID,
		ProjectID: sess.ProjectID,
		Type:      domain.NotificationNeedsInput,
		Title:     "checkout-flow needs input",
		Status:    domain.NotificationUnread,
		CreatedAt: now,
	}
	if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
		t.Fatalf("CreateNotification inserted=%v err=%v", inserted, err)
	}
	read, ok, err := s.MarkNotificationRead(ctx, rec.ID)
	if err != nil || !ok {
		t.Fatalf("MarkNotificationRead ok=%v err=%v", ok, err)
	}
	if read.Status != domain.NotificationRead {
		t.Fatalf("status = %q, want read", read.Status)
	}
	rows, err := s.ListNotifications(ctx, domain.NotificationListUnread, time.Time{}, "", 10)
	if err != nil {
		t.Fatalf("ListNotifications: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %+v, want none", rows)
	}
	again := rec
	again.ID = "ntf_2"
	again.CreatedAt = now.Add(time.Minute)
	if _, inserted, err := s.CreateNotification(ctx, again); err != nil || !inserted {
		t.Fatalf("CreateNotification after read inserted=%v err=%v", inserted, err)
	}
}

func TestNotificationStore_MarkReadMissing(t *testing.T) {
	s := newTestStore(t)
	_, ok, err := s.MarkNotificationRead(context.Background(), "missing")
	if err != nil || ok {
		t.Fatalf("MarkNotificationRead ok=%v err=%v, want false nil", ok, err)
	}
}

func TestNotificationStore_MarkAllRead(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for _, rec := range []domain.NotificationRecord{
		{ID: "ntf_1", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationNeedsInput, Title: "one", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "ntf_2", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "two", Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	updated, err := s.MarkAllNotificationsRead(ctx)
	if err != nil {
		t.Fatalf("MarkAllNotificationsRead: %v", err)
	}
	if updated != 2 {
		t.Fatalf("updated = %d, want 2", updated)
	}
	updated, err = s.MarkAllNotificationsRead(ctx)
	if err != nil || updated != 0 {
		t.Fatalf("second mark-all updated=%d err=%v, want 0 nil", updated, err)
	}
	rows, err := s.ListNotifications(ctx, domain.NotificationListUnread, time.Time{}, "", 10)
	if err != nil {
		t.Fatalf("ListNotifications: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("unread rows = %+v, want none", rows)
	}
}

func TestNotificationStore_ListUnreadNewestFirstAcrossProjects(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	seedProject(t, s, "ao")
	mer, _ := s.CreateSession(ctx, sampleRecord("mer"))
	ao, _ := s.CreateSession(ctx, sampleRecord("ao"))
	base := time.Now().UTC().Truncate(time.Second)
	for _, rec := range []domain.NotificationRecord{
		{ID: "old", SessionID: mer.ID, ProjectID: mer.ProjectID, Type: domain.NotificationNeedsInput, Title: "old", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "new", SessionID: mer.ID, ProjectID: mer.ProjectID, PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "new", Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
		{ID: "other", SessionID: ao.ID, ProjectID: ao.ProjectID, Type: domain.NotificationNeedsInput, Title: "other", Status: domain.NotificationUnread, CreatedAt: base.Add(2 * time.Minute)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	rows, err := s.ListNotifications(ctx, domain.NotificationListUnread, time.Time{}, "", 2)
	if err != nil {
		t.Fatalf("ListNotifications: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != "other" || rows[1].ID != "new" {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestNotificationStore_ListAllUsesStableCursorWithoutAgeCutoff(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, _ := s.CreateSession(ctx, sampleRecord("mer"))
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	for _, rec := range []domain.NotificationRecord{
		{ID: "same-z", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationNeedsInput, Title: "same z", Status: domain.NotificationUnread, CreatedAt: now},
		{ID: "same-a", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationPRMerged, Title: "same a", Status: domain.NotificationRead, CreatedAt: now},
		{ID: "old", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/old", Type: domain.NotificationPRClosedUnmerged, Title: "old", Status: domain.NotificationUnread, CreatedAt: now.Add(-30 * 24 * time.Hour)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}

	rows, err := s.ListNotifications(ctx, domain.NotificationListAll, time.Time{}, "", 2)
	if err != nil {
		t.Fatalf("ListNotifications: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != "same-z" || rows[1].ID != "same-a" {
		t.Fatalf("rows = %+v", rows)
	}
	older, err := s.ListNotifications(ctx, domain.NotificationListAll, rows[1].CreatedAt, rows[1].ID, 2)
	if err != nil {
		t.Fatalf("ListNotifications older: %v", err)
	}
	if len(older) != 1 || older[0].ID != "old" {
		t.Fatalf("older = %+v", older)
	}
	count, err := s.CountUnreadNotifications(ctx)
	if err != nil || count != 2 {
		t.Fatalf("unread count=%d err=%v", count, err)
	}
}

func TestNotificationStore_CheckConstraintRejectsInvalidStatus(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, _ := s.CreateSession(ctx, sampleRecord("mer"))
	_, _, err := s.CreateNotification(ctx, domain.NotificationRecord{
		ID: "bad", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationNeedsInput,
		Title: "bad", Status: "archived", CreatedAt: time.Now(),
	})
	if !errors.Is(err, domain.ErrInvalidNotificationStatus) {
		t.Fatalf("err = %v, want invalid status", err)
	}
}
