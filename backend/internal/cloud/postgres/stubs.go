package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	shelltermsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func errNotImplemented(feature string) error {
	return fmt.Errorf("ao cloud phase 1: %s is not implemented", feature)
}

func (s *Store) CreateNotification(context.Context, domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	return domain.NotificationRecord{}, false, errNotImplemented("notifications")
}
func (s *Store) ListNotifications(context.Context, notificationsvc.ListFilter) ([]domain.NotificationRecord, bool, error) {
	return []domain.NotificationRecord{}, false, nil
}
func (s *Store) CountUnreadNotifications(context.Context) (int64, error) { return 0, nil }
func (s *Store) MarkNotificationRead(context.Context, string) (domain.NotificationRecord, bool, error) {
	return domain.NotificationRecord{}, false, nil
}
func (s *Store) MarkAllNotificationsRead(context.Context) (int64, error) { return 0, nil }

func (s *Store) UpsertReview(context.Context, domain.Review) error {
	return errNotImplemented("reviews")
}
func (s *Store) GetReviewBySession(context.Context, domain.SessionID) (domain.Review, bool, error) {
	return domain.Review{}, false, nil
}
func (s *Store) InsertReviewRun(context.Context, domain.ReviewRun) error {
	return errNotImplemented("review runs")
}
func (s *Store) UpdateReviewRunResult(context.Context, string, domain.ReviewRunStatus, domain.ReviewVerdict, string, string) (bool, error) {
	return false, errNotImplemented("review run results")
}
func (s *Store) SupersedeStaleRunningReviewRuns(context.Context, domain.SessionID, string, string, string) (int64, error) {
	return 0, nil
}
func (s *Store) CancelRunningReviewRunsBySession(context.Context, domain.SessionID, string) (int64, error) {
	return 0, nil
}
func (s *Store) MarkReviewRunDelivered(context.Context, string, time.Time) (bool, error) {
	return false, nil
}
func (s *Store) GetReviewRun(context.Context, string) (domain.ReviewRun, bool, error) {
	return domain.ReviewRun{}, false, nil
}
func (s *Store) GetReviewRunBySessionPRAndSHA(context.Context, domain.SessionID, string, string) (domain.ReviewRun, bool, error) {
	return domain.ReviewRun{}, false, nil
}
func (s *Store) ListReviewRunsBySession(context.Context, domain.SessionID) ([]domain.ReviewRun, error) {
	return []domain.ReviewRun{}, nil
}
func (s *Store) ListRunningReviewRunsBySession(context.Context, domain.SessionID) ([]domain.ReviewRun, error) {
	return []domain.ReviewRun{}, nil
}
func (s *Store) ListReviewRunsByBatch(context.Context, domain.SessionID, string) ([]domain.ReviewRun, error) {
	return []domain.ReviewRun{}, nil
}

func (s *Store) UpsertSessionCleanupFacts(context.Context, domain.SessionCleanupRecord) error {
	return nil
}
func (s *Store) GetSessionCleanupFacts(context.Context, domain.SessionID) (domain.SessionCleanupRecord, bool, error) {
	return domain.SessionCleanupRecord{}, false, nil
}
func (s *Store) ListTerminalCleanupCandidates(context.Context, time.Time) ([]domain.SessionID, error) {
	return []domain.SessionID{}, nil
}

func (s *Store) InsertShellTerminal(context.Context, shelltermsvc.ShellTerminalRecord) error {
	return errNotImplemented("shell terminals")
}
func (s *Store) SelectShellTerminalByHandleID(context.Context, string) (shelltermsvc.ShellTerminalRecord, bool, error) {
	return shelltermsvc.ShellTerminalRecord{}, false, nil
}
func (s *Store) SelectShellTerminalsByAppRunID(context.Context, string) ([]shelltermsvc.ShellTerminalRecord, error) {
	return []shelltermsvc.ShellTerminalRecord{}, nil
}
func (s *Store) SelectShellTerminalsBySessionID(context.Context, domain.SessionID) ([]shelltermsvc.ShellTerminalRecord, error) {
	return []shelltermsvc.ShellTerminalRecord{}, nil
}
func (s *Store) SelectShellTerminalsFromPreviousAppRuns(context.Context, string) ([]shelltermsvc.ShellTerminalRecord, error) {
	return []shelltermsvc.ShellTerminalRecord{}, nil
}
func (s *Store) UpdateShellTerminalTitle(context.Context, string, string) (shelltermsvc.ShellTerminalRecord, bool, error) {
	return shelltermsvc.ShellTerminalRecord{}, false, nil
}
func (s *Store) DeleteShellTerminalByHandleID(context.Context, string) (bool, error) {
	return false, nil
}
func (s *Store) DeleteShellTerminalsFromPreviousAppRuns(context.Context, string) (int64, error) {
	return 0, nil
}

func (s *Store) CreateTelemetryEvent(context.Context, sqlitestore.TelemetryEventRecord) error {
	return nil
}
func (s *Store) ListTelemetryEventsSince(context.Context, time.Time, int64) ([]any, error) {
	return nil, errNotImplemented("telemetry export")
}
func (s *Store) PruneTelemetryEventsBefore(context.Context, time.Time, int64) (int64, error) {
	return 0, nil
}

func (s *Store) RecordWorkerIdle(context.Context, domain.SessionRecord, domain.WorkerIdleEvent) error {
	return nil
}
func (s *Store) ListPendingWorkerIdleEventsByProject(context.Context, domain.ProjectID) ([]domain.WorkerIdleEvent, error) {
	return []domain.WorkerIdleEvent{}, nil
}
func (s *Store) ListPendingWorkerIdleEvents(context.Context) ([]domain.WorkerIdleEvent, error) {
	return []domain.WorkerIdleEvent{}, nil
}
func (s *Store) MarkWorkerIdleEventDelivered(context.Context, string, time.Time) error { return nil }
