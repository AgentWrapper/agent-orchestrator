// Package attention owns the canonical operator-attention projection: a single
// transport-neutral, daemon-owned current-state view that web, CLI, and Slack
// all consume (per the #271 architecture: "New read projection: a service
// package consumed by every client").
//
// Phase 1 of issue #268 extracts this derivation out of the httpd controller so
// the controller becomes a thin HTTP adapter over Service.ListOperator. The
// projection logic — sources, exclusions, dedup/supersede, and ordering — is
// preserved exactly; the Phase 0 parity contract (service/attention parity
// test) is the regression harness that proves it.
package attention

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// Item is one entry in the canonical operator-attention projection. It is
// transport-neutral: HTTP, CLI, and Slack each render it into their own shape.
// The controller maps this to its wire DTO (controllers.OperatorAttentionItem)
// so the OpenAPI contract is unchanged by the extraction.
type Item struct {
	ID           string
	Kind         string
	ProjectID    domain.ProjectID
	SessionID    domain.SessionID
	SessionTitle string
	Reason       string
	Action       string
	DeepLink     string
	UpdatedAt    time.Time
	DecisionKind domain.DecisionKind
	Question     string
	PRNumber     int
	PRURL        string
	PRTitle      string
}

// SessionReader is the session read surface needed to derive the operator queue.
// Defining it here keeps the projection owner transport-neutral (it depends on
// service read models, never on HTTP). Decision classification deliberately
// reads sess.Metadata.PendingDecision from the SAME List snapshot instead of a
// per-session Decision() call: session_manager.Decision synthesizes a permission
// decision for every blocked session, which would make captured-vs-uncaptured
// indistinguishable, and a second read could disagree with the snapshot.
type SessionReader interface {
	List(ctx context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error)
	ListPRSummaries(ctx context.Context, id domain.SessionID) ([]sessionsvc.PRSummary, error)
}

// NotificationReader is the unread-notification read surface used to fold
// durable operator escalations into the projection.
type NotificationReader interface {
	ListUnread(ctx context.Context, filter notificationsvc.ListFilter) ([]notificationsvc.Notification, error)
}

// Service is the canonical operator-attention projection owner.
type Service struct {
	sessions      SessionReader
	notifications NotificationReader
}

// Deps configures a Service. Notifications is optional: when nil (or when its
// read fails at request time) the projection degrades to session-derived items
// only, matching the pre-extraction resilience behavior.
type Deps struct {
	Sessions      SessionReader
	Notifications NotificationReader
}

// New constructs the operator-attention projection owner. Notifications is
// optional; when it is nil the projection degrades to session-derived items.
func New(d Deps) *Service {
	return &Service{sessions: d.Sessions, notifications: d.Notifications}
}

// ListOperator returns the canonical operator-attention projection: the current
// set of items that need a human, deduped and ordered newest-first (with a
// stable ID tie-break). This is the single derivation web, CLI, and Slack share.
func (s *Service) ListOperator(ctx context.Context) ([]Item, error) {
	if s == nil || s.sessions == nil {
		return nil, errors.New("attention: session reader is required")
	}
	return deriveOperatorAttention(ctx, s.sessions, s.notifications)
}

func deriveOperatorAttention(ctx context.Context, sessions SessionReader, notifications NotificationReader) ([]Item, error) {
	list, err := sessions.List(ctx, sessionsvc.ListFilter{})
	if err != nil {
		return nil, err
	}
	items := make([]Item, 0)
	seen := map[string]attentionItemIndex{}
	// terminalPRs collects canonical PR identities the session facts show as
	// terminal (including on terminated sessions — a merged PR is merged
	// regardless). Read != delivery means an unread ready_to_merge notification
	// row can outlive its PR; a parked_sensitive_merge item must not keep
	// reporting a human-gated merge the daemon's own PR state says already
	// resolved. Unknown identities stay unsuppressed: the projection fails
	// toward showing attention.
	terminalPRs := terminalPRIdentities(list)
	notificationItems, parkedPRs := deriveNotificationAttention(ctx, notifications, terminalPRs)
	for _, sess := range list {
		if !sess.IsTerminated && sess.Activity.State != domain.ActivityExited {
			// Captured-vs-uncaptured comes straight from the List snapshot (see the
			// SessionReader doc): a captured dialog renders as a decision item; a
			// blocked session WITHOUT captured dialog metadata is the JS notifier's
			// `blocked` classification ("stuck on an unknown dialog").
			if sess.Status == domain.StatusNeedsInput && sess.Metadata.PendingDecision != nil {
				items = appendAttentionItem(items, seen, decisionAttentionItem(sess, *sess.Metadata.PendingDecision), true)
			} else if sess.Activity.State == domain.ActivityBlocked {
				items = appendAttentionItem(items, seen, blockedAttentionItem(sess), true)
			}
		}
		if !sess.IsTerminated && sess.Status == domain.StatusNoSignal {
			if item, ok := noSignalAttentionItem(sess); ok {
				items = appendAttentionItem(items, seen, item, true)
			}
		}
		if !sessionHasOpenPR(sess) {
			continue
		}
		prs, err := sessions.ListPRSummaries(ctx, sess.ID)
		if err != nil {
			if isAttentionNotFound(err) {
				continue
			}
			return nil, fmt.Errorf("pr summaries %s: %w", sess.ID, err)
		}
		for _, pr := range prs {
			item, ok := prAttentionItem(sess, pr)
			if !ok {
				continue
			}
			// A parked_sensitive_merge item supersedes the generic live "pr" item
			// for the same PR: the operator sees one item, and it is the human-gate.
			if parkedPRs[canonicalPRKey(firstNonEmptyString(pr.HTMLURL, pr.URL))] {
				continue
			}
			items = appendAttentionItem(items, seen, item, !sess.IsTerminated)
		}
	}
	for _, item := range notificationItems {
		items = appendAttentionItem(items, seen, item, false)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].UpdatedAt.After(items[j].UpdatedAt)
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

// terminalPRIdentities resolves each canonical PR identity across ALL session
// facts by recency: a merged fact is permanently terminal (merges cannot be
// undone), while closed-vs-open is decided by the NEWEST fact, so a reopened PR
// — or a stale closed fact on an old session sharing the PR with a newer one —
// never wrongly suppresses a parked_sensitive_merge item. A tie between an open
// and a closed fact at the same instant reads as open (fail toward attention).
func terminalPRIdentities(list []domain.Session) map[string]bool {
	type prFactState struct {
		merged       bool
		seen         bool
		newestAt     time.Time
		newestClosed bool
	}
	facts := map[string]*prFactState{}
	for _, sess := range list {
		for _, pr := range sess.PRs {
			if pr.URL == "" {
				continue
			}
			key := canonicalPRKey(pr.URL)
			st := facts[key]
			if st == nil {
				st = &prFactState{}
				facts[key] = st
			}
			if pr.Merged {
				st.merged = true
			}
			switch {
			case !st.seen || pr.UpdatedAt.After(st.newestAt):
				st.seen = true
				st.newestAt = pr.UpdatedAt
				st.newestClosed = pr.Closed
			case pr.UpdatedAt.Equal(st.newestAt) && !pr.Closed:
				st.newestClosed = false
			}
		}
	}
	terminal := map[string]bool{}
	for key, st := range facts {
		if st.merged || st.newestClosed {
			terminal[key] = true
		}
	}
	return terminal
}

// deriveNotificationAttention folds unread durable notifications into projection
// items. It issues two bounded reads so unbounded routine rows can never crowd
// escalations out of a shared page (finding 1, PR #319 review): the durable
// escalation types get their own budget, and ready_to_merge is fetched
// sensitive-only in SQL with a separate budget. It returns the items plus the
// set of canonical PR identities that are parked for a human.
func deriveNotificationAttention(ctx context.Context, notifications NotificationReader, terminalPRs map[string]bool) ([]Item, map[string]bool) {
	parkedPRs := map[string]bool{}
	if notifications == nil {
		return nil, parkedPRs
	}
	items := make([]Item, 0)
	durable, err := notifications.ListUnread(ctx, notificationsvc.ListFilter{
		Limit: notificationsvc.MaxListLimit,
		Types: domain.OperatorAttentionNotificationTypes(),
	})
	if err != nil {
		// Notifications add durable operator escalations, but the core waiting
		// surface must still render live session decisions and mergeable PRs if
		// notification storage is temporarily unavailable.
		slog.WarnContext(ctx, "attention: notification read failed; returning session-derived operator attention only", "err", err)
	} else {
		for _, notification := range durable {
			if item, ok := notificationAttentionItem(notification); ok {
				items = append(items, item)
			}
		}
	}
	parked, err := notifications.ListUnread(ctx, notificationsvc.ListFilter{
		Limit:         notificationsvc.MaxListLimit,
		Types:         []domain.NotificationType{domain.NotificationReadyToMerge},
		SensitiveOnly: true,
	})
	if err != nil {
		slog.WarnContext(ctx, "attention: sensitive ready_to_merge read failed; parked merges omitted this cycle", "err", err)
		return items, parkedPRs
	}
	for _, notification := range parked {
		// A row for a PR the session facts show merged/closed is stale delivery
		// state, not attention: suppress it (see terminalPRs).
		if terminalPRs[canonicalPRKey(notification.PRURL)] {
			continue
		}
		item, ok := parkedSensitiveMergeItem(notification)
		if !ok {
			continue
		}
		if notification.PRURL != "" {
			parkedPRs[canonicalPRKey(notification.PRURL)] = true
		}
		items = append(items, item)
	}
	return items, parkedPRs
}

type operatorAttentionNotificationMetadata struct {
	action        string
	defaultReason string
}

// operatorAttentionNotificationMetadata maps durable notification types to the
// operator copy they demand, and reports whether that type is an
// operator-attention event at all. Only types a human must act on belong in the
// projection; informational types (pr_merged, model_recovered, …) are excluded
// so the projection stays a "what needs me" surface, not a notification mirror.
//
// needs_input is covered by live session/decision derivation. ready_to_merge
// is handled separately in parkedSensitiveMergeItem: only its SENSITIVE rows
// are an operator-attention condition (a human-gated parked merge), so the
// sensitivity check is per-record, not per-type.
func operatorAttentionNotificationMetadataFor(t domain.NotificationType) (operatorAttentionNotificationMetadata, bool) {
	switch t {
	case domain.NotificationWorkerDiedUnfinished:
		return operatorAttentionNotificationMetadata{
			action:        "Diagnose the recovery incident before cleanup, apply a new fix or scoped remediation, then respawn only to verify it.",
			defaultReason: "A worker died before its issue landed.",
		}, true
	case domain.NotificationMainCIRed:
		return operatorAttentionNotificationMetadata{
			action:        "Fix main-branch CI before merging; only main-CI fix PRs should merge until it is green.",
			defaultReason: "Main-branch CI is failing; merges are frozen until it is green.",
		}, true
	case domain.NotificationDuplicatePR:
		return operatorAttentionNotificationMetadata{
			action:        "Review the duplicate pull requests and close the one that should not land.",
			defaultReason: "A second pull request was opened for the same issue.",
		}, true
	case domain.NotificationOrchestratorReplacementCapped:
		return operatorAttentionNotificationMetadata{
			action:        "Auto-replacement is backed off; inspect the supervised role's harness, auth, and hook pipeline.",
			defaultReason: "AO exhausted the fast replacement window and is retrying with backoff.",
		}, true
	default:
		return operatorAttentionNotificationMetadata{}, false
	}
}

// parkedSensitiveMergeMetadata is the copy for a ready_to_merge notification
// whose diff touches sensitive paths: autonomous merge is parked for a human.
var parkedSensitiveMergeMetadata = operatorAttentionNotificationMetadata{
	action:        "Review the sensitive-path change and merge the pull request yourself; autonomous merge is parked for a human.",
	defaultReason: "A ready-to-merge PR touches sensitive paths and needs a human to merge it.",
}

// parkedSensitiveMergeItem builds the human-gated parked-merge item from a
// SENSITIVE unread ready_to_merge notification. The item is keyed by the PR's
// canonical identity, not the notification row id, so multiple unread rows for
// the same PR (one per head SHA) collapse into one item and the parked item can
// supersede the generic live "pr" item for that PR (finding 4, PR #319 review).
func parkedSensitiveMergeItem(notification notificationsvc.Notification) (Item, bool) {
	if notification.Type != domain.NotificationReadyToMerge || !notification.Sensitive {
		return Item{}, false
	}
	id := notificationAttentionID(notification)
	if notification.PRURL != "" {
		id = "pr:" + canonicalPRKey(notification.PRURL) + ":parked_sensitive_merge"
	}
	subjectID := notificationSubjectID(notification)
	return Item{
		ID:           id,
		Kind:         "parked_sensitive_merge",
		ProjectID:    notification.ProjectID,
		SessionID:    notification.SessionID,
		SessionTitle: firstNonEmptyString(notification.Title, notification.Body, subjectID, string(notification.SessionID)),
		Reason:       firstNonEmptyString(notification.Body, notification.Title, parkedSensitiveMergeMetadata.defaultReason),
		Action:       parkedSensitiveMergeMetadata.action,
		DeepLink:     notificationAttentionDeepLink(notification),
		UpdatedAt:    notification.CreatedAt,
		PRURL:        notification.PRURL,
	}, true
}

// canonicalPRKey normalizes a PR URL to "host/owner/repo#number" for identity
// comparisons: terminal suppression, parked-item dedup, and parked-over-live-pr
// supersede. It also folds provider URL variants onto one identity: GitLab's
// web form ("/owner/repo/-/merge_requests/N" — the "-" separator is dropped)
// and GitHub's API form ("https://api.github.com/repos/o/r/pulls/N" — the
// "repos" segment and "api." host prefix are dropped). Unparseable or non-PR
// URLs return the trimmed raw string, so they only ever match themselves
// exactly (fail open: an unrecognized URL never suppresses someone else's
// attention item). ops/attention-core.mjs canonicalPrKey mirrors this parser;
// ops/canonical-pr-key-fixtures.json is the shared cross-language contract.
func canonicalPRKey(raw string) string {
	trimmed := strings.TrimSpace(raw)
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return trimmed
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segs) < 4 {
		return trimmed
	}
	kind, number := segs[len(segs)-2], segs[len(segs)-1]
	if (kind != "pull" && kind != "pulls" && kind != "merge_requests") || !isAllDigits(number) {
		return trimmed
	}
	host := strings.ToLower(u.Host)
	repoSegs := segs[:len(segs)-2]
	if repoSegs[len(repoSegs)-1] == "-" {
		repoSegs = repoSegs[:len(repoSegs)-1] // GitLab web form separator
	}
	if len(repoSegs) > 1 && repoSegs[0] == "repos" && strings.HasPrefix(host, "api.") {
		repoSegs = repoSegs[1:] // GitHub API form
		host = strings.TrimPrefix(host, "api.")
	}
	if len(repoSegs) == 0 {
		return trimmed
	}
	return host + "/" + strings.ToLower(strings.Join(repoSegs, "/")) + "#" + number
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func notificationAttentionItem(notification notificationsvc.Notification) (Item, bool) {
	metadata, ok := operatorAttentionNotificationMetadataFor(notification.Type)
	if !ok {
		return Item{}, false
	}
	subjectID := notificationSubjectID(notification)
	return Item{
		ID:           notificationAttentionID(notification),
		Kind:         string(notification.Type),
		ProjectID:    notification.ProjectID,
		SessionID:    notification.SessionID,
		SessionTitle: firstNonEmptyString(notification.Title, notification.Body, subjectID, string(notification.SessionID)),
		Reason:       firstNonEmptyString(notification.Body, notification.Title, metadata.defaultReason),
		Action:       metadata.action,
		DeepLink:     notificationAttentionDeepLink(notification),
		UpdatedAt:    notification.CreatedAt,
		PRURL:        notification.PRURL,
	}, true
}

// notificationAttentionID keys a durable notification item by its SUBJECT
// identity (never the notification row id): re-emitted rows for one unresolved
// condition collapse to a single projection item (newest wins), and a renderer's
// persisted per-item state survives row churn because the id is reconstructible
// from (project, subject, type) alone.
func notificationAttentionID(notification notificationsvc.Notification) string {
	subjectKind, subjectID := notificationSubject(notification)
	if subjectKind == string(domain.NotificationSubjectSession) {
		return fmt.Sprintf("notification:%s:%s:%s", notification.ProjectID, subjectID, notification.Type)
	}
	return fmt.Sprintf("notification:%s:%s:%s:%s", notification.ProjectID, subjectKind, subjectID, notification.Type)
}

func notificationAttentionDeepLink(notification notificationsvc.Notification) string {
	if notification.PRURL != "" {
		return notification.PRURL
	}
	subjectKind, subjectID := notificationSubject(notification)
	if notification.ProjectID != "" && subjectKind == string(domain.NotificationSubjectSession) && subjectID != "" {
		return "/projects/" + string(notification.ProjectID) + "/sessions/" + subjectID
	}
	return ""
}

func notificationSubject(notification notificationsvc.Notification) (string, string) {
	if notification.Subject.Kind != "" && notification.Subject.ID != "" {
		return string(notification.Subject.Kind), notification.Subject.ID
	}
	rec := notification.WithInferredSubject()
	return string(rec.SubjectKind), rec.SubjectID
}

func notificationSubjectID(notification notificationsvc.Notification) string {
	_, id := notificationSubject(notification)
	return id
}

func isAttentionNotFound(err error) bool {
	var apiErr *apierr.Error
	return errors.As(err, &apiErr) && apiErr.Kind == apierr.KindNotFound
}

func sessionHasOpenPR(sess domain.Session) bool {
	for _, pr := range sess.PRs {
		if !pr.Merged && !pr.Closed {
			return true
		}
	}
	return false
}

type attentionItemIndex struct {
	index int
	live  bool
}

func appendAttentionItem(items []Item, seen map[string]attentionItemIndex, item Item, live bool) []Item {
	if existing, ok := seen[item.ID]; ok {
		if attentionItemSupersedes(item, live, items[existing.index], existing.live) {
			items[existing.index] = item
			seen[item.ID] = attentionItemIndex{index: existing.index, live: live}
		}
		return items
	}
	seen[item.ID] = attentionItemIndex{index: len(items), live: live}
	return append(items, item)
}

func attentionItemSupersedes(next Item, nextLive bool, current Item, currentLive bool) bool {
	if nextLive != currentLive {
		return nextLive
	}
	return next.UpdatedAt.After(current.UpdatedAt)
}

func noSignalAttentionItem(sess domain.Session) (Item, bool) {
	var kind, reason, action string
	switch sess.Kind {
	case domain.KindPrime:
		kind = "prime_dead"
		reason = "Prime orchestrator has no live process signal."
		action = "Inspect the prime supervisor and restart or replace it if needed."
	case domain.KindOrchestrator:
		kind = "orchestrator_dead"
		reason = "Project orchestrator has no live process signal."
		action = "Inspect the project orchestrator and restart or replace it if needed."
	default:
		return Item{}, false
	}
	return Item{
		ID:           "session:" + string(sess.ID) + ":no_signal",
		Kind:         kind,
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       reason,
		Action:       action,
		DeepLink:     sessionDeepLink(sess),
		UpdatedAt:    sess.UpdatedAt,
	}, true
}

// blockedAttentionItem surfaces a session stopped on the operator (activity
// state blocked) for which no pending decision record is retrievable. Copy
// mirrors the JS notifier's "blocked / stuck" classification.
func blockedAttentionItem(sess domain.Session) Item {
	return Item{
		ID:           "session:" + string(sess.ID) + ":blocked",
		Kind:         "blocked",
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       "Session is blocked or stuck and needs the operator.",
		Action:       "Inspect the session terminal and unblock it.",
		DeepLink:     sessionDeepLink(sess),
		UpdatedAt:    sess.UpdatedAt,
	}
}

func decisionAttentionItem(sess domain.Session, decision domain.PendingDecision) Item {
	reason := "Session is waiting on an operator decision."
	action := "Answer the session question."
	if decision.Kind == domain.DecisionKindPermission {
		reason = "Session is paused on a permission dialog."
		action = "Approve or deny the permission in the session terminal."
	}
	return Item{
		ID:           "session:" + string(sess.ID) + ":decision",
		Kind:         "decision",
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       reason,
		Action:       action,
		DeepLink:     sessionDeepLink(sess),
		UpdatedAt:    sess.UpdatedAt,
		DecisionKind: decision.Kind,
		Question:     decision.Question,
	}
}

// prAttentionItem includes PRs whose local facts are mergeable and ao-reviewed.
// Operators still verify the SHA-pinned final-review gate before merging.
func prAttentionItem(sess domain.Session, pr sessionsvc.PRSummary) (Item, bool) {
	if pr.State != domain.PRStateOpen || pr.CI.State != domain.CIPassing || pr.Mergeability.State != domain.MergeMergeable {
		return Item{}, false
	}
	if pr.Review.Decision == domain.ReviewChangesRequest || pr.Review.Decision == domain.ReviewRequired || pr.Review.HasUnresolvedHumanComments {
		return Item{}, false
	}
	if pr.FinalReview.Status != reviewcore.ReviewStateUpToDate {
		return Item{}, false
	}
	return Item{
		ID:           prAttentionID(sess, pr),
		Kind:         "pr",
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       "PR is locally mergeable and waiting for operator merge authority.",
		Action:       "Review final-review status and merge the pull request when the gate is clean.",
		DeepLink:     prDeepLink(sess, pr),
		UpdatedAt:    pr.UpdatedAt,
		PRNumber:     pr.Number,
		PRURL:        firstNonEmptyString(pr.HTMLURL, pr.URL),
		PRTitle:      pr.Title,
	}, true
}

func prAttentionID(sess domain.Session, pr sessionsvc.PRSummary) string {
	if id := firstNonEmptyString(pr.HTMLURL, pr.URL); id != "" {
		return "pr:" + id + ":merge"
	}
	return fmt.Sprintf("pr:%s:%d:merge", sess.ProjectID, pr.Number)
}

func sessionAttentionTitle(sess domain.Session) string {
	if title := strings.TrimSpace(sess.DisplayName); title != "" {
		return title
	}
	if title := strings.TrimSpace(string(sess.IssueID)); title != "" {
		return title
	}
	return string(sess.ID)
}

func sessionDeepLink(sess domain.Session) string {
	return "/projects/" + string(sess.ProjectID) + "/sessions/" + string(sess.ID)
}

func prDeepLink(sess domain.Session, pr sessionsvc.PRSummary) string {
	if pr.HTMLURL != "" {
		return pr.HTMLURL
	}
	if pr.URL != "" {
		return pr.URL
	}
	return sessionDeepLink(sess)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
