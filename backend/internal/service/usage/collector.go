package usage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	maxUsageMetadataBytes          = 256
	maxUsagePathBytes              = 4096
	maxCodexSessionMeta            = 64 << 10
	maxCodexChildIDs               = 4096
	defaultCodexLogicalSourceLimit = 4096
	defaultDiscoveryLimit          = 64
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
	FinalizeUsageBindingsForSessionLaunch(context.Context, domain.SessionID, string, time.Time, time.Time) ([]domain.UsageBindingRecord, error)
	ListUsageDiscoveryBindings(context.Context, int64) ([]domain.UsageBindingRecord, error)
	ListUsageBindingsForCodexParent(context.Context, string) ([]domain.UsageBindingRecord, error)
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
	store                   collectorStore
	roots                   SourceRoots
	notifySourcesChanged    func(reconcile bool)
	codexLogicalSourceLimit int
	now                     func() time.Time
	mu                      sync.Mutex
}

// NewCollector constructs a transcript source registrar.
func NewCollector(store collectorStore, roots SourceRoots, notifySourcesChanged func(reconcile bool)) *Collector {
	return newCollectorWithCodexSourceLimit(store, roots, notifySourcesChanged, defaultCodexLogicalSourceLimit)
}

func newCollectorWithCodexSourceLimit(
	store collectorStore,
	roots SourceRoots,
	notifySourcesChanged func(reconcile bool),
	limit int,
) *Collector {
	if limit <= 0 {
		limit = defaultCodexLogicalSourceLimit
	}
	return &Collector{
		store:                   store,
		roots:                   roots,
		notifySourcesChanged:    notifySourcesChanged,
		codexLogicalSourceLimit: limit,
		now:                     time.Now,
	}
}

// FinalizeSession moves every known native binding for one observed runtime
// generation and session revision into finalization, then asks the ingestion
// pipeline to collect a stable final cursor. It is idempotent and safe to call
// before the session is terminated.
func (c *Collector) FinalizeSession(
	ctx context.Context,
	sessionID domain.SessionID,
	expectedRuntimeLaunchID string,
	expectedSessionRevision time.Time,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now().UTC()
	bindings, err := c.store.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sessionID,
		boundedUsageMetadata(expectedRuntimeLaunchID),
		expectedSessionRevision,
		now,
	)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if _, err := c.reactivateLatestSources(ctx, binding.ID, now); err != nil {
			return err
		}
	}
	if len(bindings) > 0 {
		c.notifySourceInventory(false)
	}
	return nil
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
	finalizing := finalizingEvent(signal.Event)
	sessionLive := !session.IsTerminated && session.Activity.State != domain.ActivityExited
	if session.IsTerminated || (!finalizing && !sessionLive) {
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
	if finalizing {
		if err := c.finalizeSession(ctx, sessionID, now); err != nil {
			return err
		}
	}
	if signal.NativeSessionID == "" {
		c.notifySourceInventory(!finalizing)
		return nil
	}

	existing, exists, err := c.store.GetUsageBinding(ctx, sessionID, session.Harness, signal.NativeSessionID)
	if err != nil {
		return err
	}
	mainPath := strings.TrimSpace(signal.TranscriptPath)
	if mainPath == "" && (session.Harness == domain.HarnessCodex || finalizing && !exists) {
		mainPath = c.discoverPath(session.Harness, signal.NativeSessionID)
	}
	subagentPath := strings.TrimSpace(signal.SubagentTranscriptPath)
	if finalizing && !exists {
		recoveryPath := mainPath
		if recoveryPath == "" && session.Harness == domain.HarnessClaudeCode {
			recoveryPath = subagentPath
		}
		if recoveryPath == "" {
			return nil
		}
		if _, _, _, err := c.validateSourcePath(session.Harness, recoveryPath); err != nil {
			return err
		}
	}
	reactivating := sessionLive && !finalizing && (signal.Event == "session-start" ||
		exists && existing.State == domain.UsageBindingFinalizing)
	state := domain.UsageBindingActive
	if exists {
		state = existing.State
	}
	switch {
	case finalizing:
		state = domain.UsageBindingFinalizing
	case reactivating:
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
	if path := subagentPath; path != "" && session.Harness == domain.HarnessClaudeCode {
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
	if reactivating {
		changed, err := c.reactivateBinding(ctx, binding, now)
		if err != nil {
			return err
		}
		inventoryChanged = inventoryChanged || changed
		if session.Harness == domain.HarnessCodex {
			needsReconcile = true
		}
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
	} else if err := c.registerDiscoveredCodexChildren(ctx, binding, now); err != nil {
		return err
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

// ReconcilePath uses a newly created Codex child rollout's validated metadata
// to reach its binding directly, independently of the bounded discovery queue.
func (c *Collector) ReconcilePath(ctx context.Context, path string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	resolved, _, _, err := c.validateSourcePath(domain.HarnessCodex, path)
	if err != nil {
		return nil
	}
	meta, ok := readCodexSessionMeta(resolved)
	if !ok || meta.ParentThreadID == "" ||
		!validCanonicalUUID(meta.NativeSessionID) ||
		len(meta.ParentThreadID) > maxUsageMetadataBytes ||
		!nativeUsageIDPattern.MatchString(meta.ParentThreadID) {
		return nil
	}
	bindings, err := c.store.ListUsageBindingsForCodexParent(ctx, meta.ParentThreadID)
	if err != nil {
		return err
	}
	now := c.now().UTC()
	var errs []error
	for _, binding := range bindings {
		sources, listErr := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
		if listErr != nil {
			errs = append(errs, listErr)
			continue
		}
		if !latestCodexSourceDiscovers(sources, meta.ParentThreadID, meta.NativeSessionID) {
			continue
		}
		if _, registerErr := c.registerSource(
			ctx,
			binding,
			domain.UsageSourceCodexRollout,
			meta.NativeSessionID,
			meta.NativeSessionID,
			resolved,
			now,
			false,
		); registerErr != nil {
			errs = append(errs, registerErr)
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
		(binding.State == domain.UsageBindingDiscovering ||
			binding.State == domain.UsageBindingActive ||
			(binding.State == domain.UsageBindingPartial &&
				binding.LastErrorCode == domain.UsageErrorCodexSourceBudgetExceeded)) {
		targetState = domain.UsageBindingFinalizing
	}

	path := c.discoverPath(binding.Harness, binding.NativeRootID)
	if path == "" {
		if binding.Harness == domain.HarnessCodex {
			if childErr := c.registerDiscoveredCodexChildren(ctx, binding, now); childErr != nil {
				return childErr
			}
		}
		targetState, lastErrorCode, stateErr := c.preserveCodexBudgetState(
			ctx,
			binding,
			targetState,
			domain.UsageErrorSourceDiscoveryPending,
		)
		if stateErr != nil {
			return stateErr
		}
		_, err = c.store.UpdateUsageBindingState(ctx, binding.ID, targetState, lastErrorCode, now)
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
	} else if err := c.registerDiscoveredCodexChildren(ctx, binding, now); err != nil {
		return err
	}
	lastErrorCode := ""
	if binding.Harness == domain.HarnessCodex &&
		binding.LastErrorCode == domain.UsageErrorSourceDiscoveryPending &&
		targetState == domain.UsageBindingActive &&
		!pathWithinRoot(path, c.roots.CodexSessions) {
		lastErrorCode = domain.UsageErrorSourceDiscoveryPending
	}
	targetState, lastErrorCode, err = c.preserveCodexBudgetState(
		ctx,
		binding,
		targetState,
		lastErrorCode,
	)
	if err != nil {
		return err
	}
	if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, targetState, lastErrorCode, now); err != nil {
		return err
	}
	if targetState == domain.UsageBindingFinalizing {
		return c.settleFinalizingBinding(ctx, binding.ID, now)
	}
	return nil
}

func (c *Collector) preserveCodexBudgetState(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	state domain.UsageBindingState,
	errorCode string,
) (domain.UsageBindingState, string, error) {
	if binding.Harness != domain.HarnessCodex {
		return state, errorCode, nil
	}
	current, ok, err := c.store.GetUsageBinding(
		ctx,
		binding.SessionID,
		binding.Harness,
		binding.NativeRootID,
	)
	if err != nil || !ok {
		return state, errorCode, err
	}
	if current.LastErrorCode == domain.UsageErrorCodexSourceBudgetExceeded {
		if state == domain.UsageBindingFinalizing {
			return state, current.LastErrorCode, nil
		}
		return current.State, current.LastErrorCode, nil
	}
	return state, errorCode, nil
}

type usageSourceIdentityKey struct {
	kind            domain.UsageSourceKind
	nativeSessionID string
	fileIdentity    string
}

type bindingSourceInventory struct {
	sources             []*domain.UsageSourceRecord
	byID                map[int64]*domain.UsageSourceRecord
	latestByPath        map[string]*domain.UsageSourceRecord
	latestCodexByNative map[string]*domain.UsageSourceRecord
	byIdentity          map[usageSourceIdentityKey][]*domain.UsageSourceRecord
	codexLogicalIDs     map[string]struct{}
	maxGeneration       int64
}

func newBindingSourceInventory(sources []domain.UsageSourceRecord) *bindingSourceInventory {
	inventory := &bindingSourceInventory{}
	for _, source := range sources {
		inventory.sources = append(inventory.sources, &domain.UsageSourceRecord{})
		*inventory.sources[len(inventory.sources)-1] = source
	}
	inventory.rebuildIndexes()
	return inventory
}

func (i *bindingSourceInventory) rebuildIndexes() {
	i.byID = make(map[int64]*domain.UsageSourceRecord, len(i.sources))
	i.latestByPath = make(map[string]*domain.UsageSourceRecord, len(i.sources))
	i.latestCodexByNative = make(map[string]*domain.UsageSourceRecord, len(i.sources))
	i.byIdentity = make(map[usageSourceIdentityKey][]*domain.UsageSourceRecord, len(i.sources))
	i.codexLogicalIDs = make(map[string]struct{}, len(i.sources))
	i.maxGeneration = 0
	for _, source := range i.sources {
		i.indexSource(source)
	}
}

func (i *bindingSourceInventory) indexSource(source *domain.UsageSourceRecord) {
	if source.ID != 0 {
		i.byID[source.ID] = source
	}
	if source.Generation >= i.maxGeneration {
		i.maxGeneration = source.Generation
	}
	latest := i.latestByPath[source.ArtifactPath]
	if latest == nil || source.Generation > latest.Generation {
		i.latestByPath[source.ArtifactPath] = source
	}
	if source.Kind == domain.UsageSourceCodexRollout && source.NativeSessionID != "" {
		i.codexLogicalIDs[source.NativeSessionID] = struct{}{}
		latest = i.latestCodexByNative[source.NativeSessionID]
		if latest == nil || source.Generation > latest.Generation ||
			(source.Generation == latest.Generation && source.ID > latest.ID) {
			i.latestCodexByNative[source.NativeSessionID] = source
		}
	}
	key := usageSourceIdentityKey{
		kind:            source.Kind,
		nativeSessionID: source.NativeSessionID,
		fileIdentity:    source.FileIdentity,
	}
	i.byIdentity[key] = append(i.byIdentity[key], source)
}

func (i *bindingSourceInventory) add(source domain.UsageSourceRecord) {
	if existing := i.byID[source.ID]; source.ID != 0 && existing != nil {
		*existing = source
		i.rebuildIndexes()
		return
	}
	record := &domain.UsageSourceRecord{}
	*record = source
	i.sources = append(i.sources, record)
	i.indexSource(record)
}

func (i *bindingSourceInventory) identityMatch(
	kind domain.UsageSourceKind,
	nativeSessionID string,
	fileIdentity string,
	size int64,
) *domain.UsageSourceRecord {
	key := usageSourceIdentityKey{
		kind:            kind,
		nativeSessionID: nativeSessionID,
		fileIdentity:    fileIdentity,
	}
	var match *domain.UsageSourceRecord
	for _, source := range i.byIdentity[key] {
		if size >= source.ByteOffset && (match == nil || source.Generation > match.Generation) {
			match = source
		}
	}
	return match
}

func (i *bindingSourceInventory) markState(
	id int64,
	state domain.UsageSourceState,
	errorCode string,
	now time.Time,
) {
	if source := i.byID[id]; source != nil {
		source.State = state
		source.LastErrorCode = errorCode
		source.NextRetryAt = nil
		source.UpdatedAt = now
	}
}

func (i *bindingSourceInventory) reactivate(id int64, now time.Time) {
	if source := i.byID[id]; source != nil {
		source.State = domain.UsageSourceActive
		source.FailureCount = 0
		source.NextRetryAt = nil
		source.LastErrorCode = ""
		source.UpdatedAt = now
	}
}

func (i *bindingSourceInventory) snapshot() []domain.UsageSourceRecord {
	sources := make([]domain.UsageSourceRecord, 0, len(i.sources))
	for _, source := range i.sources {
		sources = append(sources, *source)
	}
	return sources
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
	return c.registerValidatedSource(
		ctx,
		binding,
		kind,
		nativeSessionID,
		subagentID,
		resolved,
		identity,
		size,
		now,
		reactivateExisting,
		newBindingSourceInventory(sources),
	)
}

func (c *Collector) registerSourceWithInventory(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	kind domain.UsageSourceKind,
	nativeSessionID string,
	subagentID string,
	path string,
	now time.Time,
	reactivateExisting bool,
	inventory *bindingSourceInventory,
) (bool, error) {
	resolved, identity, size, err := c.validateSourcePath(binding.Harness, path)
	if err != nil {
		return false, err
	}
	return c.registerValidatedSource(
		ctx,
		binding,
		kind,
		nativeSessionID,
		subagentID,
		resolved,
		identity,
		size,
		now,
		reactivateExisting,
		inventory,
	)
}

func (c *Collector) registerValidatedSource(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	kind domain.UsageSourceKind,
	nativeSessionID string,
	subagentID string,
	resolved string,
	identity string,
	size int64,
	now time.Time,
	reactivateExisting bool,
	inventory *bindingSourceInventory,
) (bool, error) {
	if c.codexSourceBudgetExceeded(inventory, kind, nativeSessionID, subagentID) {
		state := binding.State
		if state == domain.UsageBindingDiscovering || state == domain.UsageBindingActive {
			state = domain.UsageBindingPartial
		}
		_, err := c.store.UpdateUsageBindingState(
			ctx,
			binding.ID,
			state,
			domain.UsageErrorCodexSourceBudgetExceeded,
			now,
		)
		return false, err
	}
	latest := inventory.latestByPath[resolved]
	latestNative := inventory.latestCodexByNative[nativeSessionID]
	identityMatch := inventory.identityMatch(kind, nativeSessionID, identity, size)
	generation := inventory.maxGeneration
	if latest != nil && latest.FileIdentity == identity && size >= latest.ByteOffset {
		if reactivateExisting || latest.State == domain.UsageSourceError {
			changed, err := c.store.ReactivateUsageSource(ctx, latest.ID, now)
			if err == nil && changed {
				inventory.reactivate(latest.ID, now)
			}
			return changed, err
		}
		return false, nil
	}
	if latest != nil {
		changed, markErr := c.store.MarkUsageSourceState(
			ctx,
			latest.ID,
			domain.UsageSourceComplete,
			domain.UsageErrorArtifactReplaced,
			nil,
			now,
		)
		if markErr == nil && changed {
			inventory.markState(latest.ID, domain.UsageSourceComplete, domain.UsageErrorArtifactReplaced, now)
		}
		generation = latest.Generation + 1
	} else if len(inventory.sources) > 0 {
		generation++
	}
	if kind == domain.UsageSourceCodexRollout && latest == nil && latestNative != nil {
		changed, markErr := c.store.MarkUsageSourceState(
			ctx,
			latestNative.ID,
			domain.UsageSourceComplete,
			"",
			nil,
			now,
		)
		if markErr == nil && changed {
			inventory.markState(latestNative.ID, domain.UsageSourceComplete, "", now)
		}
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
		changed, markErr := c.store.MarkUsageSourceState(
			ctx,
			identityMatch.ID,
			domain.UsageSourceComplete,
			"",
			nil,
			now,
		)
		if markErr == nil && changed {
			inventory.markState(identityMatch.ID, domain.UsageSourceComplete, "", now)
		}
		record.ByteOffset = identityMatch.ByteOffset
		record.ParserStateJSON = identityMatch.ParserStateJSON
	}
	inserted, err := c.store.InsertUsageSource(ctx, record)
	if err != nil {
		return false, err
	}
	inventory.add(inserted)
	return true, nil
}

func (c *Collector) codexSourceBudgetExceeded(
	inventory *bindingSourceInventory,
	kind domain.UsageSourceKind,
	nativeSessionID string,
	subagentID string,
) bool {
	if kind != domain.UsageSourceCodexRollout || nativeSessionID == "" || subagentID == "" {
		return false
	}
	if _, exists := inventory.codexLogicalIDs[nativeSessionID]; exists {
		return false
	}
	return len(inventory.codexLogicalIDs) >= c.codexLogicalSourceLimit
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

func (c *Collector) registerDiscoveredCodexChildren(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	now time.Time,
) error {
	sources, err := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		return err
	}
	return c.registerDiscoveredCodexChildrenWithInventory(
		ctx,
		binding,
		now,
		newBindingSourceInventory(sources),
	)
}

func (c *Collector) registerDiscoveredCodexChildrenWithInventory(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	now time.Time,
	inventory *bindingSourceInventory,
) error {
	sources := latestCodexSourcesByNativeSession(inventory.snapshot())
	seen := make(map[string]struct{})
	var errs []error
	for _, source := range sources {
		if source.Kind != domain.UsageSourceCodexRollout || source.NativeSessionID == "" {
			continue
		}
		for _, childID := range discoveredCodexChildIDs(source.ParserStateJSON) {
			key := source.NativeSessionID + "\x00" + childID
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			path := c.discoverCodexPath(childID, source.NativeSessionID)
			if path == "" {
				continue
			}
			if _, err := c.registerSourceWithInventory(
				ctx,
				binding,
				domain.UsageSourceCodexRollout,
				childID,
				childID,
				path,
				now,
				false,
				inventory,
			); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func latestCodexSourcesByNativeSession(sources []domain.UsageSourceRecord) []domain.UsageSourceRecord {
	latest := make(map[string]domain.UsageSourceRecord)
	for _, source := range sources {
		if source.Kind != domain.UsageSourceCodexRollout || source.NativeSessionID == "" {
			continue
		}
		current, ok := latest[source.NativeSessionID]
		if !ok || source.Generation > current.Generation ||
			(source.Generation == current.Generation && source.ID > current.ID) {
			latest[source.NativeSessionID] = source
		}
	}
	result := make([]domain.UsageSourceRecord, 0, len(latest))
	for _, source := range latest {
		result = append(result, source)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Generation != result[j].Generation {
			return result[i].Generation < result[j].Generation
		}
		return result[i].ID < result[j].ID
	})
	return result
}

func latestCodexSourceDiscovers(sources []domain.UsageSourceRecord, parentID, childID string) bool {
	for _, source := range latestCodexSourcesByNativeSession(sources) {
		if source.NativeSessionID == parentID && containsUsageString(discoveredCodexChildIDs(source.ParserStateJSON), childID) {
			return true
		}
	}
	return false
}

func containsUsageString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func discoveredCodexChildIDs(raw string) []string {
	var state struct {
		Version    int                    `json:"version"`
		SourceKind domain.UsageSourceKind `json:"source_kind"`
		Codex      *struct {
			DiscoveredChildIDs []string `json:"discovered_child_ids"`
		} `json:"codex"`
	}
	if json.Unmarshal([]byte(raw), &state) != nil || state.Version != 1 ||
		state.SourceKind != domain.UsageSourceCodexRollout || state.Codex == nil {
		return nil
	}
	seen := make(map[string]struct{}, len(state.Codex.DiscoveredChildIDs))
	result := make([]string, 0, len(state.Codex.DiscoveredChildIDs))
	for _, childID := range state.Codex.DiscoveredChildIDs {
		if len(result) >= maxCodexChildIDs {
			break
		}
		parsed, err := uuid.Parse(childID)
		if err != nil || parsed.String() != childID || len(childID) > maxUsageMetadataBytes {
			continue
		}
		if _, ok := seen[childID]; ok {
			continue
		}
		seen[childID] = struct{}{}
		result = append(result, childID)
	}
	return result
}

func (c *Collector) settleFinalizingBinding(ctx context.Context, bindingID int64, now time.Time) error {
	_, err := c.store.CompleteUsageBindingIfSettled(ctx, bindingID, now)
	return err
}

func (c *Collector) reactivateBinding(ctx context.Context, binding domain.UsageBindingRecord, now time.Time) (bool, error) {
	state := domain.UsageBindingActive
	errorCode := ""
	if binding.LastErrorCode == domain.UsageErrorCodexSourceBudgetExceeded {
		errorCode = binding.LastErrorCode
		state = domain.UsageBindingPartial
	}
	if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, state, errorCode, now); err != nil {
		return false, err
	}
	return c.reactivateLatestSources(ctx, binding.ID, now)
}

func (c *Collector) reactivateLatestSources(ctx context.Context, bindingID int64, now time.Time) (bool, error) {
	sources, err := c.store.ListUsageSourcesForBinding(ctx, bindingID)
	if err != nil {
		return false, err
	}
	latestByPath := make(map[string]domain.UsageSourceRecord)
	for _, source := range sources {
		key := source.ArtifactPath
		if source.Kind == domain.UsageSourceCodexRollout && source.NativeSessionID != "" {
			key = string(source.Kind) + "\x00" + source.NativeSessionID
		}
		latest, ok := latestByPath[key]
		if !ok || source.Generation > latest.Generation ||
			(source.Generation == latest.Generation && source.ID > latest.ID) {
			latestByPath[key] = source
		}
	}
	changed := false
	for _, source := range latestByPath {
		sourceChanged, err := c.store.ReactivateUsageSource(ctx, source.ID, now)
		if err != nil {
			return false, err
		}
		changed = changed || sourceChanged
	}
	return changed, nil
}

func (c *Collector) finalizeSession(ctx context.Context, sessionID domain.SessionID, now time.Time) error {
	bindings, err := c.store.ListUsageBindingsForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		errorCode := ""
		if binding.LastErrorCode == domain.UsageErrorCodexSourceBudgetExceeded {
			errorCode = binding.LastErrorCode
		}
		if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, errorCode, now); err != nil {
			return err
		}
		if _, err := c.reactivateLatestSources(ctx, binding.ID, now); err != nil {
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
		return c.discoverCodexPath(nativeID, "")
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

func (c *Collector) discoverCodexPath(nativeID, parentID string) string {
	if !nativeUsageIDPattern.MatchString(nativeID) {
		return ""
	}
	patterns := []string{
		filepath.Join(c.roots.CodexSessions, "*", "*", "*", "*"+nativeID+"*.jsonl"),
		filepath.Join(c.roots.CodexArchived, "*"+nativeID+"*.jsonl"),
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
			resolved, _, _, err := c.validateSourcePath(domain.HarnessCodex, path)
			if err != nil || !codexSessionMetaMatches(resolved, nativeID, parentID) {
				continue
			}
			if info, err := os.Stat(resolved); err == nil {
				matches = append(matches, candidate{path: resolved, mod: info.ModTime()})
			}
		}
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].mod.After(matches[j].mod) })
	if len(matches) == 0 {
		return ""
	}
	return matches[0].path
}

func codexSessionMetaMatches(path, nativeID, parentID string) bool {
	meta, ok := readCodexSessionMeta(path)
	if !ok || meta.NativeSessionID != nativeID {
		return false
	}
	return parentID == "" || meta.ParentThreadID == parentID
}

type codexSessionMeta struct {
	NativeSessionID string
	ParentThreadID  string
}

func readCodexSessionMeta(path string) (codexSessionMeta, bool) {
	file, err := os.Open(path) //nolint:gosec // candidate passed the provider-root boundary.
	if err != nil {
		return codexSessionMeta{}, false
	}
	defer func() { _ = file.Close() }()
	data, err := bufio.NewReaderSize(file, maxCodexSessionMeta+1).ReadSlice('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return codexSessionMeta{}, false
	}
	data = bytes.TrimSuffix(data, []byte{'\n'})
	data = bytes.TrimSuffix(data, []byte{'\r'})
	if len(data) > maxCodexSessionMeta {
		return codexSessionMeta{}, false
	}
	var envelope struct {
		Type    string `json:"type"`
		Payload struct {
			ID     string `json:"id"`
			Source struct {
				Subagent struct {
					ThreadSpawn struct {
						ParentThreadID string `json:"parent_thread_id"`
					} `json:"thread_spawn"`
				} `json:"subagent"`
			} `json:"source"`
		} `json:"payload"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Type != "session_meta" || envelope.Payload.ID == "" {
		return codexSessionMeta{}, false
	}
	return codexSessionMeta{
		NativeSessionID: envelope.Payload.ID,
		ParentThreadID:  envelope.Payload.Source.Subagent.ThreadSpawn.ParentThreadID,
	}, true
}

func validCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value && len(value) <= maxUsageMetadataBytes
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
