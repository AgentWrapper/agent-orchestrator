package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	capabilityClassEnv = "AO_CAPABILITY_CLASS"
	capabilityAuditLog = "capability-audit.jsonl"
	maxPolicyTargetLen = 2048
)

var (
	verificationCommand = regexp.MustCompile(`(?i)(^|[;&|]\s*)(go\s+(test|vet|build)\b|golangci-lint\b|cargo\s+(test|check|build)\b|pytest\b|python\s+-m\s+pytest\b|npm\s+(test|run\s+(test|lint|build|typecheck))\b|pnpm\s+(test|lint|build|typecheck)\b|yarn\s+(test|lint|build|typecheck)\b|bun\s+(test|run\s+(test|lint|build|typecheck))\b|make\s+(test|check|lint|build)\b)`)
	writeCommand        = regexp.MustCompile(`(?i)(^|[;&|]\s*)(apply_patch\b|patch\b|git\s+apply\b|sed\s+[^;&|]*\s-i(?:\s|$)|perl\s+[^;&|]*\s-pi(?:\s|$)|tee\b|touch\b|mkdir\b|rmdir\b|rm\b|mv\b|cp\b|truncate\b|chmod\b|chown\b)`)
	commitCommand       = regexp.MustCompile(`(?i)(^|[;&|]\s*)git\s+commit\b`)
	pushCommand         = regexp.MustCompile(`(?i)(^|[;&|]\s*)git\s+push\b`)
	claimPRCommand      = regexp.MustCompile(`(?i)(^|[;&|]\s*)(ao\s+session\s+claim-pr\b|gh\s+pr\s+(create|checkout|edit|ready|reopen|close|merge)\b)`)
	worktreeCommand     = regexp.MustCompile(`(?i)(^|[;&|]\s*)git\s+worktree\s+(add|move|remove|lock|unlock|prune|repair)\b`)
)

type policyToolPayload struct {
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	Input     json.RawMessage `json:"input"`
	Arguments json.RawMessage `json:"arguments"`
}

type policyDenial struct {
	ActorSession string                          `json:"actor_session"`
	ActorClass   domain.CapabilityClass          `json:"actor_class"`
	Capability   domain.ImplementationCapability `json:"capability"`
	Target       string                          `json:"target"`
	PolicyReason string                          `json:"policy_reason"`
	OccurredAt   time.Time                       `json:"occurred_at"`
}

type preToolUseDenyOutput struct {
	HookSpecificOutput struct {
		HookEventName            string `json:"hookEventName"`
		PermissionDecision       string `json:"permissionDecision"`
		PermissionDecisionReason string `json:"permissionDecisionReason"`
	} `json:"hookSpecificOutput"`
}

// enforceCapabilityHook handles the enforcement-bearing Codex PreToolUse
// callback. It returns true when the tool must not continue. The outer hook
// path then skips its best-effort activity behavior so policy enforcement
// never depends on daemon availability.
func (c *commandContext) enforceCapabilityHook(agent, event, sessionID string, payload []byte) bool {
	if agent != "codex" || event != "pre-tool-use" {
		return false
	}
	class := domain.CapabilityClass(strings.TrimSpace(os.Getenv(capabilityClassEnv)))
	if class == "" || class.AllowsImplementation() {
		return false
	}
	capability, target, denied := classifyImplementationTool(payload)
	if !denied {
		return false
	}

	record := policyDenial{
		ActorSession: sessionID,
		ActorClass:   class,
		Capability:   capability,
		Target:       target,
		PolicyReason: domain.IndependentWorkerPolicyReason,
		OccurredAt:   time.Now().UTC(),
	}
	if err := appendCapabilityAudit(record); err != nil {
		c.reportHookFailure(agent, event, sessionID, fmt.Errorf("record capability denial: %w", err))
	}
	var out preToolUseDenyOutput
	out.HookSpecificOutput.HookEventName = "PreToolUse"
	out.HookSpecificOutput.PermissionDecision = "deny"
	out.HookSpecificOutput.PermissionDecisionReason = domain.IndependentWorkerPolicyReason
	if err := json.NewEncoder(c.deps.Out).Encode(out); err != nil {
		c.reportHookFailure(agent, event, sessionID, fmt.Errorf("write capability denial: %w", err))
	}
	return true
}

func classifyImplementationTool(payload []byte) (domain.ImplementationCapability, string, bool) {
	var p policyToolPayload
	if json.Unmarshal(payload, &p) != nil {
		return "", "", false
	}
	tool := strings.TrimSpace(p.ToolName)
	target := extractPolicyTarget(p)
	toolKey := strings.ToLower(tool)
	if strings.Contains(toolKey, "spawn_agent") || strings.Contains(toolKey, "collaboration") || strings.Contains(toolKey, "delegate") {
		return domain.CapabilityWritableWorktree, boundedPolicyTarget(tool), true
	}
	if strings.Contains(toolKey, "apply_patch") || strings.Contains(toolKey, "write") || strings.Contains(toolKey, "edit") {
		return domain.CapabilityRepositoryEdit, boundedPolicyTarget(targetOrTool(target, tool)), true
	}
	if commitCommand.MatchString(target) {
		return domain.CapabilityCommit, boundedPolicyTarget(target), true
	}
	if pushCommand.MatchString(target) {
		return domain.CapabilityPush, boundedPolicyTarget(target), true
	}
	if claimPRCommand.MatchString(target) {
		return domain.CapabilityClaimPR, boundedPolicyTarget(target), true
	}
	if worktreeCommand.MatchString(target) {
		return domain.CapabilityWritableWorktree, boundedPolicyTarget(target), true
	}
	if verificationCommand.MatchString(target) {
		return domain.CapabilityImplementationVerification, boundedPolicyTarget(target), true
	}
	if writeCommand.MatchString(target) {
		return domain.CapabilityRepositoryEdit, boundedPolicyTarget(target), true
	}
	return "", "", false
}

func extractPolicyTarget(p policyToolPayload) string {
	for _, raw := range []json.RawMessage{p.ToolInput, p.Input, p.Arguments} {
		if len(raw) == 0 {
			continue
		}
		var fields map[string]any
		if json.Unmarshal(raw, &fields) == nil {
			for _, key := range []string{"cmd", "command", "path", "target", "message", "prompt"} {
				if value, ok := fields[key].(string); ok && strings.TrimSpace(value) != "" {
					return value
				}
			}
		}
	}
	return p.ToolName
}

func targetOrTool(target, tool string) string {
	if strings.TrimSpace(target) != "" {
		return target
	}
	return tool
}

func boundedPolicyTarget(target string) string {
	target = strings.TrimSpace(target)
	if len(target) > maxPolicyTargetLen {
		return target[:maxPolicyTargetLen]
	}
	return target
}

func appendCapabilityAudit(record policyDenial) error {
	dataDir := strings.TrimSpace(os.Getenv("AO_DATA_DIR"))
	if dataDir == "" {
		return fmt.Errorf("AO_DATA_DIR is empty")
	}
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dataDir, capabilityAuditLog), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) //nolint:gosec // AO_DATA_DIR is daemon-owned session state.
	if err != nil {
		return err
	}
	if err := json.NewEncoder(f).Encode(record); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
