// Package trackerintake implements the opt-in issue-intake observer. It polls a
// project's configured tracker for eligible issues and starts one worker session
// per issue, leaving PR/lifecycle handling to the existing observers.
package trackerintake

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// DefaultTickInterval is intentionally slower than runtime liveness checks:
	// intake is a backlog sweep, not an interactive status surface.
	DefaultTickInterval = time.Minute
	// DefaultFailureBackoff suppresses repeated polls for a project after an
	// intake failure. The observer retries automatically after this window.
	DefaultFailureBackoff = 5 * time.Minute
	// maxIntakePromptLen mirrors the session HTTP prompt limit. Intake uses the
	// session service directly, so it must enforce the same boundary itself.
	maxIntakePromptLen = 4096

	intakePromptTruncationNotice = "\n\n[Issue content truncated to fit the session prompt limit. Open the linked issue for the full details.]\n"
	intakePromptFooter           = "\nImplement the requested change in this repository, run the relevant checks, and open or update a pull request when ready."
)

// Store is the durable read surface the observer needs.
type Store interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

// Spawner is the session creation surface used by intake.
type Spawner interface {
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, error)
}

// TrackerResolver picks the tracker adapter for a project's configured
// provider.
type TrackerResolver interface {
	Resolve(provider domain.TrackerProvider) (ports.Tracker, error)
}

// SingleTrackerResolver returns the same tracker for one specific provider and
// refuses every other provider. It exists so single-provider deployments don't
// need to construct a map.
type SingleTrackerResolver struct {
	Provider domain.TrackerProvider
	Adapter  ports.Tracker
}

// Resolve returns the wrapped adapter when the requested provider matches, or
// when the resolver was constructed without a provider pin.
func (s SingleTrackerResolver) Resolve(provider domain.TrackerProvider) (ports.Tracker, error) {
	if s.Adapter == nil {
		return nil, fmt.Errorf("tracker intake: no adapter for provider %q", provider)
	}
	if s.Provider == "" || provider == "" || provider == s.Provider {
		return s.Adapter, nil
	}
	return nil, fmt.Errorf("tracker intake: no adapter for provider %q", provider)
}

// Config holds optional observer knobs. Zero values use production defaults.
type Config struct {
	Tick           time.Duration
	FailureBackoff time.Duration
	Clock          func() time.Time
	Logger         *slog.Logger
}

// Observer polls configured projects and starts sessions for eligible issues.
type Observer struct {
	resolver       TrackerResolver
	store          Store
	spawner        Spawner
	tick           time.Duration
	failureBackoff time.Duration
	clock          func() time.Time
	logger         *slog.Logger
	backoffUntil   map[string]time.Time
}

// New constructs an Observer with safe defaults.
func New(resolver TrackerResolver, store Store, spawner Spawner, cfg Config) *Observer {
	o := &Observer{resolver: resolver, store: store, spawner: spawner, tick: cfg.Tick, failureBackoff: cfg.FailureBackoff, clock: cfg.Clock, logger: cfg.Logger, backoffUntil: map[string]time.Time{}}
	if o.tick <= 0 {
		o.tick = DefaultTickInterval
	}
	if o.failureBackoff <= 0 {
		o.failureBackoff = DefaultFailureBackoff
	}
	if o.clock == nil {
		o.clock = time.Now
	}
	if o.logger == nil {
		o.logger = slog.Default()
	}
	return o
}

// Start launches the observer loop. The first poll runs immediately inside the
// goroutine, keeping daemon startup non-blocking.
func (o *Observer) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, o.tick, o.Poll, o.logger, "tracker intake")
}

// Poll runs one synchronous intake pass. Store discovery failures are returned
// because they prevent the pass from knowing the current world; provider and
// spawn failures are logged and skipped so one bad issue/project does not block
// the rest of the daemon.
func (o *Observer) Poll(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if o.resolver == nil || o.store == nil || o.spawner == nil {
		return nil
	}
	now := o.clock().UTC()
	projects, err := o.store.ListProjects(ctx)
	if err != nil {
		return err
	}
	enabledProjects := make([]domain.ProjectRecord, 0, len(projects))
	for _, project := range projects {
		if project.Config.TrackerIntake.Enabled {
			enabledProjects = append(enabledProjects, project)
		}
	}
	if len(enabledProjects) == 0 {
		return nil
	}
	sessions, err := o.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}
	seen := seenIssueIDs(sessions)
	liveByProject := liveWorkersByProject(sessions)
	runningByProject := runningWorkerBucketsByProject(sessions)
	for _, project := range enabledProjects {
		if err := ctx.Err(); err != nil {
			return err
		}
		if until, ok := o.backoffUntil[project.ID]; ok && now.Before(until) {
			o.logger.Debug("tracker intake: project in failure backoff", "project", project.ID, "until", until)
			continue
		}
		if failed := o.pollProject(ctx, project, seen, liveByProject[project.ID], runningByProject[project.ID]); failed {
			o.backoffUntil[project.ID] = now.Add(o.failureBackoff)
		} else {
			delete(o.backoffUntil, project.ID)
		}
	}
	return nil
}

// pollProject returns failed=true for conditions that should be retried after a
// backoff window rather than logged on every poll.
func (o *Observer) pollProject(ctx context.Context, project domain.ProjectRecord, seen map[domain.IssueID]bool, liveWorkers int, running map[domain.BucketKey]int) (failed bool) {
	cfg := project.Config.TrackerIntake.WithDefaults()
	if !cfg.Enabled {
		return false
	}
	if err := cfg.Validate(); err != nil {
		o.logger.Warn("tracker intake: skipping project with invalid config", "project", project.ID, "err", err)
		return true
	}
	if cfg.MaxConcurrent > 0 && liveWorkers >= cfg.MaxConcurrent {
		o.logger.Debug("tracker intake: project at concurrency cap, deferring", "project", project.ID, "live", liveWorkers, "cap", cfg.MaxConcurrent)
		return false
	}
	repo, ok := trackerRepo(project, cfg)
	if !ok {
		o.logger.Warn("tracker intake: skipping project without tracker scope", "project", project.ID, "provider", cfg.Provider, "origin", project.RepoOriginURL)
		return true
	}
	tracker, err := o.resolver.Resolve(cfg.Provider)
	if err != nil {
		o.logger.Warn("tracker intake: no adapter for provider", "project", project.ID, "provider", cfg.Provider, "err", err)
		return true
	}
	issues, err := tracker.List(ctx, repo, domain.ListFilter{
		State:    domain.ListOpen,
		Assignee: cfg.Assignee,
	})
	if err != nil {
		o.logger.Error("tracker intake: list issues failed", "project", project.ID, "repo", repo.Native, "err", err)
		return true
	}
	// A configured worker mix distributes intake spawns across weighted
	// agent/model buckets exactly like an orchestrator-driven spawn (#62): each
	// pick is deficit-based against the running fleet so the realized harness/
	// model distribution converges on the target ratio. Selecting the harness
	// here (rather than leaving it to the session manager) keeps intake's choice
	// observable and lets convergence account for the sessions spawned earlier in
	// this same pass. Passing an explicit harness also short-circuits the
	// manager's own mix block, so the two never double-select. Provider-matched
	// models and the never-fable-by-default guard (#61/#66) still resolve in the
	// manager from the selected harness. An empty mix leaves harness/model unset
	// so back-compat single-default behavior is unchanged.
	mix := project.Config.WorkerMix
	if len(mix) > 0 && running == nil {
		running = make(map[domain.BucketKey]int)
	}
	spawnedThisPass := 0
	var spawnFailed bool
	for _, issue := range issues {
		if ctx.Err() != nil {
			return true
		}
		if cfg.MaxConcurrent > 0 && liveWorkers+spawnedThisPass >= cfg.MaxConcurrent {
			o.logger.Debug("tracker intake: reached concurrency cap mid-pass, deferring remaining issues", "project", project.ID, "cap", cfg.MaxConcurrent)
			break
		}
		if issue.State != domain.IssueOpen {
			continue
		}
		if !issueMatchesConfig(issue, cfg) {
			continue
		}
		issueID := CanonicalIssueID(issue.ID)
		if issueID == "" || seen[issueID] {
			continue
		}
		spawnCfg := ports.SpawnConfig{
			ProjectID: domain.ProjectID(project.ID),
			IssueID:   issueID,
			Kind:      domain.KindWorker,
			Prompt:    BuildIssuePrompt(issue),
		}
		var pickKey domain.BucketKey
		havePick := false
		if len(mix) > 0 {
			if pick, ok := mix.Select(running); ok {
				spawnCfg.Harness = pick.Harness
				spawnCfg.Model = pick.Model
				pickKey = domain.BucketKey{Harness: pick.Harness, Model: strings.TrimSpace(pick.Model)}
				havePick = true
			}
		}
		if _, err := o.spawner.Spawn(ctx, spawnCfg); err != nil {
			if isWorkerConcurrencyCap(err) {
				o.logger.Debug("tracker intake: spawn reached concurrency cap, deferring remaining issues", "project", project.ID, "issue", issueID, "err", err)
				break
			}
			o.logger.Error("tracker intake: spawn issue session failed", "project", project.ID, "issue", issueID, "err", err)
			spawnFailed = true
			continue
		}
		if havePick {
			// Only a spawned (persisted) session shifts the running distribution,
			// so a failed spawn must not consume the bucket it would have used.
			running[pickKey]++
		}
		seen[issueID] = true
		spawnedThisPass++
	}
	return spawnFailed
}

func isWorkerConcurrencyCap(err error) bool {
	var apiError *apierr.Error
	return errors.As(err, &apiError) && apiError.Code == "WORKER_CONCURRENCY_CAP"
}

func issueMatchesConfig(issue domain.Issue, cfg domain.TrackerIntakeConfig) bool {
	if !issueMatchesLabels(issue, cfg) {
		return false
	}
	assignee := strings.TrimSpace(cfg.Assignee)
	switch {
	case assignee == "":
		return true
	case assignee == "*":
		return len(issue.Assignees) > 0
	case strings.EqualFold(assignee, "none"):
		return len(issue.Assignees) == 0
	default:
		return containsFold(issue.Assignees, assignee)
	}
}

// issueMatchesLabels applies the include/exclude label rules. Exclusion wins: an
// issue carrying any excluded label is rejected even if it also carries an
// included one. An empty include list imposes no positive requirement.
func issueMatchesLabels(issue domain.Issue, cfg domain.TrackerIntakeConfig) bool {
	for _, excluded := range cfg.ExcludeLabels {
		if issueHasExcludedLabel(issue.Labels, strings.TrimSpace(excluded)) {
			return false
		}
	}
	if len(cfg.Labels) == 0 {
		return true
	}
	for _, required := range cfg.Labels {
		if containsFold(issue.Labels, strings.TrimSpace(required)) {
			return true
		}
	}
	return false
}

// issueHasExcludedLabel reports whether any of the issue's labels is opted out by
// the excluded entry. An entry matches a label exactly (case-insensitive) OR as a
// scoped-label prefix: entry "charter" excludes both "charter" and the whole
// "charter:*" family (e.g. "charter:C03"), so charter sub-labels never need
// enumerating (issue #80). The ":" boundary is required — "charter" does not
// match "chartering". An empty entry matches nothing.
func issueHasExcludedLabel(labels []string, excluded string) bool {
	if excluded == "" {
		return false
	}
	// The scope boundary is the excluded text followed by ":", so excluding
	// "charter" catches "charter:C03" but not "chartering", and multi-segment
	// entries keep their full scope ("agent:noauto" still catches
	// "agent:noauto:beta"). foldHasPrefix folds identically to the EqualFold
	// exact match above, so both case-insensitive paths agree.
	prefix := excluded + ":"
	for _, label := range labels {
		label = strings.TrimSpace(label)
		if strings.EqualFold(label, excluded) {
			return true
		}
		if foldHasPrefix(label, prefix) {
			return true
		}
	}
	return false
}

// foldHasPrefix reports whether s begins with prefix under Unicode case folding.
// It walks rune-by-rune (never slicing mid-rune) and folds via strings.EqualFold,
// so a scoped-prefix match is case-insensitive the same way the exact-label match
// is — the two paths can't disagree on non-ASCII simple-fold pairs.
func foldHasPrefix(s, prefix string) bool {
	for _, pr := range prefix {
		if s == "" {
			return false
		}
		sr, size := utf8.DecodeRuneInString(s)
		if sr != pr && !strings.EqualFold(string(sr), string(pr)) {
			return false
		}
		s = s[size:]
	}
	return true
}

func containsFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), needle) {
			return true
		}
	}
	return false
}

func seenIssueIDs(sessions []domain.SessionRecord) map[domain.IssueID]bool {
	seen := make(map[domain.IssueID]bool, len(sessions))
	for _, sess := range sessions {
		if sess.IssueID != "" {
			seen[sess.IssueID] = true
		}
	}
	return seen
}

// liveWorkersByProject counts live (non-terminated) worker sessions per project.
// The count feeds the per-project MaxConcurrent cap shared by intake and manual
// spawns, so a bulk assignment burst or repeated CLI spawn cannot exceed the
// configured worker pool size.
func liveWorkersByProject(sessions []domain.SessionRecord) map[string]int {
	counts := make(map[string]int)
	for _, sess := range sessions {
		if sess.IsTerminated {
			continue
		}
		if sess.Kind != domain.KindWorker {
			continue
		}
		counts[string(sess.ProjectID)]++
	}
	return counts
}

// runningWorkerBucketsByProject tallies live (non-terminated) worker sessions
// per project by agent/model bucket — the running distribution the worker-mix
// selector balances against. It mirrors the session manager's own
// runningWorkerBuckets exactly: only worker sessions, terminated rows excluded,
// and a bucket keyed by harness plus the trimmed model recorded at spawn, so an
// intake pick and the session it persists land in the same bucket. Unlike the
// concurrency-cap tally it counts every worker (not just canonical intake ids):
// the mix balances the whole fleet, so an orchestrator-spawned worker still
// biases intake's next pick toward the under-served buckets.
func runningWorkerBucketsByProject(sessions []domain.SessionRecord) map[string]map[domain.BucketKey]int {
	byProject := make(map[string]map[domain.BucketKey]int)
	for _, sess := range sessions {
		if sess.IsTerminated || sess.Kind != domain.KindWorker {
			continue
		}
		buckets := byProject[string(sess.ProjectID)]
		if buckets == nil {
			buckets = make(map[domain.BucketKey]int)
			byProject[string(sess.ProjectID)] = buckets
		}
		buckets[domain.BucketKey{Harness: sess.Harness, Model: strings.TrimSpace(sess.Metadata.Model)}]++
	}
	return byProject
}

// CanonicalIssueID stores tracker issue ids in sessions.issue_id with the
// provider included, so future providers cannot collide on native ids.
func CanonicalIssueID(id domain.TrackerID) domain.IssueID {
	provider := id.Provider
	if provider == "" {
		provider = domain.TrackerProviderGitHub
	}
	native := strings.TrimSpace(id.Native)
	if native == "" {
		return ""
	}
	return domain.IssueID(string(provider) + ":" + native)
}

// BuildIssuePrompt turns normalized issue facts into the worker's initial task.
func BuildIssuePrompt(issue domain.Issue) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Work on tracker issue %s.\n\n", CanonicalIssueID(issue.ID))
	if issue.Title != "" {
		fmt.Fprintf(&b, "Title: %s\n", issue.Title)
	}
	if issue.URL != "" {
		fmt.Fprintf(&b, "URL: %s\n", issue.URL)
	}
	if len(issue.Labels) > 0 {
		fmt.Fprintf(&b, "Labels: %s\n", strings.Join(issue.Labels, ", "))
	}
	if len(issue.Assignees) > 0 {
		fmt.Fprintf(&b, "Assignees: %s\n", strings.Join(issue.Assignees, ", "))
	}
	body := strings.TrimSpace(issue.Body)
	if body != "" {
		fmt.Fprintf(&b, "\nBody:\n%s\n", body)
	}
	b.WriteString(intakePromptFooter)
	return capIntakePrompt(b.String())
}

func capIntakePrompt(prompt string) string {
	if len(prompt) <= maxIntakePromptLen {
		return prompt
	}
	prefix := strings.TrimSuffix(prompt, intakePromptFooter)
	prefixBudget := maxIntakePromptLen - len(intakePromptTruncationNotice) - len(intakePromptFooter)
	if prefixBudget <= 0 {
		return truncateUTF8(prompt, maxIntakePromptLen)
	}
	return truncateUTF8(prefix, prefixBudget) + intakePromptTruncationNotice + intakePromptFooter
}

func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := 0
	for i := range s {
		if i > maxBytes {
			break
		}
		cut = i
	}
	return s[:cut]
}

func trackerRepo(project domain.ProjectRecord, cfg domain.TrackerIntakeConfig) (domain.TrackerRepo, bool) {
	provider := cfg.Provider
	if provider == "" {
		provider = domain.TrackerProviderGitHub
	}
	if provider != domain.TrackerProviderGitHub {
		return domain.TrackerRepo{}, false
	}
	native := strings.TrimSpace(cfg.Repo)
	if native == "" {
		native = parseGitHubRepoNative(project.RepoOriginURL)
	}
	if native == "" {
		return domain.TrackerRepo{}, false
	}
	return domain.TrackerRepo{Provider: provider, Native: native}, true
}

func parseGitHubRepoNative(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	if strings.HasPrefix(remote, "git@") {
		if _, rest, ok := strings.Cut(remote, ":"); ok {
			return cleanRepoPath(rest)
		}
	}
	if u, err := url.Parse(remote); err == nil && u.Host != "" {
		host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")
		if host == "github.com" || strings.HasSuffix(host, ".github.com") || strings.HasSuffix(host, ".ghe.io") {
			return cleanRepoPath(u.Path)
		}
		return ""
	}
	return cleanRepoPath(remote)
}

func cleanRepoPath(path string) string {
	path = strings.Trim(strings.TrimSpace(path), "/")
	path = strings.TrimSuffix(path, ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return ""
	}
	owner := strings.TrimSpace(parts[len(parts)-2])
	repo := strings.TrimSpace(parts[len(parts)-1])
	if owner == "" || repo == "" {
		return ""
	}
	return owner + "/" + repo
}
