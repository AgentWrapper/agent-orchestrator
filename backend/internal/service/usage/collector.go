package usage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	maxUsageMetadataBytes = 256
	maxUsagePathBytes     = 4096
	defaultDiscoveryLimit = 64
)

var nativeUsageIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// HookSignal is the usage-specific metadata carried by an AO agent hook.
type HookSignal struct {
	Harness                domain.AgentHarness
	Event                  string
	LaunchID               string
	NativeSessionID        string
	ModelID                string
	TranscriptPath         string
	SubagentID             string
	SubagentTranscriptPath string
}

// SourceRoots are the provider-owned directories from which AO may read usage
// transcripts.
type SourceRoots struct {
	ClaudeProjects string
	CodexSessions  string
	CodexArchived  string
}

// DefaultSourceRoots resolves the native Claude Code and Codex transcript
// directories for the current user.
func DefaultSourceRoots() (SourceRoots, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return SourceRoots{}, fmt.Errorf("resolve home directory: %w", err)
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	return SourceRoots{
		ClaudeProjects: filepath.Join(home, ".claude", "projects"),
		CodexSessions:  filepath.Join(codexHome, "sessions"),
		CodexArchived:  filepath.Join(codexHome, "archived_sessions"),
	}, nil
}

type collectorStore interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListAllSessions(context.Context) ([]domain.SessionRecord, error)
	UpsertUsageBinding(context.Context, domain.UsageBindingRecord) (domain.UsageBindingRecord, error)
	GetUsageBinding(context.Context, domain.SessionID, domain.AgentHarness, string) (domain.UsageBindingRecord, bool, error)
	ListUsageBindingsForSession(context.Context, domain.SessionID) ([]domain.UsageBindingRecord, error)
	ListUsageDiscoveryBindings(context.Context, int64) ([]domain.UsageBindingRecord, error)
	UpdateUsageBindingState(context.Context, int64, domain.UsageBindingState, string, time.Time) (bool, error)
	UpdateUsageBindingErrorCode(context.Context, int64, string, time.Time) (bool, error)
	CompleteUsageBindingIfSettled(context.Context, int64, time.Time) (bool, error)
	InsertUsageSource(context.Context, domain.UsageSourceRecord) (domain.UsageSourceRecord, error)
	ListUsageSourcesForBinding(context.Context, int64) ([]domain.UsageSourceRecord, error)
	MarkUsageSourceState(context.Context, int64, domain.UsageSourceState, string, *time.Time, time.Time) (bool, error)
	ReactivateUsageSource(context.Context, int64, time.Time) (bool, error)
}

// Collector registers provider transcript files and coordinates their source
// lifecycle. Parsing and cursor advancement remain in the usage ingestor.
type Collector struct {
	store                collectorStore
	roots                SourceRoots
	notifySourcesChanged func(reconcile bool)
	now                  func() time.Time
	mu                   sync.Mutex
}

// NewCollector constructs a transcript source registrar.
func NewCollector(store collectorStore, roots SourceRoots, notifySourcesChanged func(reconcile bool)) *Collector {
	return &Collector{
		store:                store,
		roots:                roots,
		notifySourcesChanged: notifySourcesChanged,
		now:                  time.Now,
	}
}

// FinalizeSession moves every known native binding into finalization and asks
// the ingestion pipeline to collect a stable final cursor. It is idempotent and
// safe to call before a session is marked terminated.
func (c *Collector) FinalizeSession(ctx context.Context, sessionID domain.SessionID) error {
	return c.RecordHook(ctx, sessionID, HookSignal{Event: "process-exited"})
}

// RecordHook registers transcript metadata and updates collection lifecycle for
// one native hook callback.
func (c *Collector) RecordHook(ctx context.Context, sessionID domain.SessionID, signal HookSignal) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	session, ok, err := c.store.GetSession(ctx, sessionID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("usage session %s not found", sessionID)
	}
	if !SupportedHarness(session.Harness) {
		return nil
	}
	signal.LaunchID = boundedUsageMetadata(signal.LaunchID)
	if signal.LaunchID != "" &&
		session.Metadata.RuntimeLaunchID != "" &&
		signal.LaunchID != session.Metadata.RuntimeLaunchID {
		return nil
	}
	if signal.Harness != "" && signal.Harness != session.Harness {
		return fmt.Errorf("usage hook harness %s does not match session harness %s", signal.Harness, session.Harness)
	}
	signal.Harness = session.Harness
	signal.NativeSessionID = boundedUsageMetadata(signal.NativeSessionID)
	if signal.NativeSessionID == "" {
		signal.NativeSessionID = boundedUsageMetadata(session.Metadata.AgentSessionID)
	}
	if signal.NativeSessionID == "" {
		signal.NativeSessionID = nativeIDFromTranscript(signal.TranscriptPath)
	}

	now := c.now().UTC()
	if signal.Event == "session-end" || signal.Event == "process-exited" {
		if err := c.finalizeSession(ctx, sessionID, now); err != nil {
			return err
		}
	}
	if signal.NativeSessionID == "" {
		c.notifySourceInventory(!finalizingEvent(signal.Event))
		return nil
	}

	finalizing := finalizingEvent(signal.Event)
	existing, exists, err := c.store.GetUsageBinding(ctx, sessionID, session.Harness, signal.NativeSessionID)
	if err != nil {
		return err
	}
	state := domain.UsageBindingActive
	if exists {
		state = existing.State
	}
	switch {
	case finalizing:
		state = domain.UsageBindingFinalizing
	case signal.Event == "session-start":
		state = domain.UsageBindingActive
	case exists && (state == domain.UsageBindingComplete || state == domain.UsageBindingPartial) &&
		signal.Event == "subagent-stop":
		state = domain.UsageBindingFinalizing
	}
	inventoryChanged := !exists || state != existing.State
	needsReconcile := false
	lastErrorCode := ""
	if session.Harness == domain.HarnessCodex && strings.TrimSpace(signal.TranscriptPath) == "" {
		lastErrorCode = domain.UsageErrorSourceDiscoveryPending
	}
	binding, err := c.store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:      sessionID,
		Harness:        session.Harness,
		NativeRootID:   signal.NativeSessionID,
		InitialModelID: boundedUsageMetadata(signal.ModelID),
		State:          state,
		LastErrorCode:  lastErrorCode,
		FirstSeenAt:    now,
		LastSeenAt:     now,
		UpdatedAt:      now,
	})
	if err != nil {
		return err
	}

	mainPath := strings.TrimSpace(signal.TranscriptPath)
	if mainPath == "" && session.Harness == domain.HarnessCodex {
		mainPath = c.discoverPath(session.Harness, signal.NativeSessionID)
	}
	if mainPath != "" {
		kind := domain.UsageSourceClaudeMain
		if session.Harness == domain.HarnessCodex {
			kind = domain.UsageSourceCodexRollout
		}
		changed, err := c.registerSource(
			ctx,
			binding,
			kind,
			signal.NativeSessionID,
			"",
			mainPath,
			now,
			signal.Event == "session-start" || finalizing,
		)
		if err != nil {
			c.notifySourceInventory(true)
			return err
		}
		inventoryChanged = inventoryChanged || changed
		sourceErrorCode := ""
		if c.codexDiscoveryStillPending(signal.Event, signal.TranscriptPath, mainPath) {
			sourceErrorCode = domain.UsageErrorSourceDiscoveryPending
		}
		if _, err := c.store.UpdateUsageBindingErrorCode(ctx, binding.ID, sourceErrorCode, now); err != nil {
			return err
		}
	} else {
		needsReconcile = true
	}
	if path := strings.TrimSpace(signal.SubagentTranscriptPath); path != "" && session.Harness == domain.HarnessClaudeCode {
		changed, err := c.registerSource(
			ctx,
			binding,
			domain.UsageSourceClaudeSubagent,
			signal.NativeSessionID,
			boundedUsageMetadata(signal.SubagentID),
			path,
			now,
			finalizing || signal.Event == "subagent-stop",
		)
		if err != nil {
			c.notifySourceInventory(true)
			return err
		}
		inventoryChanged = inventoryChanged || changed
	}
	if signal.Event == "session-start" {
		changed, err := c.reactivateBinding(ctx, binding, now)
		if err != nil {
			return err
		}
		inventoryChanged = inventoryChanged || changed
		if c.codexDiscoveryStillPending(signal.Event, signal.TranscriptPath, mainPath) {
			if _, err := c.store.UpdateUsageBindingState(
				ctx,
				binding.ID,
				domain.UsageBindingActive,
				domain.UsageErrorSourceDiscoveryPending,
				now,
			); err != nil {
				return err
			}
		}
	} else if state == domain.UsageBindingFinalizing {
		if err := c.settleFinalizingBinding(ctx, binding.ID, now); err != nil {
			return err
		}
	}
	switch {
	case needsReconcile:
		c.notifySourceInventory(true)
	case inventoryChanged:
		c.notifySourceInventory(false)
	}
	return nil
}

func finalizingEvent(event string) bool {
	return event == "session-end" || event == "process-exited"
}

// BackfillActive discovers transcript files only for live/resumable AO
// sessions. It deliberately does not import terminated session history.
func (c *Collector) BackfillActive(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	sessions, err := c.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, session := range sessions {
		if session.IsTerminated || !SupportedHarness(session.Harness) {
			continue
		}
		nativeID := boundedUsageMetadata(session.Metadata.AgentSessionID)
		if nativeID == "" || !nativeUsageIDPattern.MatchString(nativeID) {
			continue
		}
		if err := c.backfillSession(ctx, session, nativeID); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (c *Collector) backfillSession(ctx context.Context, session domain.SessionRecord, nativeID string) error {
	now := c.now().UTC()
	existing, exists, err := c.store.GetUsageBinding(ctx, session.ID, session.Harness, nativeID)
	if err != nil {
		return err
	}
	path := c.discoverPath(session.Harness, nativeID)
	if exists && (existing.State == domain.UsageBindingComplete || existing.State == domain.UsageBindingPartial) {
		return nil
	}

	state := existing.State
	if !exists {
		state = domain.UsageBindingActive
		switch {
		case session.Activity.State == domain.ActivityExited:
			state = domain.UsageBindingFinalizing
		case path == "":
			state = domain.UsageBindingDiscovering
		}
	} else if session.Activity.State == domain.ActivityExited &&
		(state == domain.UsageBindingDiscovering || state == domain.UsageBindingActive) {
		state = domain.UsageBindingFinalizing
	} else if state == domain.UsageBindingDiscovering && path != "" {
		state = domain.UsageBindingActive
	}
	lastErrorCode := ""
	if path == "" {
		lastErrorCode = domain.UsageErrorSourceDiscoveryPending
	}
	binding, err := c.store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:      session.ID,
		Harness:        session.Harness,
		NativeRootID:   nativeID,
		InitialModelID: existing.InitialModelID,
		State:          state,
		LastErrorCode:  lastErrorCode,
		FirstSeenAt:    now,
		LastSeenAt:     now,
		UpdatedAt:      now,
	})
	if err != nil {
		return err
	}
	if path == "" {
		return nil
	}

	kind := domain.UsageSourceClaudeMain
	if session.Harness == domain.HarnessCodex {
		kind = domain.UsageSourceCodexRollout
	}
	if _, err := c.registerSource(ctx, binding, kind, nativeID, "", path, now, false); err != nil {
		return err
	}
	if session.Harness == domain.HarnessClaudeCode {
		if err := c.registerDiscoveredClaudeSubagents(ctx, binding, path, now, false); err != nil {
			return err
		}
	}
	if state == domain.UsageBindingFinalizing {
		return c.settleFinalizingBinding(ctx, binding.ID, now)
	}
	return nil
}

// ReconcileSources discovers provider artifacts that hooks could not name,
// appeared after their hook, or moved between provider-owned directories.
// A negative limit reconciles every eligible binding; zero uses the bounded
// default.
func (c *Collector) ReconcileSources(ctx context.Context, limit int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if limit == 0 {
		limit = defaultDiscoveryLimit
	}
	bindings, err := c.store.ListUsageDiscoveryBindings(ctx, limit)
	if err != nil {
		return err
	}
	now := c.now().UTC()
	var errs []error
	for _, binding := range bindings {
		if err := c.reconcileBinding(ctx, binding, now); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (c *Collector) reconcileBinding(ctx context.Context, binding domain.UsageBindingRecord, now time.Time) error {
	session, ok, err := c.store.GetSession(ctx, binding.SessionID)
	if err != nil || !ok {
		return err
	}
	if session.IsTerminated && binding.State != domain.UsageBindingFinalizing {
		return nil
	}

	targetState := binding.State
	if session.Activity.State == domain.ActivityExited &&
		(binding.State == domain.UsageBindingDiscovering || binding.State == domain.UsageBindingActive) {
		targetState = domain.UsageBindingFinalizing
	}

	path := c.discoverPath(binding.Harness, binding.NativeRootID)
	if path == "" {
		_, err = c.store.UpdateUsageBindingState(ctx, binding.ID, targetState, domain.UsageErrorSourceDiscoveryPending, now)
		return err
	}
	if targetState == domain.UsageBindingDiscovering {
		targetState = domain.UsageBindingActive
	}

	kind := domain.UsageSourceClaudeMain
	if binding.Harness == domain.HarnessCodex {
		kind = domain.UsageSourceCodexRollout
	}
	if _, err := c.registerSource(ctx, binding, kind, binding.NativeRootID, "", path, now, false); err != nil {
		return err
	}
	if binding.Harness == domain.HarnessClaudeCode {
		if err := c.registerDiscoveredClaudeSubagents(ctx, binding, path, now, false); err != nil {
			return err
		}
	}
	lastErrorCode := ""
	if binding.Harness == domain.HarnessCodex &&
		binding.LastErrorCode == domain.UsageErrorSourceDiscoveryPending &&
		targetState == domain.UsageBindingActive &&
		!pathWithinRoot(path, c.roots.CodexSessions) {
		lastErrorCode = domain.UsageErrorSourceDiscoveryPending
	}
	if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, targetState, lastErrorCode, now); err != nil {
		return err
	}
	if targetState == domain.UsageBindingFinalizing {
		return c.settleFinalizingBinding(ctx, binding.ID, now)
	}
	return nil
}

func (c *Collector) registerSource(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	kind domain.UsageSourceKind,
	nativeSessionID string,
	subagentID string,
	path string,
	now time.Time,
	reactivateExisting bool,
) (bool, error) {
	resolved, identity, size, err := c.validateSourcePath(binding.Harness, path)
	if err != nil {
		return false, err
	}
	sources, err := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		return false, err
	}
	var latest *domain.UsageSourceRecord
	var identityMatch *domain.UsageSourceRecord
	var latestKind *domain.UsageSourceRecord
	var generation int64
	for i := range sources {
		source := &sources[i]
		if source.Generation >= generation {
			generation = source.Generation
		}
		if source.ArtifactPath == resolved && (latest == nil || source.Generation > latest.Generation) {
			latest = source
		}
		if source.Kind == kind && (latestKind == nil || source.Generation > latestKind.Generation ||
			(source.Generation == latestKind.Generation && source.ID > latestKind.ID)) {
			latestKind = source
		}
		if source.Kind == kind &&
			source.NativeSessionID == nativeSessionID &&
			source.FileIdentity == identity &&
			size >= source.ByteOffset &&
			(identityMatch == nil || source.Generation > identityMatch.Generation) {
			identityMatch = source
		}
	}
	if latest != nil && latest.FileIdentity == identity && size >= latest.ByteOffset {
		if reactivateExisting || latest.State == domain.UsageSourceError {
			changed, err := c.store.ReactivateUsageSource(ctx, latest.ID, now)
			return changed, err
		}
		return false, nil
	}
	if latest != nil {
		_, _ = c.store.MarkUsageSourceState(ctx, latest.ID, domain.UsageSourceComplete, domain.UsageErrorArtifactReplaced, nil, now)
		generation = latest.Generation + 1
	} else if len(sources) > 0 {
		generation++
	}
	if latest == nil && kind == domain.UsageSourceCodexRollout && latestKind != nil {
		_, _ = c.store.MarkUsageSourceState(ctx, latestKind.ID, domain.UsageSourceComplete, "", nil, now)
	}
	record := domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            kind,
		NativeSessionID: nativeSessionID,
		SubagentID:      subagentID,
		ArtifactPath:    resolved,
		FileIdentity:    identity,
		Generation:      generation,
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if latest == nil && identityMatch != nil {
		_, _ = c.store.MarkUsageSourceState(ctx, identityMatch.ID, domain.UsageSourceComplete, "", nil, now)
		record.ByteOffset = identityMatch.ByteOffset
		record.ParserStateJSON = identityMatch.ParserStateJSON
	}
	_, err = c.store.InsertUsageSource(ctx, record)
	return err == nil, err
}

func (c *Collector) registerDiscoveredClaudeSubagents(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	mainPath string,
	now time.Time,
	reactivateExisting bool,
) error {
	var errs []error
	for _, path := range discoverClaudeSubagentPaths(mainPath) {
		name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		subagentID := strings.TrimPrefix(name, "agent-")
		if _, err := c.registerSource(
			ctx,
			binding,
			domain.UsageSourceClaudeSubagent,
			binding.NativeRootID,
			boundedUsageMetadata(subagentID),
			path,
			now,
			reactivateExisting,
		); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func discoverClaudeSubagentPaths(mainPath string) []string {
	base := strings.TrimSuffix(mainPath, filepath.Ext(mainPath))
	pattern := filepath.Join(base, "subagents", "agent-*.jsonl")
	paths, _ := filepath.Glob(pattern)
	sort.Slice(paths, func(i, j int) bool {
		left, leftErr := os.Stat(paths[i])
		right, rightErr := os.Stat(paths[j])
		if leftErr != nil {
			return false
		}
		if rightErr != nil {
			return true
		}
		return left.ModTime().Before(right.ModTime())
	})
	return paths
}

func (c *Collector) settleFinalizingBinding(ctx context.Context, bindingID int64, now time.Time) error {
	_, err := c.store.CompleteUsageBindingIfSettled(ctx, bindingID, now)
	return err
}

func (c *Collector) reactivateBinding(ctx context.Context, binding domain.UsageBindingRecord, now time.Time) (bool, error) {
	if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingActive, "", now); err != nil {
		return false, err
	}
	sources, err := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		return false, err
	}
	var latestMain *domain.UsageSourceRecord
	for i := range sources {
		source := &sources[i]
		if source.Kind != domain.UsageSourceCodexRollout && source.Kind != domain.UsageSourceClaudeMain {
			continue
		}
		if latestMain == nil || source.Generation > latestMain.Generation ||
			(source.Generation == latestMain.Generation && source.ID > latestMain.ID) {
			latestMain = source
		}
	}
	if latestMain != nil {
		return c.store.ReactivateUsageSource(ctx, latestMain.ID, now)
	}
	return false, nil
}

func (c *Collector) reactivateLatestSources(ctx context.Context, bindingID int64, now time.Time) error {
	sources, err := c.store.ListUsageSourcesForBinding(ctx, bindingID)
	if err != nil {
		return err
	}
	latestByPath := make(map[string]domain.UsageSourceRecord)
	for _, source := range sources {
		latest, ok := latestByPath[source.ArtifactPath]
		if !ok || source.Generation > latest.Generation ||
			(source.Generation == latest.Generation && source.ID > latest.ID) {
			latestByPath[source.ArtifactPath] = source
		}
	}
	for _, source := range latestByPath {
		if _, err := c.store.ReactivateUsageSource(ctx, source.ID, now); err != nil {
			return err
		}
	}
	return nil
}

func (c *Collector) finalizeSession(ctx context.Context, sessionID domain.SessionID, now time.Time) error {
	bindings, err := c.store.ListUsageBindingsForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
			return err
		}
		if err := c.reactivateLatestSources(ctx, binding.ID, now); err != nil {
			return err
		}
	}
	return nil
}

func (c *Collector) validateSourcePath(harness domain.AgentHarness, path string) (string, string, int64, error) {
	if len(path) > maxUsagePathBytes {
		return "", "", 0, errors.New(domain.UsageErrorArtifactPathRejected)
	}
	if !filepath.IsAbs(path) || strings.ToLower(filepath.Ext(path)) != ".jsonl" {
		return "", "", 0, errors.New(domain.UsageErrorArtifactPathRejected)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", "", 0, errors.New(domain.UsageErrorArtifactMissing)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", 0, errors.New(domain.UsageErrorArtifactMissing)
	}
	roots := c.allowedRoots(harness)
	allowed := false
	for _, root := range roots {
		if root == "" {
			continue
		}
		resolvedRoot, rootErr := filepath.EvalSymlinks(filepath.Clean(root))
		if rootErr != nil {
			continue
		}
		rel, relErr := filepath.Rel(resolvedRoot, resolved)
		if relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", "", 0, errors.New(domain.UsageErrorArtifactPathRejected)
	}
	identity, err := SourceIdentity(resolved)
	if err != nil {
		return "", "", 0, err
	}
	return resolved, identity, info.Size(), nil
}

func (c *Collector) allowedRoots(harness domain.AgentHarness) []string {
	switch harness {
	case domain.HarnessClaudeCode:
		return []string{c.roots.ClaudeProjects}
	case domain.HarnessCodex:
		return []string{c.roots.CodexSessions, c.roots.CodexArchived}
	default:
		return nil
	}
}

func (c *Collector) codexDiscoveryStillPending(event, hookPath, discoveredPath string) bool {
	if strings.TrimSpace(hookPath) != "" {
		return false
	}
	if strings.TrimSpace(discoveredPath) == "" {
		return true
	}
	return event == "session-start" && !pathWithinRoot(discoveredPath, c.roots.CodexSessions)
}

func pathWithinRoot(path, root string) bool {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(root) == "" {
		return false
	}
	resolvedPath, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return false
	}
	resolvedRoot, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedPath)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (c *Collector) discoverPath(harness domain.AgentHarness, nativeID string) string {
	var patterns []string
	switch harness {
	case domain.HarnessClaudeCode:
		patterns = []string{filepath.Join(c.roots.ClaudeProjects, "*", nativeID+".jsonl")}
	case domain.HarnessCodex:
		patterns = []string{
			filepath.Join(c.roots.CodexSessions, "*", "*", "*", "*"+nativeID+"*.jsonl"),
			filepath.Join(c.roots.CodexArchived, "*"+nativeID+"*.jsonl"),
		}
	}
	type candidate struct {
		path string
		mod  time.Time
	}
	var matches []candidate
	for _, pattern := range patterns {
		paths, _ := filepath.Glob(pattern)
		if len(paths) > 128 {
			paths = paths[:128]
		}
		for _, path := range paths {
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
				matches = append(matches, candidate{path: path, mod: info.ModTime()})
			}
		}
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].mod.After(matches[j].mod) })
	if len(matches) == 0 {
		return ""
	}
	return matches[0].path
}

func (c *Collector) notifySourceInventory(reconcile bool) {
	if c.notifySourcesChanged != nil {
		c.notifySourcesChanged(reconcile)
	}
}

func nativeIDFromTranscript(path string) string {
	base := strings.TrimSuffix(filepath.Base(strings.TrimSpace(path)), filepath.Ext(path))
	if nativeUsageIDPattern.MatchString(base) {
		return base
	}
	return ""
}

func boundedUsageMetadata(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > maxUsageMetadataBytes {
		return ""
	}
	return value
}

// SourceIdentity returns the filesystem's stable file id. Transcript contents
// are append-only and therefore cannot participate in identity without making a
// newly created or partially written first record look like file replacement.
func SourceIdentity(path string) (string, error) {
	file, err := os.Open(path) //nolint:gosec // validated provider-owned path.
	if err != nil {
		return "", errors.New(domain.UsageErrorSourceReadFailed)
	}
	defer func() { _ = file.Close() }()
	fileID, err := sourceFileID(file)
	if err != nil {
		return "", errors.New(domain.UsageErrorSourceReadFailed)
	}
	return fileID, nil
}
