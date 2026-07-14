package controllers_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

func TestAttentionAPI_ListOperatorWaitingDerivesHumanOnlyItems(t *testing.T) {
	now := time.Date(2026, 7, 11, 3, 20, 0, 0, time.UTC)
	svc := newFakeSessionService()
	svc.sessions = map[domain.SessionID]domain.Session{
		"perm-1": sessionForAttention("perm-1", "ao", domain.StatusNeedsInput, now),
		"ask-1":  sessionForAttention("ask-1", "ao", domain.StatusNeedsInput, now),
		"merge-1": {
			SessionRecord: domain.SessionRecord{
				ID:        "merge-1",
				ProjectID: "ao",
				Kind:      domain.KindWorker,
				Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
				CreatedAt: now,
				UpdatedAt: now,
			},
			Status: domain.StatusMergeable,
			PRs: []domain.PRFacts{{
				URL:          "https://github.com/aoagents/agent-orchestrator/pull/224",
				Number:       224,
				CI:           domain.CIPassing,
				Review:       domain.ReviewApproved,
				Mergeability: domain.MergeMergeable,
				UpdatedAt:    now,
			}},
		},
		"ci-1":     sessionForAttention("ci-1", "ao", domain.StatusCIFailed, now),
		"review-1": sessionForAttention("review-1", "ao", domain.StatusReviewPending, now),
		"draft-1":  sessionForAttention("draft-1", "ao", domain.StatusDraft, now),
		"done-1":   sessionForAttention("done-1", "ao", domain.StatusTerminated, now),
		"dup-1":    sessionForAttention("dup-1", "ao", domain.StatusMergeable, now),
		"fix-1":    sessionForAttention("fix-1", "ao", domain.StatusChangesRequested, now),
		"other-1":  sessionForAttention("other-1", "other", domain.StatusMergeable, now),
		"orch-dead": {
			SessionRecord: domain.SessionRecord{
				ID:        "orch-dead",
				ProjectID: "ao",
				Kind:      domain.KindOrchestrator,
				Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
				CreatedAt: now,
				UpdatedAt: now,
			},
			Status: domain.StatusNoSignal,
		},
		"prime-dead": {
			SessionRecord: domain.SessionRecord{
				ID:        "prime-dead",
				ProjectID: "ao",
				Kind:      domain.KindPrime,
				Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
				CreatedAt: now,
				UpdatedAt: now,
			},
			Status: domain.StatusNoSignal,
		},
		"worker-no-signal": sessionForAttention("worker-no-signal", "ao", domain.StatusNoSignal, now),
	}
	done := svc.sessions["done-1"]
	done.IsTerminated = true
	svc.sessions["done-1"] = done
	setSessionPRFacts(svc, "dup-1", "https://github.com/aoagents/agent-orchestrator/pull/224", 224, domain.CIPassing, domain.ReviewApproved, domain.MergeMergeable, now.Add(time.Minute))
	setSessionPRFacts(svc, "done-1", "https://github.com/aoagents/agent-orchestrator/pull/226", 226, domain.CIPassing, domain.ReviewApproved, domain.MergeMergeable, now.Add(-time.Minute))
	setSessionPRFacts(svc, "fix-1", "https://github.com/aoagents/agent-orchestrator/pull/227", 227, domain.CIPassing, domain.ReviewApproved, domain.MergeMergeable, now)
	setSessionPRFacts(svc, "other-1", "https://github.com/acme/other/pull/224", 224, domain.CIPassing, domain.ReviewApproved, domain.MergeMergeable, now)
	setSessionPRFacts(svc, "ci-1", "https://github.com/aoagents/agent-orchestrator/pull/225", 225, domain.CIFailing, domain.ReviewRequired, domain.MergeBlocked, now)
	// The projection reads captured dialogs straight off the session snapshot
	// (Metadata.PendingDecision), never via the Decision endpoint.
	setSessionPendingDecision(svc, "perm-1", domain.PendingDecision{Kind: domain.DecisionKindPermission, Question: "Allow command?"})
	setSessionPendingDecision(svc, "ask-1", domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "Use strategy A or B?", Options: []string{"A", "B"}})
	svc.notifications = []notificationsvc.Notification{
		{NotificationRecord: domain.NotificationRecord{
			ID:        "n-died",
			SessionID: "dead-worker",
			ProjectID: "ao",
			PRURL:     "https://github.com/aoagents/agent-orchestrator/pull/230",
			Type:      domain.NotificationWorkerDiedUnfinished,
			Title:     "worker died with unfinished work: issue #230",
			Body:      "dead-worker terminated before issue #230 landed; restart a worker explicitly to resume it.",
			Status:    domain.NotificationUnread,
			CreatedAt: now.Add(2 * time.Minute),
		}},
		{NotificationRecord: domain.NotificationRecord{
			ID:        "n-routine-merged",
			SessionID: "done-routine",
			ProjectID: "ao",
			PRURL:     "https://github.com/aoagents/agent-orchestrator/pull/231",
			Type:      domain.NotificationPRMerged,
			Title:     "PR #231 was merged",
			Status:    domain.NotificationUnread,
			CreatedAt: now.Add(3 * time.Minute),
		}},
	}
	svc.prSummaries = map[domain.SessionID][]sessionsvc.PRSummary{
		"merge-1": {{
			URL:          "https://github.com/aoagents/agent-orchestrator/pull/224",
			HTMLURL:      "https://github.com/aoagents/agent-orchestrator/pull/224",
			Number:       224,
			Title:        "Ready but human gated",
			State:        domain.PRStateOpen,
			Provider:     "github",
			Repo:         "aoagents/agent-orchestrator",
			SourceBranch: "ao/worker",
			TargetBranch: "main",
			HeadSHA:      "abc123",
			CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
			Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateUpToDate, TargetSHA: "abc123"},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: "https://github.com/aoagents/agent-orchestrator/pull/224"},
			UpdatedAt:    now,
		}},
		"dup-1": {{
			URL:          "https://github.com/aoagents/agent-orchestrator/pull/224",
			HTMLURL:      "https://github.com/aoagents/agent-orchestrator/pull/224",
			Number:       224,
			Title:        "Ready but human gated",
			State:        domain.PRStateOpen,
			HeadSHA:      "abc123",
			CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
			Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateUpToDate, TargetSHA: "abc123"},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: "https://github.com/aoagents/agent-orchestrator/pull/224"},
			UpdatedAt:    now.Add(time.Minute),
		}},
		"done-1": {{
			URL:          "https://github.com/aoagents/agent-orchestrator/pull/226",
			HTMLURL:      "https://github.com/aoagents/agent-orchestrator/pull/226",
			Number:       226,
			Title:        "Ready after worker cleanup",
			State:        domain.PRStateOpen,
			HeadSHA:      "def456",
			CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
			Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateUpToDate, TargetSHA: "def456"},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: "https://github.com/aoagents/agent-orchestrator/pull/226"},
			UpdatedAt:    now.Add(-time.Minute),
		}},
		"fix-1": {{
			URL:          "https://github.com/aoagents/agent-orchestrator/pull/227",
			HTMLURL:      "https://github.com/aoagents/agent-orchestrator/pull/227",
			Number:       227,
			Title:        "Final review requested changes",
			State:        domain.PRStateOpen,
			HeadSHA:      "ghi789",
			CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
			Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateChangesRequested, TargetSHA: "ghi789"},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: "https://github.com/aoagents/agent-orchestrator/pull/227"},
			UpdatedAt:    now,
		}},
		"other-1": {{
			URL:          "https://github.com/acme/other/pull/224",
			HTMLURL:      "https://github.com/acme/other/pull/224",
			Number:       224,
			Title:        "Same number different project",
			State:        domain.PRStateOpen,
			HeadSHA:      "jkl012",
			CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
			Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateUpToDate, TargetSHA: "jkl012"},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: "https://github.com/acme/other/pull/224"},
			UpdatedAt:    now,
		}},
		"ci-1": {{
			URL:          "https://github.com/aoagents/agent-orchestrator/pull/225",
			Number:       225,
			Title:        "Agent can fix CI",
			State:        domain.PRStateOpen,
			CI:           sessionsvc.PRCISummary{State: domain.CIFailing},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateNeedsReview},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeBlocked},
			UpdatedAt:    now,
		}},
	}
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/attention/operator", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Items []struct {
			ID        string `json:"id"`
			Kind      string `json:"kind"`
			SessionID string `json:"sessionId"`
			Reason    string `json:"reason"`
			Action    string `json:"action"`
			DeepLink  string `json:"deepLink"`
			PRNumber  int    `json:"prNumber"`
			PRURL     string `json:"prUrl"`
		} `json:"items"`
	}
	mustJSON(t, body, &resp)
	got := map[string]int{}
	byID := map[string]struct {
		SessionID string
		Action    string
	}{}
	for _, item := range resp.Items {
		got[item.ID]++
		byID[item.ID] = struct {
			SessionID string
			Action    string
		}{SessionID: item.SessionID, Action: item.Action}
		if item.Reason == "" || item.Action == "" {
			t.Fatalf("item missing reason/action: %+v", item)
		}
	}
	pr224 := "pr:https://github.com/aoagents/agent-orchestrator/pull/224:merge"
	pr226 := "pr:https://github.com/aoagents/agent-orchestrator/pull/226:merge"
	otherPR224 := "pr:https://github.com/acme/other/pull/224:merge"
	workerDied := "notification:ao:dead-worker:worker_died_unfinished"
	for _, want := range []string{"session:perm-1:decision", "session:ask-1:decision", "session:orch-dead:no_signal", "session:prime-dead:no_signal", pr224, pr226, otherPR224, workerDied} {
		if got[want] == 0 {
			t.Fatalf("missing %s in %#v; body=%s", want, got, body)
		}
		if got[want] > 1 {
			t.Fatalf("duplicate %s count=%d in %#v; body=%s", want, got[want], got, body)
		}
	}
	if byID[pr224].SessionID != "dup-1" {
		t.Fatalf("deduped PR session = %s, want dup-1; body=%s", byID[pr224].SessionID, body)
	}
	if byID[pr224].Action != "Review final-review status and merge the pull request when the gate is clean." {
		t.Fatalf("PR action = %q", byID[pr224].Action)
	}
	if byID["session:prime-dead:no_signal"].Action != "Inspect the prime supervisor and restart or replace it if needed." {
		t.Fatalf("prime no-signal action = %q", byID["session:prime-dead:no_signal"].Action)
	}
	var diedItem struct {
		Kind     string
		PRURL    string
		DeepLink string
	}
	for _, item := range resp.Items {
		if item.ID == workerDied {
			diedItem.Kind = item.Kind
			diedItem.PRURL = item.PRURL
			diedItem.DeepLink = item.DeepLink
			break
		}
	}
	if diedItem.Kind != "worker_died_unfinished" || diedItem.PRURL != "https://github.com/aoagents/agent-orchestrator/pull/230" || diedItem.DeepLink != "https://github.com/aoagents/agent-orchestrator/pull/230" {
		t.Fatalf("worker died attention item = %+v", diedItem)
	}
	for _, excluded := range []string{"session:ci-1", "session:review-1", "session:draft-1", "session:worker-no-signal:no_signal", "pr:https://github.com/aoagents/agent-orchestrator/pull/225:merge", "pr:https://github.com/aoagents/agent-orchestrator/pull/227:merge", "notification:ao:done-routine:pr_merged"} {
		if got[excluded] > 0 {
			t.Fatalf("excluded %s present in %#v; body=%s", excluded, got, body)
		}
	}
	for _, skipped := range []domain.SessionID{"perm-1", "ask-1", "review-1", "draft-1"} {
		if svc.prSummaryCalls[skipped] > 0 {
			t.Fatalf("ListPRSummaries called for %s without open PR facts", skipped)
		}
	}
}

func TestAttentionAPI_ListOperatorWaitingSkipsSessionsDeletedDuringDerive(t *testing.T) {
	now := time.Date(2026, 7, 11, 3, 20, 0, 0, time.UTC)
	svc := newFakeSessionService()
	svc.sessions = map[domain.SessionID]domain.Session{
		"gone-decision": sessionForAttention("gone-decision", "ao", domain.StatusNeedsInput, now),
		"gone-pr":       sessionForAttention("gone-pr", "ao", domain.StatusMergeable, now),
		"merge-1":       sessionForAttention("merge-1", "ao", domain.StatusMergeable, now),
	}
	setSessionPRFacts(svc, "gone-pr", "https://github.com/aoagents/agent-orchestrator/pull/223", 223, domain.CIPassing, domain.ReviewApproved, domain.MergeMergeable, now)
	setSessionPRFacts(svc, "merge-1", "https://github.com/aoagents/agent-orchestrator/pull/224", 224, domain.CIPassing, domain.ReviewApproved, domain.MergeMergeable, now)
	svc.decisionErrs = map[domain.SessionID]error{
		"gone-decision": apierr.NotFound("SESSION_NOT_FOUND", "Unknown session"),
	}
	svc.prSummaryErrs = map[domain.SessionID]error{
		"gone-pr": apierr.NotFound("SESSION_NOT_FOUND", "Unknown session"),
	}
	svc.prSummaries = map[domain.SessionID][]sessionsvc.PRSummary{
		"merge-1": {{
			URL:          "https://github.com/aoagents/agent-orchestrator/pull/224",
			HTMLURL:      "https://github.com/aoagents/agent-orchestrator/pull/224",
			Number:       224,
			Title:        "Ready but human gated",
			State:        domain.PRStateOpen,
			HeadSHA:      "abc123",
			CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
			Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
			FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateUpToDate, TargetSHA: "abc123"},
			Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: "https://github.com/aoagents/agent-orchestrator/pull/224"},
			UpdatedAt:    now,
		}},
	}
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/attention/operator", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	mustJSON(t, body, &resp)
	if len(resp.Items) != 1 || resp.Items[0].ID != "pr:https://github.com/aoagents/agent-orchestrator/pull/224:merge" {
		t.Fatalf("items = %#v; body=%s", resp.Items, body)
	}
}

func TestAttentionAPI_ListOperatorWaitingSurvivesNotificationReadFailure(t *testing.T) {
	now := time.Date(2026, 7, 11, 3, 20, 0, 0, time.UTC)
	svc := newFakeSessionService()
	svc.sessions = map[domain.SessionID]domain.Session{
		"perm-1": sessionForAttention("perm-1", "ao", domain.StatusNeedsInput, now),
	}
	setSessionPendingDecision(svc, "perm-1", domain.PendingDecision{Kind: domain.DecisionKindPermission, Question: "Allow command?"})
	svc.notificationErr = errors.New("sqlite busy")
	srv := newSessionTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/attention/operator", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	mustJSON(t, body, &resp)
	if len(resp.Items) != 1 || resp.Items[0].ID != "session:perm-1:decision" {
		t.Fatalf("items = %#v; body=%s", resp.Items, body)
	}
}

func setSessionPendingDecision(svc *fakeSessionService, id domain.SessionID, decision domain.PendingDecision) {
	sess := svc.sessions[id]
	sess.Metadata.PendingDecision = &decision
	sess.Activity.State = domain.ActivityWaitingInput
	svc.sessions[id] = sess
}

func sessionForAttention(id domain.SessionID, project domain.ProjectID, status domain.SessionStatus, now time.Time) domain.Session {
	return domain.Session{
		SessionRecord: domain.SessionRecord{
			ID:        id,
			ProjectID: project,
			Kind:      domain.KindWorker,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
			CreatedAt: now,
			UpdatedAt: now,
		},
		Status: status,
	}
}

func setSessionPRFacts(svc *fakeSessionService, id domain.SessionID, url string, number int, ci domain.CIState, review domain.ReviewDecision, mergeability domain.Mergeability, updatedAt time.Time) {
	sess := svc.sessions[id]
	sess.PRs = []domain.PRFacts{{
		URL:          url,
		Number:       number,
		CI:           ci,
		Review:       review,
		Mergeability: mergeability,
		UpdatedAt:    updatedAt,
	}}
	svc.sessions[id] = sess
}
