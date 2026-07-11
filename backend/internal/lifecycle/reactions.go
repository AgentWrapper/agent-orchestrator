package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
)

const reviewMaxNudge = 3

var sensitiveMergePathPrefixes = []string{
	"backend/internal/daemon/",
	"backend/internal/session_manager/",
	"backend/internal/lifecycle/",
}

// ReviewDeliveryOutcome reports what ApplyReviewResult did with a completed
// AO-internal review pass.
type ReviewDeliveryOutcome string

const (
	// ReviewDeliveryNoop means lifecycle did not send or confirm a review nudge
	// because the result was not relevant for delivery.
	ReviewDeliveryNoop ReviewDeliveryOutcome = "no_op"
	// ReviewDeliverySent means the worker nudge was sent or was already covered
	// by sendOnce dedup state and may be stamped delivered.
	ReviewDeliverySent ReviewDeliveryOutcome = "sent"
)

// ReviewResult is the already-persisted result of an AO-internal review pass.
// Lifecycle treats it as input to the reaction reducer; it does not write the
// review_run row.
type ReviewResult struct {
	RunID          string
	BatchID        string
	WorkerID       domain.SessionID
	PRURL          string
	TargetSHA      string
	Verdict        domain.ReviewVerdict
	Body           string
	GithubReviewID string
	DeliveredAt    *time.Time
}

// ApplyReviewBatch reacts to one reviewer CLI submission after the review
// service has decided which current-head changes-requested results are
// deliverable.
func (m *Manager) ApplyReviewBatch(ctx context.Context, workerID domain.SessionID, batchID string, results []ReviewResult) (ReviewDeliveryOutcome, error) {
	if batchID == "" || len(results) == 0 {
		return ReviewDeliveryNoop, nil
	}
	rec, ok, err := m.store.GetSession(ctx, workerID)
	if err != nil || !ok {
		return ReviewDeliveryNoop, err
	}
	if rec.IsTerminated || rec.Activity.State.NeedsInput() {
		return ReviewDeliveryNoop, nil
	}
	if m.guard == nil {
		return ReviewDeliveryNoop, nil
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].PRURL != results[j].PRURL {
			return results[i].PRURL < results[j].PRURL
		}
		return results[i].RunID < results[j].RunID
	})
	var msg strings.Builder
	fmt.Fprintf(&msg, "[AO reviewer] AO's internal code reviewer submitted %d review(s) requesting changes.\n", len(results))
	var sigParts []string
	for i, r := range results {
		fmt.Fprintf(&msg, "\nReview %d\nPR: %s\nVerdict: %s", i+1, domain.SanitizeControlChars(r.PRURL), domain.SanitizeControlChars(string(r.Verdict)))
		if r.TargetSHA != "" {
			fmt.Fprintf(&msg, "\nHead commit: %s", domain.SanitizeControlChars(r.TargetSHA))
		}
		if r.GithubReviewID != "" {
			safeReviewID := domain.SanitizeControlChars(r.GithubReviewID)
			fmt.Fprintf(&msg, "\nGitHub review: %s", safeReviewID)
			fmt.Fprintf(&msg, "\nOnce you have addressed it, reply on GitHub review %s with how you addressed it, then resolve the review comment threads you addressed.", safeReviewID)
		}
		if r.Body != "" {
			fmt.Fprintf(&msg, "\n\nReview body:\n%s\n", domain.SanitizeControlChars(r.Body))
		}
		sigParts = append(sigParts, strings.Join([]string{r.RunID, r.PRURL, r.TargetSHA, r.GithubReviewID, r.Body}, "\x00"))
	}
	anchorPR := results[0].PRURL
	key := "review-batch:" + anchorPR + ":" + batchID
	sig := strings.Join(sigParts, "\x01")
	outcome, err := m.sendOnce(ctx, workerID, anchorPR, key, sig, msg.String(), reviewMaxNudge)
	if err != nil {
		return ReviewDeliveryNoop, err
	}
	if outcome == sendOnceSuppressed {
		// The worker went terminated/needs-input between the entry guard and the
		// paste: nothing reached it, so do NOT let the caller stamp the run
		// delivered — it must re-fire once the session is workable again.
		return ReviewDeliveryNoop, nil
	}
	return ReviewDeliverySent, nil
}

type reactionState struct {
	mu       sync.Mutex
	seen     map[string]string
	attempts map[string]int
	// loaded tracks PR URLs whose persisted dedup payload has been merged into
	// seen/attempts during this process. Lazy: we only pay the DB read on the
	// first reaction touching each PR after startup.
	loaded map[string]bool
	// inflight reserves a dedup key while its external effect runs with the
	// reaction mutex released, so two concurrent reactions for the same key can't
	// both perform the effect (check-then-act). It maps key -> signature reserved.
	inflight map[string]string
}

func newReactionState() reactionState {
	return reactionState{seen: map[string]string{}, attempts: map[string]int{}, loaded: map[string]bool{}, inflight: map[string]string{}}
}

// reactionPayload is the JSON document persisted in pr.last_nudge_signature.
// Keeping the schema explicit (and stable) lets the daemon restart and resume
// the existing dedup state without re-nudging an agent.
type reactionPayload struct {
	Seen     map[string]string `json:"seen,omitempty"`
	Attempts map[string]int    `json:"attempts,omitempty"`
}

// ApplyPRObservation reacts to a fetched PR observation after the PR service has
// persisted it. It does not write PR rows; it owns PR-driven lifecycle effects
// and sends actionable agent nudges such as rebase, fix-CI, and
// address-review-feedback prompts.
func (m *Manager) ApplyPRObservation(ctx context.Context, id domain.SessionID, o ports.PRObservation) error {
	if !o.Fetched {
		return nil
	}
	// A PR reaching a terminal state (merged or closed) no longer ends the
	// session on its own: a session may own several PRs. Terminate only when no
	// open PR remains and at least one of them merged. The observer persists the
	// PR row before calling lifecycle, so the store already reflects this
	// transition when sessionComplete reads it.
	if o.Merged || o.Closed {
		done, err := m.sessionComplete(ctx, id)
		if err != nil {
			return err
		}
		if done {
			return m.MarkTerminated(ctx, id)
		}
		return nil
	}
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil || !ok {
		return err
	}
	if rec.IsTerminated || rec.Activity.State.NeedsInput() {
		return nil
	}
	// The CI-failure, review-feedback, and merge-conflict lanes are independent
	// actionable signals with their own dedup keys. Each lane returns only when it
	// actually delivered a nudge; a dedup no-op (e.g. CI still red on the same
	// commit) falls through so a lower lane's fresh feedback is not starved.
	if o.CI == domain.CIFailing {
		ciNameCounts := map[string]int{}
		for _, ch := range o.Checks {
			if ch.Status == domain.PRCheckFailed {
				ciNameCounts[ch.Name]++
			}
		}
		seenCIKeys := map[string]bool{}
		for _, ch := range o.Checks {
			if ch.Status != domain.PRCheckFailed {
				continue
			}
			key := ciDedupeKey(o.URL, ch, ciNameCounts[ch.Name])
			if seenCIKeys[key] {
				continue
			}
			seenCIKeys[key] = true
			msg := "CI is failing on your PR. Review the output below and push a fix."
			if ch.LogTail != "" {
				// LogTail is raw CI job output; sanitize before it reaches the
				// agent's live pane so embedded escape sequences can't drive the
				// terminal (the dedup signature stays on the raw bytes).
				msg += "\n\nFailing output:\n" + domain.SanitizeControlChars(ch.LogTail)
			}
			sent, err := m.sendOnce(ctx, id, o.URL, key, ch.CommitHash+":"+ch.LogTail, msg, 0)
			if err != nil {
				return err
			}
			if sent == sendOnceSent {
				return nil
			}
		}
	}
	if o.Review == domain.ReviewChangesRequest || hasUnresolvedComments(o.Comments) {
		comments, sig := reviewContent(o.Comments)
		msg := "A reviewer left feedback on your PR. Address it and push."
		if comments != "" {
			msg += "\n\n" + comments
		}
		if sig == "" {
			sig = string(o.Review)
		}
		sent, err := m.sendOnce(ctx, id, o.URL, "review:"+o.URL, sig, msg, reviewMaxNudge)
		if err != nil {
			return err
		}
		if sent == sendOnceSent {
			return nil
		}
	}
	if o.Mergeability == domain.MergeConflicting {
		// Only the bottom of a stack is eligible for the rebase nudge. A PR
		// stacked on an open parent is expected to report conflicts against its
		// parent branch until the parent merges and it retargets, so nudging the
		// agent to rebase it now would be noise. Mergeability UNKNOWN (the brief
		// post-retarget recompute window) never reaches here.
		blocked, err := m.prBlockedByOpenParent(ctx, id, o.URL)
		if err != nil {
			return err
		}
		if blocked {
			return nil
		}
		_, err = m.sendOnce(ctx, id, o.URL, "merge-conflict:"+o.URL, string(o.Mergeability), "Your PR has merge conflicts. Rebase onto the base branch and resolve them.", 0)
		return err
	}
	return nil
}

// ApplyReviewResult reacts to a completed AO-internal review pass after the
// review service has persisted the run result. It mirrors ApplyPRObservation:
// no change_log reads, no review_run writes, only lifecycle side effects.
func (m *Manager) ApplyReviewResult(ctx context.Context, workerID domain.SessionID, r ReviewResult) (ReviewDeliveryOutcome, error) {
	if r.Verdict != domain.VerdictChangesRequested || r.DeliveredAt != nil {
		return ReviewDeliveryNoop, nil
	}
	rec, ok, err := m.store.GetSession(ctx, workerID)
	if err != nil || !ok {
		return ReviewDeliveryNoop, err
	}
	if rec.IsTerminated || rec.Activity.State.NeedsInput() {
		return ReviewDeliveryNoop, nil
	}
	if m.guard == nil {
		return ReviewDeliveryNoop, nil
	}
	msg := fmt.Sprintf("[AO reviewer] AO's internal code reviewer submitted a review.\n\nPR: %s\nVerdict: %s", domain.SanitizeControlChars(r.PRURL), domain.SanitizeControlChars(string(r.Verdict)))
	if r.GithubReviewID != "" {
		safeReviewID := domain.SanitizeControlChars(r.GithubReviewID)
		msg += fmt.Sprintf("\nGitHub review: %s", safeReviewID)
		msg += fmt.Sprintf("\n\nOnce you have addressed it, reply on GitHub review %s with how you addressed it, then resolve the review comment threads you addressed.", safeReviewID)
	}
	if r.Body != "" {
		msg += "\n\nReview body:\n" + domain.SanitizeControlChars(r.Body)
	}
	key := "review:" + r.PRURL + ":ao:" + r.RunID
	sig := strings.Join([]string{r.TargetSHA, r.RunID, r.GithubReviewID, r.Body}, "\x00")
	outcome, err := m.sendOnce(ctx, workerID, r.PRURL, key, sig, msg, reviewMaxNudge)
	if err != nil {
		return ReviewDeliveryNoop, err
	}
	if outcome == sendOnceSuppressed {
		// Suppressed by the just-in-time guard (worker went terminated/needs-
		// input): the review feedback did not reach the worker, so leave the run
		// undelivered to re-fire on the next observation.
		return ReviewDeliveryNoop, nil
	}
	return ReviewDeliverySent, nil
}

// sessionComplete reports whether the session has reached the multi-PR
// completion bar: at least one PR merged and no PR still open. A session with no
// PRs, or with any open PR, is not complete.
func (m *Manager) sessionComplete(ctx context.Context, id domain.SessionID) (bool, error) {
	prs, err := m.store.ListPRsBySession(ctx, id)
	if err != nil {
		return false, err
	}
	merged := false
	for _, pr := range prs {
		if !pr.Merged && !pr.Closed {
			return false, nil
		}
		if pr.Merged {
			merged = true
		}
	}
	return merged, nil
}

// prBlockedByOpenParent reports whether the PR at prURL is stacked on top of
// another still-open PR in the same session — i.e. its target branch is the
// source branch of a sibling open PR. Such a PR is not the bottom of its stack
// and is exempt from merge-conflict nudges. Branch facts are read from the
// store, which the observer has already updated for this observation.
func (m *Manager) prBlockedByOpenParent(ctx context.Context, id domain.SessionID, prURL string) (bool, error) {
	prs, err := m.store.ListPRsBySession(ctx, id)
	if err != nil {
		return false, err
	}
	openSources := make(map[string]bool, len(prs))
	for _, pr := range prs {
		if !pr.Merged && !pr.Closed && pr.SourceBranch != "" {
			openSources[pr.SourceBranch] = true
		}
	}
	for _, pr := range prs {
		if pr.URL == prURL {
			return pr.TargetBranch != "" && openSources[pr.TargetBranch], nil
		}
	}
	return false, nil
}

// ApplySCMObservation is the provider-neutral lifecycle entrypoint used by the
// SCM observer. The existing reaction logic still operates on PRObservation, so
// lifecycle performs the compatibility projection internally instead of leaking
// the old PR DTO back into the observer/provider boundary.
func (m *Manager) ApplySCMObservation(ctx context.Context, id domain.SessionID, o ports.SCMObservation) error {
	if !o.Fetched {
		return nil
	}
	if err := m.ApplyPRObservation(ctx, id, scmToPRObservation(o)); err != nil {
		return err
	}
	intent, err := m.notificationIntentForCurrentSCM(ctx, id, o)
	if err != nil {
		return err
	}
	prURL := firstSCMNonEmpty(o.PR.URL, o.PR.HTMLURL)
	if intent == nil {
		// No notification this observation. If the PR is still open, forget any
		// persisted notify signature so a later transition back into a
		// notifiable state (e.g. CI red -> green on the same head) re-notifies
		// instead of being suppressed as an unchanged signature. Merged/closed
		// keep their signature so terminal posts stay deduped.
		if prURL != "" && !o.PR.Merged && !o.PR.Closed {
			return m.forgetNotificationSignature(ctx, prURL)
		}
		return nil
	}
	// A PR-derived notification is only actionable on a state transition. The
	// observer re-derives the same PR facts on every poll (and re-derives the
	// whole current fleet after a daemon restart), so emitting on every
	// observation floods the operator with duplicate ready_to_merge/pr_merged
	// posts (issue #190). Gate emission on a persisted per-PR signature —
	// (type, head SHA, sensitive-flag) — reusing the pr.last_nudge_signature
	// row so the dedup survives a restart, exactly like the agent-nudge lanes.
	return m.emitPRNotificationOnce(ctx, intent, scmNotificationHeadSHA(o))
}

// scmNotificationHeadSHA is the head commit the notification signature pins to.
// A new push (new head) is a real state change that must re-notify; a
// re-observation of the same head is not.
func scmNotificationHeadSHA(o ports.SCMObservation) string {
	return firstSCMNonEmpty(o.PR.HeadSHA, o.CI.HeadSHA)
}

// emitPRNotificationOnce emits the PR-derived notification only when its
// signature differs from the last one persisted for the PR, then records and
// persists the new signature under a dedicated "notify:<url>" key in
// pr.last_nudge_signature so the emit-once decision survives a daemon restart.
//
// The ordering is deliberate and fail-open: the emit happens while react.mu is
// held (so a concurrent observation cannot double-emit the same signature) and
// BEFORE the dedupe state is touched. The signature is recorded ONLY after the
// notification sink accepted the write — a failed emit leaves no dedupe entry,
// so the state is re-attempted on the next observation and after a restart
// instead of being permanently suppressed as delivered. A persist failure after
// a successful emit still surfaces upward; its worst case is one extra
// notification after a restart, matching the agent-nudge lanes.
func (m *Manager) emitPRNotificationOnce(ctx context.Context, intent *ports.NotificationIntent, headSHA string) error {
	if intent == nil {
		return nil
	}
	prURL := strings.TrimSpace(intent.PRURL)
	if prURL == "" {
		// No PR URL means no per-PR persistence row to dedupe against; every
		// such notification fires. (There are none today — every PR-derived
		// type carries a URL.)
		return m.emitNotificationErr(ctx, intent)
	}
	key := "notify:" + prURL
	sig := notificationSignature(intent, headSHA)

	m.react.mu.Lock()
	defer m.react.mu.Unlock()
	if !m.react.loaded[prURL] {
		if err := m.loadPRSignaturesLocked(ctx, prURL); err != nil {
			return err
		}
		m.react.loaded[prURL] = true
	}
	if m.react.seen[key] == sig {
		return nil
	}
	// Only record the signature once the sink actually accepted the write; a
	// failed emit must NOT be treated as delivered (it would suppress the real
	// notification forever, including after a restart).
	if err := m.emitNotificationErr(ctx, intent); err != nil {
		return err
	}
	m.react.seen[key] = sig
	return m.persistPRSignaturesLocked(ctx, prURL)
}

// forgetNotificationSignature drops the persisted notify-dedupe entry for a PR
// so the next notifiable transition re-fires. Called when an open PR is
// observed in a non-notifiable state (e.g. CI failing), which is itself a state
// change away from "ready" and must reset the emit-once gate.
func (m *Manager) forgetNotificationSignature(ctx context.Context, prURL string) error {
	key := "notify:" + prURL
	m.react.mu.Lock()
	defer m.react.mu.Unlock()
	if !m.react.loaded[prURL] {
		if err := m.loadPRSignaturesLocked(ctx, prURL); err != nil {
			return err
		}
		m.react.loaded[prURL] = true
	}
	prev, ok := m.react.seen[key]
	if !ok {
		return nil
	}
	delete(m.react.seen, key)
	// Keep the in-memory map consistent with the durable row: if the persist
	// fails, restore the entry so a later non-ready poll retries the durable
	// deletion instead of short-circuiting on a missing key (which would leave
	// the stale signature on disk to be reloaded after a restart and suppress a
	// legitimate return-to-ready).
	if err := m.persistPRSignaturesLocked(ctx, prURL); err != nil {
		m.react.seen[key] = prev
		return err
	}
	return nil
}

// notificationSignature fingerprints the operator-visible facts of a PR-derived
// notification: its type, the head commit it was derived from, and the
// sensitive-merge flag. Two notifications with the same signature describe the
// same state and must not re-notify.
func notificationSignature(intent *ports.NotificationIntent, headSHA string) string {
	return strings.Join([]string{
		string(intent.Type),
		headSHA,
		strconv.FormatBool(intent.Sensitive),
	}, "\x00")
}

func (m *Manager) notificationIntentForCurrentSCM(ctx context.Context, id domain.SessionID, o ports.SCMObservation) (*ports.NotificationIntent, error) {
	// Serialize the session snapshot with activity transitions so ready-to-merge
	// notifications do not race against a simultaneous waiting_input update.
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return m.notificationIntentForSCM(rec, o), nil
}

func (m *Manager) notificationIntentForSCM(rec domain.SessionRecord, o ports.SCMObservation) *ports.NotificationIntent {
	prURL := firstSCMNonEmpty(o.PR.URL, o.PR.HTMLURL)
	base := ports.NotificationIntent{
		SessionID:          rec.ID,
		ProjectID:          rec.ProjectID,
		PRURL:              prURL,
		CreatedAt:          timeOr(o.ObservedAt, m.clock()),
		SessionDisplayName: rec.DisplayName,
		PRNumber:           o.PR.Number,
		PRTitle:            o.PR.Title,
		PRSourceBranch:     o.PR.SourceBranch,
		PRTargetBranch:     o.PR.TargetBranch,
		Provider:           o.Provider,
		Repo:               o.Repo,
		ChangedPaths:       append([]string(nil), o.PR.ChangedPaths...),
		HeadSHA:            scmNotificationHeadSHA(o),
	}
	if o.PR.Merged {
		base.Type = domain.NotificationPRMerged
		return &base
	}
	if o.PR.Closed {
		base.Type = domain.NotificationPRClosedUnmerged
		return &base
	}
	if rec.IsTerminated || rec.Activity.State.NeedsInput() || !scmObservationIsReadyToMerge(o) {
		return nil
	}
	base.Type = domain.NotificationReadyToMerge
	base.Sensitive = touchesSensitiveMergePath(base.ChangedPaths)
	return &base
}

func touchesSensitiveMergePath(paths []string) bool {
	for _, p := range paths {
		p = strings.TrimLeft(strings.TrimSpace(p), "/")
		for _, prefix := range sensitiveMergePathPrefixes {
			if strings.HasPrefix(p, prefix) {
				return true
			}
		}
	}
	return false
}

func scmObservationIsReadyToMerge(o ports.SCMObservation) bool {
	if o.PR.Merged || o.PR.Closed || o.PR.Draft {
		return false
	}
	ci := domain.CIState(o.CI.Summary)
	if ci == "" {
		ci = domain.CIUnknown
	}
	switch ci {
	case domain.CIFailing, domain.CIPending, domain.CIUnknown:
		return false
	}
	if domain.ReviewDecision(o.Review.Decision) == domain.ReviewChangesRequest || hasUnresolvedSCMComments(o.Review.Threads) {
		return false
	}
	return domain.Mergeability(o.Mergeability.State) == domain.MergeMergeable
}

func hasUnresolvedSCMComments(threads []ports.SCMReviewThreadObservation) bool {
	for _, th := range threads {
		if th.Resolved || th.IsBot {
			continue
		}
		for _, c := range th.Comments {
			if !c.IsBot {
				return true
			}
		}
	}
	return false
}

func scmToPRObservation(o ports.SCMObservation) ports.PRObservation {
	pr := ports.PRObservation{
		Fetched:      o.Fetched,
		URL:          firstSCMNonEmpty(o.PR.URL, o.PR.HTMLURL),
		Number:       o.PR.Number,
		Draft:        o.PR.Draft,
		Merged:       o.PR.Merged,
		Closed:       o.PR.Closed,
		CI:           domain.CIState(o.CI.Summary),
		Review:       domain.ReviewDecision(o.Review.Decision),
		Mergeability: domain.Mergeability(o.Mergeability.State),
		ChangedPaths: append([]string(nil), o.PR.ChangedPaths...),
	}
	if pr.CI == "" {
		pr.CI = domain.CIUnknown
	}
	if pr.Review == "" {
		pr.Review = domain.ReviewNone
	}
	if pr.Mergeability == "" {
		pr.Mergeability = domain.MergeUnknown
	}
	checkCommit := firstSCMNonEmpty(o.CI.HeadSHA, o.PR.HeadSHA)
	for _, ch := range o.CI.FailedChecks {
		status := domain.PRCheckStatus(ch.Status)
		if status == "" {
			status = domain.PRCheckFailed
		}
		logTail := ch.LogTail
		if logTail == "" {
			logTail = o.CI.FailureLogTail
		}
		pr.Checks = append(pr.Checks, ports.PRCheckObservation{
			Name:       ch.Name,
			CommitHash: checkCommit,
			Status:     status,
			URL:        ch.URL,
			LogTail:    logTail,
		})
	}
	for _, th := range o.Review.Threads {
		if th.Resolved || th.IsBot {
			continue
		}
		for _, c := range th.Comments {
			if c.IsBot {
				continue
			}
			pr.Comments = append(pr.Comments, ports.PRCommentObservation{
				ID:       c.ID,
				Author:   c.Author,
				File:     th.Path,
				Line:     th.Line,
				Body:     c.Body,
				Resolved: th.Resolved,
			})
		}
	}
	return pr
}

// ApplyTrackerFacts reacts to a fetched Tracker issue observation. It owns the
// issue-driven side of session lifecycle and the initial bot-mention nudge;
// it does NOT persist tracker rows (the future Tracker observer in #35 owns
// the read-side persistence path).
//
// Reactions today:
//   - Issue terminal (state == done or cancelled) → MarkTerminated. The
//     reducer is idempotent — repeat observations on an already-terminated
//     session are no-ops because MarkTerminated skips when IsTerminated.
//   - Assignee changed → log only. No session-state reaction yet; the policy
//     for "assignee changed away from AO" is reserved for the write-side work
//     tracked by #40.
//   - New bot comment → one-time nudge using the same sendOnce + dedup
//     signature pattern as the SCM lane. Dedup is in-memory only for now;
//     cross-restart persistence lands with the Tracker observer (issue #35)
//     when issue-row signature storage is on the table.
func (m *Manager) ApplyTrackerFacts(ctx context.Context, id domain.SessionID, o ports.TrackerObservation) error {
	if !o.Fetched {
		return nil
	}
	if isTerminalTrackerState(o.Issue.State) {
		return m.MarkTerminated(ctx, id)
	}
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil || !ok {
		return err
	}
	if rec.IsTerminated || rec.Activity.State.NeedsInput() {
		return nil
	}
	if o.Changed.Assignee {
		slog.Default().Info("lifecycle: tracker issue assignee changed",
			"session", id, "issue", o.Issue.URL, "assignee", o.Issue.Assignee)
	}
	if o.Changed.Comments {
		bodies, ids := newBotCommentContent(o.Comments)
		if len(ids) > 0 {
			msg := "A bot left a new comment on your tracker issue. Address it and update the session."
			if joined := strings.Join(bodies, "\n\n"); strings.TrimSpace(joined) != "" {
				msg += "\n\n" + joined
			}
			// Empty prURL routes sendOnce through its in-memory-only branch:
			// the PR-row signature load/persist is skipped, so the dedup
			// survives only for the lifetime of this Manager. Cross-restart
			// persistence ships with #35.
			_, err := m.sendOnce(ctx, id, "", "tracker-bot:"+o.Issue.URL, strings.Join(ids, ","), msg, 0)
			return err
		}
	}
	return nil
}

func isTerminalTrackerState(state domain.NormalizedIssueState) bool {
	return state == domain.IssueDone || state == domain.IssueCancelled
}

func newBotCommentContent(comments []ports.TrackerCommentObservation) ([]string, []string) {
	bodies := make([]string, 0, len(comments))
	ids := make([]string, 0, len(comments))
	for _, c := range comments {
		if !c.IsBot {
			continue
		}
		// Both an ID and a body are required: ID anchors the dedup
		// signature (an empty ID collapses to "" which collides with
		// the zero value of m.react.seen[key] and silently suppresses
		// the nudge), and a body is what we actually need to surface
		// to the agent.
		if c.ID == "" || strings.TrimSpace(c.Body) == "" {
			continue
		}
		bodies = append(bodies, c.Body)
		ids = append(ids, c.ID)
	}
	return bodies, ids
}

func firstSCMNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func hasUnresolvedComments(comments []ports.PRCommentObservation) bool {
	for _, c := range comments {
		if !c.Resolved {
			return true
		}
	}
	return false
}

func reviewContent(comments []ports.PRCommentObservation) (string, string) {
	bodies := make([]string, 0, len(comments))
	ids := make([]string, 0, len(comments))
	for _, c := range comments {
		if c.Resolved {
			continue
		}
		// Comment bodies are attacker-influenced (anyone who can comment on the
		// PR) and get pasted into the agent's live pane; strip control/escape
		// chars. The signature is built from comment IDs, not bodies, so dedup is
		// unaffected.
		bodies = append(bodies, domain.SanitizeControlChars(c.Body))
		ids = append(ids, c.ID)
	}
	return strings.Join(bodies, "\n\n"), strings.Join(ids, ",")
}

func ciDedupeKey(prURL string, ch ports.PRCheckObservation, nameCount int) string {
	key := ch.Name
	if nameCount > 1 && ch.LogTail != "" {
		sum := sha256.Sum256([]byte(ch.LogTail))
		key += ":" + fmt.Sprintf("%x", sum[:8])
	}
	return "ci:" + prURL + ":" + key
}

// sendOnceOutcome tells a caller whether a nudge was sent, skipped by dedup or
// attempt budget, or suppressed by the just-in-time session guard.
type sendOnceOutcome int

const (
	// sendOnceNoop means a prior identical send is already recorded, the attempt
	// budget is spent, or no guard is configured. PR-observation callers use this
	// to fall through to other independent nudge lanes.
	sendOnceNoop sendOnceOutcome = iota
	// sendOnceSent means the message reached the session pane.
	sendOnceSent
	// sendOnceSuppressed means the just-in-time guard skipped the paste because the
	// session is terminated or awaiting the user (blocked/waiting_input). The
	// message did NOT reach the worker; the caller must not mark it delivered so
	// it re-fires on the next observation once the session is workable again.
	sendOnceSuppressed
)

func (m *Manager) sendOnce(ctx context.Context, id domain.SessionID, prURL, key, sig, msg string, maxAttempts int) (sendOnceOutcome, error) {
	if m.guard == nil {
		return sendOnceNoop, nil
	}
	m.react.mu.Lock()
	defer m.react.mu.Unlock()

	if prURL != "" && !m.react.loaded[prURL] {
		if err := m.loadPRSignaturesLocked(ctx, prURL); err != nil {
			return sendOnceNoop, err
		}
		m.react.loaded[prURL] = true
	}

	if m.react.seen[key] == sig {
		return sendOnceNoop, nil
	}
	attempts := m.react.attempts[key]
	if maxAttempts > 0 && attempts >= maxAttempts {
		return sendOnceNoop, nil
	}
	// The guard re-reads the session immediately before pasting: the caller's
	// NeedsInput() entry check ran before this function's dedup/persist I/O, so
	// a permission hook could have stored blocked (or the session could have
	// terminated) in the meantime. A suppressed write returns SUPPRESSED (not
	// accounted), so a review caller won't stamp it delivered and it re-fires
	// once the session is workable again. A store failure inside the guard also
	// suppresses (fail closed, nothing was written); a messenger failure means
	// the write was attempted and stays accounted, matching the pre-guard
	// behavior.
	outcome, err := m.guard.Nudge(ctx, id, msg)
	if err != nil {
		if outcome != sessionguard.Sent {
			return sendOnceSuppressed, err
		}
		return sendOnceSent, err
	}
	if outcome != sessionguard.Sent {
		return sendOnceSuppressed, nil
	}
	// Order: Send → in-memory mutation → durable persist. Sending first means a
	// transient persist failure does NOT swallow a real send (the agent saw the
	// message; subsequent polls in this process suppress re-sends via the
	// in-memory dedup). A persist failure that survives until a daemon restart
	// degrades to one extra nudge — preferred over the inverse (persist before
	// send, then crash mid-call) which would silently lose a real nudge.
	m.react.seen[key] = sig
	m.react.attempts[key] = attempts + 1
	if prURL != "" {
		if err := m.persistPRSignaturesLocked(ctx, prURL); err != nil {
			return sendOnceSent, err
		}
	}
	return sendOnceSent, nil
}

// loadPRSignaturesLocked merges any previously persisted reaction-dedup state
// for prURL into the in-memory maps. Caller must hold m.react.mu.
func (m *Manager) loadPRSignaturesLocked(ctx context.Context, prURL string) error {
	raw, err := m.store.GetPRLastNudgeSignature(ctx, prURL)
	if err != nil {
		return err
	}
	if raw == "" {
		return nil
	}
	// A corrupt persisted payload must not crash the lifecycle write path;
	// the worst case from a swallow is re-firing a nudge once.
	var p reactionPayload
	_ = json.Unmarshal([]byte(raw), &p)
	for k, v := range p.Seen {
		if _, ok := m.react.seen[k]; !ok {
			m.react.seen[k] = v
		}
	}
	for k, v := range p.Attempts {
		if cur, ok := m.react.attempts[k]; !ok || v > cur {
			m.react.attempts[k] = v
		}
	}
	return nil
}

// persistPRSignaturesLocked serialises every reaction-dedup entry whose key
// references prURL and writes the JSON payload back via the store. Caller must
// hold m.react.mu. A failed persist surfaces upward so the in-memory mutation
// (which the messenger already acted on) is not silently divergent from disk.
func (m *Manager) persistPRSignaturesLocked(ctx context.Context, prURL string) error {
	payload := reactionPayload{Seen: map[string]string{}, Attempts: map[string]int{}}
	for k, v := range m.react.seen {
		if reactionKeyTargetsPR(k, prURL) {
			payload.Seen[k] = v
		}
	}
	for k, v := range m.react.attempts {
		if reactionKeyTargetsPR(k, prURL) {
			payload.Attempts[k] = v
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return m.store.UpdatePRLastNudgeSignature(ctx, prURL, string(raw))
}

// reactionKeyTargetsPR matches the "<type>:<url>[:<extra>]" reaction keys used
// by ApplyPRObservation. Anchoring on the second colon-delimited segment keeps
// PR-specific keys grouped with the row that survives a restart.
func reactionKeyTargetsPR(key, prURL string) bool {
	if prURL == "" {
		return false
	}
	parts := strings.SplitN(key, ":", 2)
	if len(parts) != 2 {
		return false
	}
	rest := parts[1]
	return rest == prURL || strings.HasPrefix(rest, prURL+":")
}

// HandleDuplicatePR reacts to a detected duplicate PR (issue #181): it posts a
// best-effort auto-comment on the newer/duplicate PR naming the pre-existing
// one, and emits a loud duplicate_pr notification (Slack-forwarded) against the
// duplicate PR's session.
//
// The two effects are independently idempotent. Each has its own persisted
// per-PR signature (reusing pr.last_nudge_signature, keyed "dup-comment:<dupURL>"
// and "dup-notify:<dupURL>", fingerprinted by the existing PR URL), so a failure
// of one never suppresses or repeats the other, and a re-observation across polls
// or a daemon restart does not re-fire a settled effect. External I/O (the GitHub
// comment and the notification write) runs WITHOUT the reaction mutex held, then
// only the effects that actually succeeded are settled and persisted under the
// lock — a failed effect stays unsettled and retries on the next poll.
func (m *Manager) HandleDuplicatePR(ctx context.Context, fact ports.DuplicatePRFact) error {
	dupURL := strings.TrimSpace(fact.DupPRURL)
	existingURL := strings.TrimSpace(fact.ExistingPRURL)
	if dupURL == "" || existingURL == "" || dupURL == existingURL {
		return nil
	}
	const commentKeyPrefix, notifyKeyPrefix = "dup-comment:", "dup-notify:"
	commentKey := commentKeyPrefix + dupURL
	notifyKey := notifyKeyPrefix + dupURL
	sig := existingURL

	// Phase 1: read persisted dedup state under the lock and RESERVE the effects
	// this call will run. Reservation makes the "is it due?" check and the intent
	// to run it atomic, so two concurrent reactions for the same key can't both
	// slip past the check and each fire the effect while the lock is released for
	// I/O.
	m.react.mu.Lock()
	if !m.react.loaded[dupURL] {
		if err := m.loadPRSignaturesLocked(ctx, dupURL); err != nil {
			m.react.mu.Unlock()
			return err
		}
		m.react.loaded[dupURL] = true
	}
	// Treat ANY existing reservation as occupied (not just one matching sig): a
	// concurrent holder — even one reserving a different, e.g. newer, signature —
	// owns the effect until it releases, so we must not overwrite its reservation
	// and race to settle a stale signature. The holder clears its reservation in
	// phase 3; the next poll re-evaluates against the freshest signature.
	_, commentReserved := m.react.inflight[commentKey]
	_, notifyReserved := m.react.inflight[notifyKey]
	needComment := m.commenter != nil && m.react.seen[commentKey] != sig && !commentReserved
	needNotify := m.react.seen[notifyKey] != sig && !notifyReserved
	if needComment {
		m.react.inflight[commentKey] = sig
	}
	if needNotify {
		m.react.inflight[notifyKey] = sig
	}
	m.react.mu.Unlock()
	if !needComment && !needNotify {
		return nil
	}

	// Phase 2: external I/O without the reaction mutex, so a slow GitHub/store
	// call never blocks the other lifecycle reaction lanes sharing that lock.
	commentDone := false
	if needComment {
		if err := m.commenter.PostIssueComment(ctx, dupURL, duplicatePRComment(fact)); err != nil {
			slog.Default().Warn("lifecycle: duplicate PR auto-comment failed", "dup_pr", dupURL, "existing_pr", existingURL, "err", err)
		} else {
			commentDone = true
		}
	}
	notifyDone := false
	if needNotify {
		intent := ports.NotificationIntent{
			Type:               domain.NotificationDuplicatePR,
			SessionID:          fact.DupSessionID,
			ProjectID:          fact.ProjectID,
			PRURL:              dupURL,
			SessionDisplayName: fact.DupSessionDisplay,
			PRNumber:           fact.DupPRNumber,
			PRTitle:            fact.DupPRTitle,
			Provider:           fact.Provider,
			Repo:               fact.Repo,
			IssueRef:           fact.IssueRef,
			DuplicateOfPRURL:   existingURL,
		}
		if m.notifications == nil {
			// No sink wired: treat as delivered so we don't spin retrying an
			// effect that can never run in this deployment.
			notifyDone = true
		} else if err := m.notifications.Notify(ctx, intent); err != nil {
			slog.Default().Warn("lifecycle: duplicate PR notification failed", "dup_pr", dupURL, "existing_pr", existingURL, "err", err)
		} else {
			notifyDone = true
		}
	}

	// Phase 3: release the reservations, settle only the effects that succeeded,
	// then persist once. The in-memory settle and the durable write happen
	// together under the lock; a persist failure restores each signature's PRIOR
	// value (not a blind delete) so a signature another caller settled meanwhile
	// is preserved. A restart and this process then agree the effect is still due
	// (at worst one extra attempt: the notification store dedups it and a repeat
	// comment is harmless).
	m.react.mu.Lock()
	defer m.react.mu.Unlock()
	if needComment && m.react.inflight[commentKey] == sig {
		delete(m.react.inflight, commentKey)
	}
	if needNotify && m.react.inflight[notifyKey] == sig {
		delete(m.react.inflight, notifyKey)
	}
	if !commentDone && !notifyDone {
		return nil
	}
	priorComment, hadComment := m.react.seen[commentKey]
	priorNotify, hadNotify := m.react.seen[notifyKey]
	if commentDone {
		m.react.seen[commentKey] = sig
	}
	if notifyDone {
		m.react.seen[notifyKey] = sig
	}
	if err := m.persistPRSignaturesLocked(ctx, dupURL); err != nil {
		if commentDone {
			restoreSignature(m.react.seen, commentKey, priorComment, hadComment)
		}
		if notifyDone {
			restoreSignature(m.react.seen, notifyKey, priorNotify, hadNotify)
		}
		return err
	}
	return nil
}

// restoreSignature reverts a dedup key to its prior value after a failed persist:
// it re-sets the earlier signature when one existed, or deletes the key when it
// was previously absent. A blind delete would drop a signature that a concurrent
// caller had already settled.
func restoreSignature(m map[string]string, key, prior string, had bool) {
	if had {
		m[key] = prior
		return
	}
	delete(m, key)
}

// duplicatePRComment is the body auto-posted on the newer duplicate PR. It names
// the pre-existing open PR and the shared issue so a reader (human or a resumed/
// compacted worker) can adopt the existing PR instead of continuing the dup.
func duplicatePRComment(fact ports.DuplicatePRFact) string {
	existing := strings.TrimSpace(fact.ExistingPRURL)
	if n := fact.ExistingPRNumber; n > 0 {
		existing = fmt.Sprintf("#%d (%s)", n, existing)
	}
	issue := strings.TrimSpace(fact.IssueRef)
	var b strings.Builder
	b.WriteString("⚠️ Duplicate PR detected by agent-orchestrator.\n\n")
	if issue != "" {
		fmt.Fprintf(&b, "This pull request targets issue %s, which already has an open PR: %s.\n\n", domain.SanitizeControlChars(issue), domain.SanitizeControlChars(existing))
	} else {
		fmt.Fprintf(&b, "The issue this pull request targets already has an open PR: %s.\n\n", domain.SanitizeControlChars(existing))
	}
	b.WriteString("One issue should have one open PR. Close or adopt the existing PR (push to its branch) rather than continuing here, unless this is an intentional stacked PR.")
	return b.String()
}
