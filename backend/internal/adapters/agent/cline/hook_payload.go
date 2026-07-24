package cline

import (
	"encoding/json"
	"strings"
)

const maxHookSessionIDLen = 256

// SessionIDFromHook returns the native task id Cline includes at the top level
// of every hook payload. That id is the value accepted by `cline --id` when AO
// later restores the task.
func SessionIDFromHook(payload []byte) (string, bool) {
	var input struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(payload, &input); err != nil {
		return "", false
	}
	id := strings.TrimSpace(input.TaskID)
	if id == "" || len(id) > maxHookSessionIDLen {
		return "", false
	}
	return id, true
}
