package usage

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const sourceIdentityRecordBytes = 64 << 10
const (
	maxUsageMetadataBytes = 256
	maxUsagePathBytes     = 4096
)

var nativeUsageIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// HookSignal is the usage-specific metadata carried by an AO agent hook.
type HookSignal struct {
	Harness                domain.AgentHarness
	Event                  string
	NativeSessionID        string
	ModelID                string
	TranscriptPath         string
	SubagentID             string
	SubagentTranscriptPath string
	SourceCLIVersion       string
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
	ListUsageBindingsForSession(context.Context, domain.SessionID) ([]domain.UsageBindingRecord, error)
	UpdateUsageBindingState(context.Context, int64, domain.UsageBindingState, string, time.Time) (bool, error)
	InsertUsageSource(context.Context, domain.UsageSourceRecord) (domain.UsageSourceRecord, error)
	ListUsageSourcesForBinding(context.Context, int64) ([]domain.UsageSourceRecord, error)
	MarkUsageSourceState(context.Context, int64, domain.UsageSourceState, string, *time.Time, time.Time) (bool, error)
	ReactivateUsageSource(context.Context, int64, time.Time) (bool, error)
}

// Collector registers provider transcript files and coordinates their source
// lifecycle. Parsing remains in the observer package.
type Collector struct {
	store collectorStore
	roots SourceRoots
	wake  func()
	now   func() time.Time
}

// NewCollector constructs a transcript source registrar.
func NewCollector(store collectorStore, roots SourceRoots, wake func()) *Collector {
	return &Collector{store: store, roots: roots, wake: wake, now: time.Now}
}

// RecordHook registers transcript metadata and updates collection lifecycle for
// one native hook callback.
func (c *Collector) RecordHook(ctx context.Context, sessionID domain.SessionID, signal HookSignal) error {
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
		c.notify()
		return nil
	}

	state := domain.UsageBindingActive
	if signal.Event == "session-end" || signal.Event == "process-exited" {
		state = domain.UsageBindingFinalizing
	}
	binding, err := c.store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:        sessionID,
		Harness:          session.Harness,
		NativeRootID:     signal.NativeSessionID,
		InitialModelID:   boundedUsageMetadata(signal.ModelID),
		SourceCLIVersion: boundedUsageMetadata(signal.SourceCLIVersion),
		State:            state,
		FirstSeenAt:      now,
		LastSeenAt:       now,
		UpdatedAt:        now,
	})
	if err != nil {
		return err
	}

	if path := strings.TrimSpace(signal.TranscriptPath); path != "" {
		kind := domain.UsageSourceClaudeMain
		if session.Harness == domain.HarnessCodex {
			kind = domain.UsageSourceCodexRollout
		}
		if err := c.registerSource(ctx, binding, kind, signal.NativeSessionID, "", path, signal.ModelID, now); err != nil {
			return err
		}
	}
	if path := strings.TrimSpace(signal.SubagentTranscriptPath); path != "" && session.Harness == domain.HarnessClaudeCode {
		if err := c.registerSource(ctx, binding, domain.UsageSourceClaudeSubagent, signal.NativeSessionID, boundedUsageMetadata(signal.SubagentID), path, signal.ModelID, now); err != nil {
			return err
		}
	}
	if signal.Event == "session-start" {
		if err := c.reactivateBinding(ctx, binding, now); err != nil {
			return err
		}
	}
	c.notify()
	return nil
}

// BackfillActive discovers transcript files only for live/resumable AO
// sessions. It deliberately does not import terminated session history.
func (c *Collector) BackfillActive(ctx context.Context) error {
	sessions, err := c.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, session := range sessions {
		if session.IsTerminated || !SupportedHarness(session.Harness) {
			continue
		}
		nativeID := strings.TrimSpace(session.Metadata.AgentSessionID)
		if nativeID == "" || !nativeUsageIDPattern.MatchString(nativeID) {
			continue
		}
		path := c.discoverPath(session.Harness, nativeID)
		if path == "" {
			now := c.now().UTC()
			_, err := c.store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
				SessionID:     session.ID,
				Harness:       session.Harness,
				NativeRootID:  nativeID,
				State:         domain.UsageBindingDiscovering,
				LastErrorCode: domain.UsageErrorSourceDiscoveryPending,
				FirstSeenAt:   now,
				LastSeenAt:    now,
				UpdatedAt:     now,
			})
			if err != nil {
				errs = append(errs, err)
			}
			continue
		}
		if err := c.RecordHook(ctx, session.ID, HookSignal{
			Harness:         session.Harness,
			Event:           "session-start",
			NativeSessionID: nativeID,
			TranscriptPath:  path,
		}); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (c *Collector) registerSource(
	ctx context.Context,
	binding domain.UsageBindingRecord,
	kind domain.UsageSourceKind,
	nativeSessionID string,
	subagentID string,
	path string,
	modelID string,
	now time.Time,
) error {
	resolved, identity, size, err := c.validateSourcePath(binding.Harness, path)
	if err != nil {
		return err
	}
	sources, err := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		return err
	}
	var latest *domain.UsageSourceRecord
	var identityMatch *domain.UsageSourceRecord
	var generation int64
	for i := range sources {
		source := &sources[i]
		if source.Generation >= generation {
			generation = source.Generation
		}
		if source.ArtifactPath == resolved && (latest == nil || source.Generation > latest.Generation) {
			latest = source
		}
		if source.FileIdentity == identity && size >= source.ByteOffset &&
			(identityMatch == nil || source.Generation > identityMatch.Generation) {
			identityMatch = source
		}
	}
	if latest != nil && latest.FileIdentity == identity && size >= latest.ByteOffset {
		_, err := c.store.ReactivateUsageSource(ctx, latest.ID, now)
		return err
	}
	if latest != nil {
		_, _ = c.store.MarkUsageSourceState(ctx, latest.ID, domain.UsageSourceComplete, domain.UsageErrorArtifactReplaced, nil, now)
		generation = latest.Generation + 1
	} else if len(sources) > 0 {
		generation++
	}
	capability := CapabilityFor(binding.Harness)
	record := domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            kind,
		NativeSessionID: nativeSessionID,
		SubagentID:      subagentID,
		ArtifactPath:    resolved,
		FileIdentity:    identity,
		Generation:      generation,
		CurrentModelID:  boundedUsageMetadata(modelID),
		ParserVersion:   capability.ParserVersion,
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if latest == nil && identityMatch != nil {
		_, _ = c.store.MarkUsageSourceState(ctx, identityMatch.ID, domain.UsageSourceComplete, "", nil, now)
		record.ByteOffset = identityMatch.ByteOffset
		record.BaselineInputTokens = identityMatch.BaselineInputTokens
		record.BaselineCachedInputTokens = identityMatch.BaselineCachedInputTokens
		record.BaselineCacheWriteTokens = identityMatch.BaselineCacheWriteTokens
		record.BaselineOutputTokens = identityMatch.BaselineOutputTokens
		record.BaselineReasoningTokens = identityMatch.BaselineReasoningTokens
		record.CurrentModelID = firstString(boundedUsageMetadata(modelID), identityMatch.CurrentModelID)
		record.CurrentProvider = identityMatch.CurrentProvider
	}
	_, err = c.store.InsertUsageSource(ctx, record)
	return err
}

func (c *Collector) reactivateBinding(ctx context.Context, binding domain.UsageBindingRecord, now time.Time) error {
	if _, err := c.store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingActive, "", now); err != nil {
		return err
	}
	sources, err := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
	if err != nil {
		return err
	}
	for _, source := range sources {
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
		sources, err := c.store.ListUsageSourcesForBinding(ctx, binding.ID)
		if err != nil {
			return err
		}
		for _, source := range sources {
			if _, err := c.store.ReactivateUsageSource(ctx, source.ID, now); err != nil {
				return err
			}
		}
	}
	c.notify()
	return nil
}

func (c *Collector) validateSourcePath(harness domain.AgentHarness, path string) (string, string, int64, error) {
	if len(path) > maxUsagePathBytes {
		return "", "", 0, errors.New(domain.UsageErrorArtifactPathRejected)
	}
	if !filepath.IsAbs(path) || strings.ToLower(filepath.Ext(path)) != ".jsonl" {
		return "", "", 0, fmt.Errorf("%s: %w", path, errors.New(domain.UsageErrorArtifactPathRejected))
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", "", 0, fmt.Errorf("%s: %w", path, err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", 0, fmt.Errorf("%s: %w", path, errors.New(domain.UsageErrorArtifactMissing))
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
		return "", "", 0, fmt.Errorf("%s: %w", path, errors.New(domain.UsageErrorArtifactPathRejected))
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

func (c *Collector) notify() {
	if c.wake != nil {
		c.wake()
	}
}

func nativeIDFromTranscript(path string) string {
	base := strings.TrimSuffix(filepath.Base(strings.TrimSpace(path)), filepath.Ext(path))
	if nativeUsageIDPattern.MatchString(base) {
		return base
	}
	return ""
}

func firstString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
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

// SourceIdentity returns a stable identity for an append-only transcript. The
// provider's first record contains native session metadata and does not change
// as later records are appended.
func SourceIdentity(path string) (string, error) {
	file, err := os.Open(path) //nolint:gosec // validated provider-owned path.
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	reader := bufio.NewReaderSize(file, sourceIdentityRecordBytes)
	first, err := reader.ReadSlice('\n')
	if err != nil && !errors.Is(err, bufio.ErrBufferFull) && !errors.Is(err, io.EOF) {
		if len(first) == 0 {
			return "", err
		}
	}
	return fmt.Sprintf("sha256:%x", sha256.Sum256(first)), nil
}
