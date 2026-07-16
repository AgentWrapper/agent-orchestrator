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
	rows, err := s.ListUnreadNotifications(ctx, 10)
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
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
	rows, err := s.ListUnreadNotifications(ctx, 10)
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
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
	recent, err := s.ListRecentNotifications(ctx, 10)
	if err != nil {
		t.Fatalf("ListRecentNotifications: %v", err)
	}
	if len(recent) != 2 || recent[0].ID != "ntf_2" || recent[1].ID != "ntf_1" || recent[1].Status != domain.NotificationRead {
		t.Fatalf("recent = %+v", recent)
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
	read, err := s.MarkAllNotificationsRead(ctx)
	if err != nil {
		t.Fatalf("MarkAllNotificationsRead: %v", err)
	}
	if len(read) != 2 {
		t.Fatalf("read rows = %+v", read)
	}
	for _, row := range read {
		if row.Status != domain.NotificationRead {
			t.Fatalf("row = %+v, want read", row)
		}
	}
	rows, err := s.ListUnreadNotifications(ctx, 10)
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
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
	rows, err := s.ListUnreadNotifications(ctx, 2)
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != "other" || rows[1].ID != "new" {
		t.Fatalf("rows = %+v", rows)
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
