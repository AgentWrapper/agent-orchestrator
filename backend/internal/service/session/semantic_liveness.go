package session

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	maxSemanticBytes   = 2 << 20
	maxSemanticActions = 40
	minSemanticActions = 8
	highSemanticTokens = 50_000
)

type semanticActionKind uint8

const (
	semanticActionOther semanticActionKind = iota
	semanticActionMutation
	semanticActionVerification
)

type semanticAction struct {
	fingerprint string
	kind        semanticActionKind
}

type semanticTrace struct {
	actions        []semanticAction
	observedTokens int64
	codexBase      int64
	codexSeen      bool
}

type semanticCacheEntry struct {
	size       int64
	modTime    time.Time
	warning    domain.SemanticLiveness
	hasWarning bool
}

var (
	semanticVerificationRE = regexp.MustCompile(`(?i)(?:^|[;&|\s])(?:go\s+(?:test|build)|pytest\b|py\s+-m\s+pytest|npm(?:\s+run)?\s+(?:test|build)|pnpm(?:\s+run)?\s+(?:test|build)|yarn(?:\s+run)?\s+(?:test|build)|cargo\s+(?:test|build)|dotnet\s+(?:test|build)|ctest\b|vitest\b|jest\b|cmake\s+--build|msbuild\b|build\.bat\b|runuat\b|automationtool\b)`)
	semanticMutationRE     = regexp.MustCompile(`(?i)(?:apply_patch|git\s+apply|set-content|add-content|out-file|sed\s+-i|perl\s+-pi)`)
	semanticPatchTargetRE  = regexp.MustCompile(`(?m)^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$`)
)

// semanticLiveness derives an advisory only for a live worker. A failure to
// inspect provider state never degrades the canonical session read path.
func (s *Service) semanticLiveness(rec domain.SessionRecord) *domain.SemanticLiveness {
	if rec.Kind != domain.KindWorker || rec.IsTerminated || rec.Activity.State != domain.ActivityActive {
		return nil
	}
	path, source := s.conversationPath(rec)
	if path == "" || source == conversationSourceUnavailable {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}

	s.semanticMu.Lock()
	if cached, ok := s.semanticCache[path]; ok && cached.size == info.Size() && cached.modTime.Equal(info.ModTime()) {
		s.semanticMu.Unlock()
		return copySemanticWarning(cached.warning, cached.hasWarning)
	}
	s.semanticMu.Unlock()

	trace, err := readSemanticTail(path, source)
	if err != nil {
		return nil
	}
	warning, hasWarning := analyzeSemanticTrace(trace)

	s.semanticMu.Lock()
	if s.semanticCache == nil {
		s.semanticCache = make(map[string]semanticCacheEntry)
	}
	s.semanticCache[path] = semanticCacheEntry{size: info.Size(), modTime: info.ModTime(), warning: warning, hasWarning: hasWarning}
	s.semanticMu.Unlock()
	return copySemanticWarning(warning, hasWarning)
}

func copySemanticWarning(warning domain.SemanticLiveness, ok bool) *domain.SemanticLiveness {
	if !ok {
		return nil
	}
	copy := warning
	return &copy
}

func readSemanticTail(path, source string) (semanticTrace, error) {
	file, err := os.Open(path)
	if err != nil {
		return semanticTrace{}, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return semanticTrace{}, err
	}
	start := info.Size() - maxSemanticBytes
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return semanticTrace{}, err
	}
	reader := bufio.NewReader(file)
	if start > 0 {
		if _, err := reader.ReadString('\n'); err != nil && err != io.EOF {
			return semanticTrace{}, err
		}
	}

	trace := semanticTrace{}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	for scanner.Scan() {
		switch source {
		case conversationSourceClaude:
			parseClaudeSemanticLine(scanner.Bytes(), &trace)
		case conversationSourceCodex:
			parseCodexSemanticLine(scanner.Bytes(), &trace)
		}
	}
	return trace, scanner.Err()
}

func (t *semanticTrace) reset() {
	t.actions = nil
	t.observedTokens = 0
	t.codexBase = 0
	t.codexSeen = false
}

func (t *semanticTrace) append(action semanticAction) {
	t.actions = append(t.actions, action)
	if len(t.actions) > maxSemanticActions {
		t.actions = t.actions[len(t.actions)-maxSemanticActions:]
	}
}

type claudeSemanticMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Usage   struct {
		InputTokens         int64 `json:"input_tokens"`
		CacheCreationTokens int64 `json:"cache_creation_input_tokens"`
		CacheReadTokens     int64 `json:"cache_read_input_tokens"`
		OutputTokens        int64 `json:"output_tokens"`
	} `json:"usage"`
}

type claudeSemanticBlock struct {
	Type  string          `json:"type"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

func parseClaudeSemanticLine(line []byte, trace *semanticTrace) {
	var record claudeConversationRecord
	if json.Unmarshal(line, &record) != nil || record.IsMeta {
		return
	}
	var message claudeSemanticMessage
	if json.Unmarshal(record.Message, &message) != nil {
		return
	}
	if record.Type == "user" && message.Role == "user" {
		var prompt string
		if json.Unmarshal(message.Content, &prompt) == nil && strings.TrimSpace(prompt) != "" {
			trace.reset()
		}
		return
	}
	if record.Type != "assistant" || message.Role != "assistant" {
		return
	}
	trace.observedTokens += message.Usage.InputTokens + message.Usage.CacheCreationTokens + message.Usage.CacheReadTokens + message.Usage.OutputTokens
	var blocks []claudeSemanticBlock
	if json.Unmarshal(message.Content, &blocks) != nil {
		return
	}
	for _, block := range blocks {
		if block.Type == "tool_use" {
			if action, ok := newSemanticAction(block.Name, block.Input); ok {
				trace.append(action)
			}
		}
	}
}

type codexSemanticPayload struct {
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	Arguments json.RawMessage `json:"arguments"`
	Info      struct {
		Total struct {
			TotalTokens int64 `json:"total_tokens"`
		} `json:"total_token_usage"`
		Last struct {
			TotalTokens int64 `json:"total_tokens"`
		} `json:"last_token_usage"`
	} `json:"info"`
}

func parseCodexSemanticLine(line []byte, trace *semanticTrace) {
	var record codexConversationRecord
	if json.Unmarshal(line, &record) != nil {
		return
	}
	var payload codexSemanticPayload
	if json.Unmarshal(record.Payload, &payload) != nil {
		return
	}
	if record.Type == "event_msg" {
		switch payload.Type {
		case "user_message", "task_started":
			trace.reset()
		case "token_count":
			total := payload.Info.Total.TotalTokens
			if !trace.codexSeen {
				trace.codexBase = total
				trace.codexSeen = true
			}
			delta := total - trace.codexBase
			if delta < 0 {
				delta = 0
			}
			if payload.Info.Last.TotalTokens > delta {
				delta = payload.Info.Last.TotalTokens
			}
			trace.observedTokens = delta
		}
		return
	}
	if record.Type != "response_item" || (payload.Type != "function_call" && payload.Type != "custom_tool_call") {
		return
	}
	raw := payload.Input
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		raw = payload.Arguments
	}
	if action, ok := newSemanticAction(payload.Name, raw); ok {
		trace.append(action)
	}
}

func newSemanticAction(toolName string, raw json.RawMessage) (semanticAction, bool) {
	tool := semanticToolBase(toolName)
	if tool == "" || isSemanticNoiseTool(tool) {
		return semanticAction{}, false
	}
	canonical, command, target := normalizeSemanticInput(raw)
	kind := semanticActionOther
	if isMutationTool(tool) || semanticMutationRE.MatchString(command) {
		kind = semanticActionMutation
	} else if isShellTool(tool) && semanticVerificationRE.MatchString(command) {
		kind = semanticActionVerification
	}
	identity := canonical
	if command != "" {
		identity = strings.ToLower(strings.Join(strings.Fields(command), " "))
	}
	if kind == semanticActionMutation && target != "" {
		identity = strings.ToLower(strings.TrimSpace(target))
	}
	sum := sha256.Sum256([]byte(tool + "\x00" + identity))
	return semanticAction{fingerprint: string(sum[:]), kind: kind}, true
}

func semanticToolBase(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if index := strings.LastIndexAny(name, "./"); index >= 0 {
		name = name[index+1:]
	}
	return name
}

func isSemanticNoiseTool(tool string) bool {
	switch tool {
	case "wait", "wait_agent", "schedulewakeup", "request_user_input", "yield_control":
		return true
	default:
		return false
	}
}

func isMutationTool(tool string) bool {
	switch tool {
	case "edit", "write", "multiedit", "apply_patch", "write_file", "create_file":
		return true
	default:
		return false
	}
}

func isShellTool(tool string) bool {
	switch tool {
	case "powershell", "bash", "shell", "shell_command", "exec_command", "exec":
		return true
	default:
		return false
	}
}

func normalizeSemanticInput(raw json.RawMessage) (canonical, command, target string) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", "", ""
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return strings.TrimSpace(string(raw)), "", ""
	}
	if encoded, ok := value.(string); ok {
		var nested any
		if json.Unmarshal([]byte(encoded), &nested) == nil {
			value = nested
		} else {
			command = encoded
		}
	}
	if object, ok := value.(map[string]any); ok {
		command = firstSemanticString(object, "command", "cmd", "script")
		target = firstSemanticString(object, "file_path", "filePath", "path")
		if target == "" {
			patch := firstSemanticString(object, "patch")
			if match := semanticPatchTargetRE.FindStringSubmatch(patch); len(match) == 2 {
				target = match[1]
			}
		}
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return strings.TrimSpace(string(raw)), command, target
	}
	return string(encoded), command, target
}

func firstSemanticString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := object[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func analyzeSemanticTrace(trace semanticTrace) (domain.SemanticLiveness, bool) {
	actions := trace.actions
	if len(actions) < minSemanticActions {
		return domain.SemanticLiveness{}, false
	}
	unique := make(map[string]struct{}, len(actions))
	maxStreak, streak := 1, 1
	for index, action := range actions {
		unique[action.fingerprint] = struct{}{}
		if index > 0 && action.fingerprint == actions[index-1].fingerprint {
			streak++
			if streak > maxStreak {
				maxStreak = streak
			}
		} else {
			streak = 1
		}
	}
	novelty := len(unique) * 100 / len(actions)
	duplicates := len(actions) - len(unique)
	alternating := semanticAlternatingLoop(actions)
	repeatedVerification := semanticRepeatedVerification(actions)

	score := 0
	if novelty <= 55 && duplicates >= 4 {
		score += 25
	}
	if novelty <= 35 && duplicates >= 6 {
		score += 20
	}
	if maxStreak >= 3 {
		score += 30
		if maxStreak >= 5 {
			score += 15
		}
	}
	if alternating {
		score += 45
	}
	if repeatedVerification >= 2 {
		score += 45
		if repeatedVerification >= 3 {
			score += 15
		}
	}
	if trace.observedTokens >= highSemanticTokens && score >= 25 {
		score += 15
	}
	if score > 100 {
		score = 100
	}
	if score < 40 {
		return domain.SemanticLiveness{}, false
	}

	state := "watch"
	suggestedAction := "inspect"
	if score >= 70 {
		state = "thrashing"
		suggestedAction = "fresh_context_restart"
	}
	summary := "Recent work has very low action novelty."
	switch {
	case repeatedVerification >= 2 && trace.observedTokens >= highSemanticTokens:
		summary = "Repeated verification without edits, with high token use."
	case repeatedVerification >= 2:
		summary = "Repeated verification runs without a file change."
	case alternating:
		summary = "Recent actions are alternating in a loop."
	case maxStreak >= 3:
		summary = "The same action is repeating without progress."
	}
	return domain.SemanticLiveness{
		State:           state,
		RiskScore:       score,
		ObservedActions: len(actions),
		ObservedTokens:  trace.observedTokens,
		Summary:         summary,
		SuggestedAction: suggestedAction,
	}, true
}

func semanticRepeatedVerification(actions []semanticAction) int {
	mutationVersion := 0
	lastVersion := make(map[string]int)
	repeats := 0
	for _, action := range actions {
		if action.kind == semanticActionMutation {
			mutationVersion++
			continue
		}
		if action.kind != semanticActionVerification {
			continue
		}
		if previous, ok := lastVersion[action.fingerprint]; ok && previous == mutationVersion {
			repeats++
		}
		lastVersion[action.fingerprint] = mutationVersion
	}
	return repeats
}

func semanticAlternatingLoop(actions []semanticAction) bool {
	for index := 0; index+5 < len(actions); index++ {
		left, right := actions[index], actions[index+1]
		if left.fingerprint == right.fingerprint {
			continue
		}
		if left.fingerprint != actions[index+2].fingerprint || left.fingerprint != actions[index+4].fingerprint ||
			right.fingerprint != actions[index+3].fingerprint || right.fingerprint != actions[index+5].fingerprint {
			continue
		}
		if left.kind == semanticActionMutation && right.kind == semanticActionMutation {
			return true
		}
		hasMutation := false
		for _, action := range actions[index : index+6] {
			if action.kind == semanticActionMutation {
				hasMutation = true
				break
			}
		}
		if !hasMutation {
			return true
		}
	}
	return false
}
