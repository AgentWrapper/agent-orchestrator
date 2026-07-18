package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

const (
	conversationSourceClaude      = "claude"
	conversationSourceCodex       = "codex"
	conversationSourceUnavailable = "unavailable"
	maxConversationBytes          = 8 << 20
	maxConversationEntries        = 240
	maxConversationTextRunes      = 16_000
	maxCodexWorkspaceCandidates   = 256
)

// ConversationEntry is one user-visible item from a provider's structured
// session log. Message entries form the chat transcript; update entries feed
// the compact, expandable activity row. Raw terminal bytes never enter this
// read model.
type ConversationEntry struct {
	ID        string `json:"id"`
	Role      string `json:"role" enum:"user,assistant"`
	Kind      string `json:"kind" enum:"message,update"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp,omitempty"`
}

// ConversationSnapshot is intentionally bounded so polling an active task is
// cheap even when its native provider log has grown very large.
type ConversationSnapshot struct {
	SessionID domain.SessionID    `json:"sessionId"`
	Source    string              `json:"source" enum:"claude,codex,unavailable"`
	Entries   []ConversationEntry `json:"entries"`
}

// Conversation reads the provider's structured, local conversation record.
// It performs no model or network call.
func (s *Service) Conversation(ctx context.Context, id domain.SessionID) (ConversationSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return ConversationSnapshot{}, err
	}
	if s.store == nil {
		return ConversationSnapshot{SessionID: id, Source: conversationSourceUnavailable, Entries: []ConversationEntry{}}, nil
	}
	rec, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return ConversationSnapshot{}, fmt.Errorf("conversation %s: get session: %w", id, err)
	}
	if !ok {
		return ConversationSnapshot{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}

	path, source := s.conversationPath(rec)
	if path == "" {
		return ConversationSnapshot{SessionID: id, Source: conversationSourceUnavailable, Entries: []ConversationEntry{}}, nil
	}
	entries, err := readConversationTail(path, source)
	if err != nil {
		if os.IsNotExist(err) {
			return ConversationSnapshot{SessionID: id, Source: conversationSourceUnavailable, Entries: []ConversationEntry{}}, nil
		}
		return ConversationSnapshot{}, fmt.Errorf("conversation %s: %w", id, err)
	}
	return ConversationSnapshot{SessionID: id, Source: source, Entries: entries}, nil
}

func (s *Service) conversationPath(rec domain.SessionRecord) (string, string) {
	nativeID := strings.TrimSpace(rec.Metadata.AgentSessionID)
	switch rec.Harness {
	case domain.HarnessClaudeCode:
		home := strings.TrimSpace(s.homeDir)
		if home == "" {
			var err error
			home, err = os.UserHomeDir()
			if err != nil {
				return "", conversationSourceUnavailable
			}
		}
		var matches []string
		if nativeID != "" && filepath.Base(nativeID) == nativeID {
			matches, _ = filepath.Glob(filepath.Join(home, ".claude", "projects", "*", nativeID+".jsonl"))
		}
		// Sessions created before native-id hook capture still have a stable,
		// dedicated AO workspace. Claude names its project directory by replacing
		// every non-alphanumeric path character with a dash; choose the newest
		// top-level transcript there (subagent logs live in child directories).
		if len(matches) == 0 && strings.TrimSpace(rec.Metadata.WorkspacePath) != "" {
			projectDir := claudeProjectDirectoryName(rec.Metadata.WorkspacePath)
			matches, _ = filepath.Glob(filepath.Join(home, ".claude", "projects", projectDir, "*.jsonl"))
		}
		return newestFile(matches), conversationSourceClaude
	case domain.HarnessCodex:
		roots := s.codexConversationRoots()
		if nativeID != "" && filepath.Base(nativeID) == nativeID {
			matches := codexRolloutMatches(roots, "rollout-*"+nativeID+".jsonl")
			if path := newestFile(matches); path != "" {
				return path, conversationSourceCodex
			}
		}
		// Codex 0.144+ writes rollouts to the user's normal ~/.codex/sessions
		// directory even when AO-owned caches and plugins live under codex-home.
		// Older AO sessions may also predate native-id capture. In both cases the
		// rollout records the stable AO worktree as session_meta.cwd.
		if workspace := strings.TrimSpace(rec.Metadata.WorkspacePath); workspace != "" {
			matches := codexRolloutMatches(roots, "rollout-*.jsonl")
			if path := newestCodexRolloutForWorkspace(matches, workspace); path != "" {
				return path, conversationSourceCodex
			}
		}
		return "", conversationSourceUnavailable
	default:
		return "", conversationSourceUnavailable
	}
}

func (s *Service) codexConversationRoots() []string {
	roots := make([]string, 0, 2)
	if dataDir := strings.TrimSpace(s.dataDir); dataDir != "" {
		roots = append(roots, filepath.Join(dataDir, "codex-home", "sessions"))
	}
	home := strings.TrimSpace(s.homeDir)
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		providerRoot := filepath.Join(home, ".codex", "sessions")
		if len(roots) == 0 || !sameWorkspacePath(roots[0], providerRoot) {
			roots = append(roots, providerRoot)
		}
	}
	return roots
}

func codexRolloutMatches(roots []string, pattern string) []string {
	var matches []string
	for _, root := range roots {
		found, _ := filepath.Glob(filepath.Join(root, "*", "*", "*", pattern))
		matches = append(matches, found...)
	}
	return matches
}

func claudeProjectDirectoryName(workspacePath string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return r
		}
		return '-'
	}, filepath.Clean(workspacePath))
}

func newestFile(paths []string) string {
	sort.Slice(paths, func(i, j int) bool {
		left, leftErr := os.Stat(paths[i])
		right, rightErr := os.Stat(paths[j])
		if leftErr != nil {
			return false
		}
		if rightErr != nil {
			return true
		}
		return left.ModTime().After(right.ModTime())
	})
	if len(paths) == 0 {
		return ""
	}
	return paths[0]
}

func newestCodexRolloutForWorkspace(paths []string, workspace string) string {
	sort.Slice(paths, func(i, j int) bool {
		left, leftErr := os.Stat(paths[i])
		right, rightErr := os.Stat(paths[j])
		if leftErr != nil {
			return false
		}
		if rightErr != nil {
			return true
		}
		return left.ModTime().After(right.ModTime())
	})
	if len(paths) > maxCodexWorkspaceCandidates {
		paths = paths[:maxCodexWorkspaceCandidates]
	}
	for _, path := range paths {
		cwd, err := codexRolloutWorkspace(path)
		if err == nil && sameWorkspacePath(cwd, workspace) {
			return path
		}
	}
	return ""
}

func codexRolloutWorkspace(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for line := 0; line < 32 && scanner.Scan(); line++ {
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				CWD string `json:"cwd"`
			} `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) == nil && record.Type == "session_meta" {
			return strings.TrimSpace(record.Payload.CWD), nil
		}
	}
	return "", scanner.Err()
}

func sameWorkspacePath(left, right string) bool {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if left == "" || right == "" {
		return false
	}
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	return left == right || (runtime.GOOS == "windows" && strings.EqualFold(left, right))
}

func readConversationTail(path, source string) ([]ConversationEntry, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - maxConversationBytes
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(file)
	if start > 0 {
		if _, err := reader.ReadString('\n'); err != nil && err != io.EOF {
			return nil, err
		}
	}

	entries := make([]ConversationEntry, 0, 64)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxConversationBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		var parsed []ConversationEntry
		switch source {
		case conversationSourceClaude:
			parsed = parseClaudeConversationLine(line)
		case conversationSourceCodex:
			parsed = parseCodexConversationLine(line)
		}
		for _, entry := range parsed {
			entries = appendConversationEntry(entries, entry)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(entries) > maxConversationEntries {
		entries = entries[len(entries)-maxConversationEntries:]
	}
	if entries == nil {
		entries = []ConversationEntry{}
	}
	return entries, nil
}

type claudeConversationRecord struct {
	Type      string          `json:"type"`
	UUID      string          `json:"uuid"`
	Timestamp string          `json:"timestamp"`
	IsMeta    bool            `json:"isMeta"`
	Message   json.RawMessage `json:"message"`
}

type claudeMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type claudeContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Name string `json:"name"`
}

func parseClaudeConversationLine(line []byte) []ConversationEntry {
	var record claudeConversationRecord
	if json.Unmarshal(line, &record) != nil || record.IsMeta || (record.Type != "user" && record.Type != "assistant") {
		return nil
	}
	var message claudeMessage
	if json.Unmarshal(record.Message, &message) != nil {
		return nil
	}
	id := strings.TrimSpace(record.UUID)
	if id == "" {
		id = "claude"
	}
	if record.Type == "user" && message.Role == "user" {
		var text string
		if json.Unmarshal(message.Content, &text) == nil {
			return []ConversationEntry{{ID: id, Role: "user", Kind: "message", Text: text, Timestamp: record.Timestamp}}
		}
		return nil
	}
	if record.Type != "assistant" || message.Role != "assistant" {
		return nil
	}
	var blocks []claudeContentBlock
	if json.Unmarshal(message.Content, &blocks) != nil {
		return nil
	}
	entries := make([]ConversationEntry, 0, len(blocks))
	for index, block := range blocks {
		switch block.Type {
		case "text":
			entries = append(entries, ConversationEntry{ID: fmt.Sprintf("%s:%d", id, index), Role: "assistant", Kind: "message", Text: block.Text, Timestamp: record.Timestamp})
		case "tool_use":
			entries = append(entries, ConversationEntry{ID: fmt.Sprintf("%s:%d", id, index), Role: "assistant", Kind: "update", Text: plainToolActivity(block.Name), Timestamp: record.Timestamp})
		}
	}
	return entries
}

type codexConversationRecord struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

type codexConversationPayload struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Phase   string `json:"phase"`
	Name    string `json:"name"`
	CallID  string `json:"call_id"`
	TurnID  string `json:"turn_id"`
}

func parseCodexConversationLine(line []byte) []ConversationEntry {
	var record codexConversationRecord
	if json.Unmarshal(line, &record) != nil {
		return nil
	}
	var payload codexConversationPayload
	if json.Unmarshal(record.Payload, &payload) != nil {
		return nil
	}
	id := strings.TrimSpace(payload.CallID)
	if id == "" {
		id = strings.TrimSpace(payload.TurnID)
	}
	if id == "" {
		id = record.Timestamp + ":" + payload.Type
	}
	switch record.Type {
	case "event_msg":
		switch payload.Type {
		case "user_message":
			return []ConversationEntry{{ID: id, Role: "user", Kind: "message", Text: payload.Message, Timestamp: record.Timestamp}}
		case "agent_message":
			kind := "message"
			if payload.Phase == "commentary" {
				kind = "update"
			}
			return []ConversationEntry{{ID: id, Role: "assistant", Kind: kind, Text: payload.Message, Timestamp: record.Timestamp}}
		case "agent_reasoning":
			return []ConversationEntry{{ID: id, Role: "assistant", Kind: "update", Text: payload.Message, Timestamp: record.Timestamp}}
		}
	case "response_item":
		if payload.Type == "function_call" || payload.Type == "custom_tool_call" {
			return []ConversationEntry{{ID: id, Role: "assistant", Kind: "update", Text: plainToolActivity(payload.Name), Timestamp: record.Timestamp}}
		}
	}
	return nil
}

func plainToolActivity(name string) string {
	clean := strings.TrimSpace(name)
	switch strings.ToLower(clean) {
	case "powershell", "bash", "shell", "shell_command", "exec_command":
		return "Running a command."
	case "read", "read_file", "view_image":
		return "Reading project files."
	case "edit", "write", "multiedit", "apply_patch":
		return "Updating project files."
	case "grep", "glob", "search", "rg":
		return "Searching the project."
	case "task", "agent", "spawn_agent", "send_message", "followup_task":
		return "Coordinating agent work."
	case "schedulewakeup", "wait", "wait_agent":
		return "Waiting for ongoing work."
	case "websearch", "webfetch", "web__run":
		return "Checking a source."
	case "request_user_input":
		return "Waiting for your input."
	case "":
		return "Working on the current task."
	default:
		return "Using the " + clean + " tool."
	}
}

func appendConversationEntry(entries []ConversationEntry, entry ConversationEntry) []ConversationEntry {
	entry.Text = strings.TrimSpace(entry.Text)
	if entry.Text == "" {
		return entries
	}
	entry.Text = truncateRunes(entry.Text, maxConversationTextRunes)
	if previous := len(entries) - 1; previous >= 0 {
		last := entries[previous]
		if last.Role == entry.Role && last.Kind == entry.Kind && last.Text == entry.Text {
			return entries
		}
	}
	return append(entries, entry)
}

func truncateRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit]) + "\n\n[Message shortened in this view. Open Terminal for the full record.]"
}
