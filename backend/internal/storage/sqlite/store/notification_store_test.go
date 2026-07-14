package store_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
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
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
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
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
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
}

func TestNotificationStore_WorkerTerminalDedupeSurvivesRead(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)
	cases := []domain.NotificationType{
		domain.NotificationWorkerDiedUnfinished,
		domain.NotificationWorkerRetryExhausted,
	}
	for i, notificationType := range cases {
		sess, err := s.CreateSession(ctx, sampleRecord("mer"))
		if err != nil {
			t.Fatalf("create session: %v", err)
		}
		rec := domain.NotificationRecord{
			ID:        "ntf_first_" + string(rune('a'+i)),
			SessionID: sess.ID,
			ProjectID: sess.ProjectID,
			Type:      notificationType,
			Title:     "worker notification",
			Status:    domain.NotificationUnread,
			CreatedAt: now.Add(time.Duration(i) * time.Minute),
		}
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("%s first CreateNotification inserted=%v err=%v", notificationType, inserted, err)
		}
		if _, ok, err := s.MarkNotificationRead(ctx, rec.ID); err != nil || !ok {
			t.Fatalf("%s MarkNotificationRead ok=%v err=%v", notificationType, ok, err)
		}
		again := rec
		again.ID = "ntf_again_" + string(rune('a'+i))
		again.CreatedAt = now.Add(time.Hour + time.Duration(i)*time.Minute)
		if _, inserted, err := s.CreateNotification(ctx, again); err != nil || inserted {
			t.Fatalf("%s CreateNotification after read inserted=%v err=%v, want false nil", notificationType, inserted, err)
		}
		rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
		if err != nil {
			t.Fatalf("ListUnreadNotifications: %v", err)
		}
		if len(rows) != 0 {
			t.Fatalf("rows = %+v, want no re-opened worker terminal notification", rows)
		}
	}
}

func TestNotificationStore_WorkerDiedUnfinishedDedupeAllowsDistinctBodiesAfterRead(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	observed := domain.NotificationRecord{
		ID:        "ntf_observed",
		SessionID: sess.ID,
		ProjectID: sess.ProjectID,
		PRURL:     "https://github.com/acme/demo/pull/99",
		Type:      domain.NotificationWorkerDiedUnfinished,
		Title:     "worker died with unfinished work: issue #12",
		Body:      "demo #12 fix-login terminated before issue #12 landed with an orphaned PR https://github.com/acme/demo/pull/99; ao will dispatch a clean replacement if retry capacity remains.",
		Status:    domain.NotificationUnread,
		CreatedAt: now,
	}
	if _, inserted, err := s.CreateNotification(ctx, observed); err != nil || !inserted {
		t.Fatalf("CreateNotification observed inserted=%v err=%v", inserted, err)
	}
	if _, ok, err := s.MarkNotificationRead(ctx, observed.ID); err != nil || !ok {
		t.Fatalf("MarkNotificationRead observed ok=%v err=%v", ok, err)
	}
	duplicateObserved := observed
	duplicateObserved.ID = "ntf_observed_again"
	duplicateObserved.CreatedAt = now.Add(time.Minute)
	if _, inserted, err := s.CreateNotification(ctx, duplicateObserved); err != nil || inserted {
		t.Fatalf("duplicate observed inserted=%v err=%v, want false nil", inserted, err)
	}
	adopting := observed
	adopting.ID = "ntf_adopting"
	adopting.Body = "demo #12 fix-login terminated before issue #12 landed with an open PR; ao is dispatching a replacement to adopt https://github.com/acme/demo/pull/99."
	adopting.CreatedAt = now.Add(2 * time.Minute)
	if _, inserted, err := s.CreateNotification(ctx, adopting); err != nil || !inserted {
		t.Fatalf("CreateNotification adopting inserted=%v err=%v, want true nil", inserted, err)
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != adopting.ID {
		t.Fatalf("rows = %+v, want only adopting notification unread", rows)
	}
}

func TestNotificationStore_SensitiveReadyDoesNotDedupeRoutineReady(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	routine := domain.NotificationRecord{
		ID:        "ntf_1",
		SessionID: sess.ID,
		ProjectID: sess.ProjectID,
		PRURL:     "https://github.com/o/r/pull/1",
		Type:      domain.NotificationReadyToMerge,
		Title:     "PR #1 is ready to merge",
		Status:    domain.NotificationUnread,
		CreatedAt: now,
	}
	if _, inserted, err := s.CreateNotification(ctx, routine); err != nil || !inserted {
		t.Fatalf("CreateNotification routine inserted=%v err=%v", inserted, err)
	}
	sensitive := routine
	sensitive.ID = "ntf_2"
	sensitive.Sensitive = true
	sensitive.ChangedPaths = []string{"backend/internal/lifecycle/reactions.go"}
	sensitive.CreatedAt = now.Add(time.Minute)
	if _, inserted, err := s.CreateNotification(ctx, sensitive); err != nil || !inserted {
		t.Fatalf("CreateNotification sensitive inserted=%v err=%v", inserted, err)
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 2 || !rows[0].Sensitive || rows[1].Sensitive {
		t.Fatalf("rows = %+v, want sensitive and routine unread notifications", rows)
	}
}

func TestNotificationStore_ModelAlertPersistsWithoutPR(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.NotificationRecord{
		ID:        "ntf_model",
		SessionID: "ao-model-codex-gpt-5-5-codex",
		ProjectID: "ao",
		Type:      domain.NotificationModelUnreachable,
		Title:     "gpt-5.5-codex model unreachable",
		Body:      "Configured pin workerMix[0].model / codex / gpt-5.5-codex is unreachable: 400 model not available.",
		Status:    domain.NotificationUnread,
		CreatedAt: now,
	}
	if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
		t.Fatalf("CreateNotification inserted=%v err=%v", inserted, err)
	}
	dup := rec
	dup.ID = "ntf_model_2"
	if _, inserted, err := s.CreateNotification(ctx, dup); err != nil || inserted {
		t.Fatalf("duplicate inserted=%v err=%v, want false nil", inserted, err)
	}
}

func TestNotificationStore_NonSessionSubjectsPersistWithoutSyntheticSession(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	now := time.Now().UTC().Truncate(time.Second)
	for _, rec := range []domain.NotificationRecord{
		{
			ID:          "ntf_model",
			ProjectID:   "ao",
			Type:        domain.NotificationModelUnreachable,
			SubjectKind: domain.NotificationSubjectModel,
			SubjectID:   "codex/gpt-5.5-codex",
			Title:       "gpt-5.5-codex model unreachable",
			Status:      domain.NotificationUnread,
			CreatedAt:   now,
		},
		{
			ID:          "ntf_main",
			ProjectID:   "ao",
			Type:        domain.NotificationMainCIRed,
			SubjectKind: domain.NotificationSubjectProject,
			SubjectID:   "ao",
			Title:       "main is red",
			Status:      domain.NotificationUnread,
			CreatedAt:   now.Add(time.Minute),
		},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("CreateNotification %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %+v, want 2", rows)
	}
	for _, row := range rows {
		if row.SessionID != "" {
			t.Fatalf("row %s session_id = %q, want empty legacy session for non-session subject", row.ID, row.SessionID)
		}
		if row.SubjectKind == "" || row.SubjectID == "" {
			t.Fatalf("row %s subject = %q/%q, want typed subject", row.ID, row.SubjectKind, row.SubjectID)
		}
	}
}

func TestNotificationStore_DedupeUsesTypedSubject(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	now := time.Now().UTC().Truncate(time.Second)
	first := domain.NotificationRecord{
		ID:          "ntf_model_codex",
		ProjectID:   "ao",
		Type:        domain.NotificationModelUnreachable,
		SubjectKind: domain.NotificationSubjectModel,
		SubjectID:   "codex/gpt-5.5-codex",
		Title:       "codex model unreachable",
		Status:      domain.NotificationUnread,
		CreatedAt:   now,
	}
	if _, inserted, err := s.CreateNotification(ctx, first); err != nil || !inserted {
		t.Fatalf("CreateNotification first inserted=%v err=%v", inserted, err)
	}
	otherSubject := first
	otherSubject.ID = "ntf_model_claude"
	otherSubject.SubjectID = "claude/sonnet"
	otherSubject.Title = "claude model unreachable"
	otherSubject.CreatedAt = now.Add(time.Minute)
	if _, inserted, err := s.CreateNotification(ctx, otherSubject); err != nil || !inserted {
		t.Fatalf("CreateNotification different subject inserted=%v err=%v, want distinct row", inserted, err)
	}
	duplicate := first
	duplicate.ID = "ntf_model_codex_again"
	duplicate.CreatedAt = now.Add(2 * time.Minute)
	if _, inserted, err := s.CreateNotification(ctx, duplicate); err != nil || inserted {
		t.Fatalf("CreateNotification duplicate inserted=%v err=%v, want dedupe on same subject", inserted, err)
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %+v, want two distinct subject rows", rows)
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
	read, err := s.MarkAllNotificationsRead(ctx, nil)
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
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("unread rows = %+v, want none", rows)
	}
}

func TestNotificationStore_MarkAllReadKeepsOperatorAttentionUnread(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for _, rec := range []domain.NotificationRecord{
		{ID: "ntf_clear", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationNeedsInput, Title: "clear", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "ntf_keep", SessionID: "main-ci", ProjectID: sess.ProjectID, Type: domain.NotificationMainCIRed, Title: "main red", Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	read, err := s.MarkAllNotificationsRead(ctx, domain.OperatorAttentionNotificationTypes())
	if err != nil {
		t.Fatalf("MarkAllNotificationsRead: %v", err)
	}
	if len(read) != 1 || read[0].ID != "ntf_clear" {
		t.Fatalf("read rows = %+v, want only non-operator-attention notification", read)
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "ntf_keep" || rows[0].Status != domain.NotificationUnread {
		t.Fatalf("unread rows = %+v, want preserved operator-attention row", rows)
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
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 2})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != "other" || rows[1].ID != "new" {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestNotificationStore_ListUnreadFiltersTypesBeforeLimit(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for i := 0; i < 105; i++ {
		rec := domain.NotificationRecord{
			ID:        fmt.Sprintf("noise_%03d", i),
			SessionID: sess.ID,
			ProjectID: sess.ProjectID,
			PRURL:     fmt.Sprintf("https://github.com/o/r/pull/%d", i+1),
			Type:      domain.NotificationPRMerged,
			Title:     "merged",
			Status:    domain.NotificationUnread,
			CreatedAt: base.Add(time.Duration(i+1) * time.Minute),
		}
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert noise %d inserted=%v err=%v", i, inserted, err)
		}
	}
	attention := domain.NotificationRecord{
		ID:        "ntf_attention",
		SessionID: "main-ci",
		ProjectID: sess.ProjectID,
		Type:      domain.NotificationMainCIRed,
		Title:     "main red",
		Status:    domain.NotificationUnread,
		CreatedAt: base,
	}
	if _, inserted, err := s.CreateNotification(ctx, attention); err != nil || !inserted {
		t.Fatalf("insert attention inserted=%v err=%v", inserted, err)
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{
		Limit: 1,
		Types: []domain.NotificationType{domain.NotificationMainCIRed},
	})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "ntf_attention" {
		t.Fatalf("rows = %+v, want old attention row despite newer noise over limit", rows)
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

// A ready_to_merge/main_ci_red notification for a new head must insert a distinct unread row
// even when an unread row for the same (session, type, pr, sensitive) tuple
// already exists — head_sha is part of the dedupe key (issue #190).
func TestNotificationStore_DifferentHeadSHADoesNotDedupe(t *testing.T) {
	for _, tc := range []struct {
		name string
		typ  domain.NotificationType
		pr   string
	}{
		{name: "ready to merge", typ: domain.NotificationReadyToMerge, pr: "https://github.com/o/r/pull/1"},
		{name: "main ci red", typ: domain.NotificationMainCIRed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStore(t)
			ctx := context.Background()
			seedProject(t, s, "mer")
			sess, err := s.CreateSession(ctx, sampleRecord("mer"))
			if err != nil {
				t.Fatalf("create session: %v", err)
			}
			now := time.Now().UTC().Truncate(time.Second)
			first := domain.NotificationRecord{
				ID:        "ntf_1",
				SessionID: sess.ID,
				ProjectID: sess.ProjectID,
				PRURL:     tc.pr,
				Type:      tc.typ,
				Title:     "notification",
				HeadSHA:   "sha-1",
				Status:    domain.NotificationUnread,
				CreatedAt: now,
			}
			if _, inserted, err := s.CreateNotification(ctx, first); err != nil || !inserted {
				t.Fatalf("CreateNotification first inserted=%v err=%v", inserted, err)
			}

			// Same tuple, same head: deduped.
			sameHead := first
			sameHead.ID = "ntf_2"
			sameHead.CreatedAt = now.Add(time.Minute)
			if _, inserted, err := s.CreateNotification(ctx, sameHead); err != nil {
				t.Fatalf("CreateNotification sameHead err=%v", err)
			} else if inserted {
				t.Fatal("same-head duplicate should be deduped, got inserted=true")
			}

			// New head: distinct row.
			newHead := first
			newHead.ID = "ntf_3"
			newHead.HeadSHA = "sha-2"
			newHead.CreatedAt = now.Add(2 * time.Minute)
			if _, inserted, err := s.CreateNotification(ctx, newHead); err != nil || !inserted {
				t.Fatalf("CreateNotification newHead inserted=%v err=%v", inserted, err)
			}

			rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
			if err != nil {
				t.Fatalf("ListUnreadNotifications: %v", err)
			}
			if len(rows) != 2 {
				t.Fatalf("rows = %d, want 2 (one per distinct head)", len(rows))
			}
		})
	}
}

// TestNotificationStore_ListUnreadSensitiveOnly pins the SensitiveOnly filter
// (#268/#319 review finding 1): the operator-attention projection queries
// sensitive ready_to_merge rows with their own budget, so routine (non-
// sensitive) rows must be filtered in SQL, never fetched and discarded.
func TestNotificationStore_ListUnreadSensitiveOnly(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for _, rec := range []domain.NotificationRecord{
		{ID: "ntf_routine", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "routine", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "ntf_sensitive", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/2", Type: domain.NotificationReadyToMerge, Title: "sensitive", Sensitive: true, Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{
		Limit:         10,
		Types:         []domain.NotificationType{domain.NotificationReadyToMerge},
		SensitiveOnly: true,
	})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "ntf_sensitive" {
		t.Fatalf("rows = %+v, want only the sensitive row", rows)
	}
}

// TestNotificationStore_ListUnreadCursorPagination pins the ack-independent
// composite cursor (created_at, id) used by readers that never mark rows read
// on delivery (#268/#319 review finding 7).
func TestNotificationStore_ListUnreadCursorPagination(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	// Three rows: two share a created_at (id tie-break), one older. Distinct
	// bodies and head SHAs keep them clear of the store's content dedupe.
	for _, rec := range []domain.NotificationRecord{
		{ID: "ntf_a", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationWorkerDiedUnfinished, Title: "oldest", Body: "a", HeadSHA: "sha-a", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "ntf_b", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationWorkerDiedUnfinished, Title: "tie-low", Body: "b", HeadSHA: "sha-b", Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
		{ID: "ntf_c", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationWorkerDiedUnfinished, Title: "tie-high", Body: "c", HeadSHA: "sha-c", Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}

	// Page 1 (no cursor): newest-first with id DESC tie-break.
	page1, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 2})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1) != 2 || page1[0].ID != "ntf_c" || page1[1].ID != "ntf_b" {
		t.Fatalf("page1 = %+v, want [ntf_c ntf_b]", page1)
	}

	// Page 2: cursor = last row of page 1.
	page2, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{
		Limit:         2,
		CreatedBefore: page1[1].CreatedAt,
		BeforeID:      page1[1].ID,
	})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 1 || page2[0].ID != "ntf_a" {
		t.Fatalf("page2 = %+v, want [ntf_a]", page2)
	}

	// Tie-break correctness: cursor at (tie timestamp, ntf_c) must return ntf_b.
	tie, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{
		Limit:         1,
		CreatedBefore: page1[0].CreatedAt,
		BeforeID:      page1[0].ID,
	})
	if err != nil {
		t.Fatalf("tie: %v", err)
	}
	if len(tie) != 1 || tie[0].ID != "ntf_b" {
		t.Fatalf("tie page = %+v, want [ntf_b]", tie)
	}
}

// TestNotificationStore_MarkAllReadKeepsSensitiveReadyToMergeUnread pins the
// sensitive-merge carve-out (#268/#319 review finding 2): read-all must not
// clear a parked_sensitive_merge item out of the operator-attention projection
// while its PR is still open. Routine ready_to_merge rows ARE cleared.
func TestNotificationStore_MarkAllReadKeepsSensitiveReadyToMergeUnread(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for _, rec := range []domain.NotificationRecord{
		{ID: "ntf_routine", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "routine", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "ntf_parked", SessionID: sess.ID, ProjectID: sess.ProjectID, PRURL: "https://github.com/o/r/pull/2", Type: domain.NotificationReadyToMerge, Title: "parked", Sensitive: true, Status: domain.NotificationUnread, CreatedAt: base.Add(time.Minute)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	read, err := s.MarkAllNotificationsRead(ctx, domain.OperatorAttentionNotificationTypes())
	if err != nil {
		t.Fatalf("MarkAllNotificationsRead: %v", err)
	}
	if len(read) != 1 || read[0].ID != "ntf_routine" {
		t.Fatalf("read rows = %+v, want only the routine ready_to_merge", read)
	}
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "ntf_parked" {
		t.Fatalf("unread rows = %+v, want the sensitive parked row preserved", rows)
	}
}

// TestNotificationStore_CursorOffsetEquivalence pins UTC normalization of the
// pagination cursor (#319 cycle-2 finding 2): SQLite compares the stored
// created_at TEXT lexically, so an equivalent instant expressed in a non-UTC
// offset must page identically to its UTC form — never skip or duplicate rows.
func TestNotificationStore_CursorOffsetEquivalence(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	sess, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := time.Date(2026, 7, 14, 10, 0, 0, 0, time.UTC)
	for _, rec := range []domain.NotificationRecord{
		{ID: "ntf_a", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationWorkerDiedUnfinished, Title: "older", Body: "a", HeadSHA: "sha-a", Status: domain.NotificationUnread, CreatedAt: base},
		{ID: "ntf_b", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationWorkerDiedUnfinished, Title: "newer", Body: "b", HeadSHA: "sha-b", Status: domain.NotificationUnread, CreatedAt: base.Add(time.Hour)},
	} {
		if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
			t.Fatalf("insert %s inserted=%v err=%v", rec.ID, inserted, err)
		}
	}
	// The same instant as ntf_b's CreatedAt, expressed at +02:00.
	offsetCursor := base.Add(time.Hour).In(time.FixedZone("CEST", 2*60*60))
	rows, err := s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{
		Limit:         10,
		CreatedBefore: offsetCursor,
		BeforeID:      "ntf_b",
	})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "ntf_a" {
		t.Fatalf("rows = %+v, want exactly [ntf_a] (offset cursor must page like its UTC equivalent)", rows)
	}
	// And a row WRITTEN with a non-UTC CreatedAt must still order/paginate
	// consistently with UTC-written rows.
	offsetRow := domain.NotificationRecord{
		ID: "ntf_c", SessionID: sess.ID, ProjectID: sess.ProjectID, Type: domain.NotificationWorkerDiedUnfinished,
		Title: "offset-written", Body: "c", HeadSHA: "sha-c", Status: domain.NotificationUnread,
		CreatedAt: base.Add(30 * time.Minute).In(time.FixedZone("CEST", 2*60*60)),
	}
	if _, inserted, err := s.CreateNotification(ctx, offsetRow); err != nil || !inserted {
		t.Fatalf("insert ntf_c inserted=%v err=%v", inserted, err)
	}
	rows, err = s.ListUnreadNotifications(ctx, notificationsvc.ListFilter{
		Limit:         10,
		CreatedBefore: base.Add(time.Hour),
		BeforeID:      "ntf_b",
	})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != "ntf_c" || rows[1].ID != "ntf_a" {
		t.Fatalf("rows = %+v, want [ntf_c ntf_a]", rows)
	}
}
