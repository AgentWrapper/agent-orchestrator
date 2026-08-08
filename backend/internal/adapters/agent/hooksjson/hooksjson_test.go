package hooksjson

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReconcileHookMovesCommandToDeclaredMatcher(t *testing.T) {
	oldMatcher := "old"
	newMatcher := "new"
	managed := "ao hooks test session-start"
	userOld := HookEntry{Type: "command", Command: "user old", Timeout: 3}
	userNew := HookEntry{Type: "command", Command: "user new", Timeout: 4}
	updated := HookEntry{Type: "command", Command: managed, Timeout: 30}
	groups := []MatcherGroup{
		{Matcher: &oldMatcher, Hooks: []HookEntry{{Type: "command", Command: managed, Timeout: 5}, userOld}},
		{Matcher: &newMatcher, Hooks: []HookEntry{userNew}},
	}

	got := reconcileHook(groups, updated, &newMatcher)
	want := []MatcherGroup{
		{Matcher: &oldMatcher, Hooks: []HookEntry{userOld}},
		{Matcher: &newMatcher, Hooks: []HookEntry{userNew, updated}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reconcileHook()\nwant: %#v\n got: %#v", want, got)
	}
}

func TestReconcileHookDeduplicatesCommandAcrossGroups(t *testing.T) {
	firstMatcher := "first"
	targetMatcher := "target"
	managed := "ao hooks test session-start"
	user := HookEntry{Type: "command", Command: "user hook", Timeout: 7}
	updated := HookEntry{Type: "command", Command: managed, Timeout: 30}
	groups := []MatcherGroup{
		{Hooks: []HookEntry{{Type: "command", Command: managed, Timeout: 1}}},
		{Matcher: &firstMatcher, Hooks: []HookEntry{user, {Type: "command", Command: managed, Timeout: 2}}},
		{Matcher: &targetMatcher, Hooks: []HookEntry{{Type: "command", Command: managed, Timeout: 3}}},
	}

	got := reconcileHook(groups, updated, &targetMatcher)
	want := []MatcherGroup{
		{Matcher: &firstMatcher, Hooks: []HookEntry{user}},
		{Matcher: &targetMatcher, Hooks: []HookEntry{updated}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reconcileHook()\nwant: %#v\n got: %#v", want, got)
	}
}

func TestReconcileHookDropsGroupsEmptiedByMove(t *testing.T) {
	oldMatcher := "old"
	newMatcher := "new"
	managed := "ao hooks test session-start"
	updated := HookEntry{Type: "command", Command: managed, Timeout: 30}
	groups := []MatcherGroup{
		{Matcher: &oldMatcher, Hooks: []HookEntry{{Type: "command", Command: managed, Timeout: 5}}},
	}

	got := reconcileHook(groups, updated, &newMatcher)
	want := []MatcherGroup{
		{Matcher: &newMatcher, Hooks: []HookEntry{updated}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reconcileHook()\nwant: %#v\n got: %#v", want, got)
	}
}

func TestManagerPreservesUnknownUserHookFields(t *testing.T) {
	workspace := t.TempDir()
	hooksPath := filepath.Join(workspace, "hooks.json")
	original := []byte(`{
  "customTop": {"keep": true},
  "hooks": {
    "Notification": [{
      "matcher": "permission",
      "groupExtension": {"version": 2},
      "hooks": [{
        "type": "command",
        "command": "user hook",
        "timeout": 7,
        "async": true,
        "commandWindows": "user-hook.cmd",
        "command_windows": "legacy-user-hook.cmd",
        "future": {"enabled": true}
      }]
    }]
  }
}`)
	if err := os.WriteFile(hooksPath, original, 0o600); err != nil {
		t.Fatal(err)
	}

	manager := Manager{
		Label:         "test",
		CommandPrefix: "ao hooks test ",
		Timeout:       30,
		Path:          func(string) string { return hooksPath },
		Managed: []HookSpec{
			{Event: "Notification", Command: "ao hooks test notification"},
		},
	}
	if err := manager.Install(t.Context(), workspace); err != nil {
		t.Fatal(err)
	}
	assertUnknownUserHookFields(t, hooksPath)

	if err := manager.Uninstall(t.Context(), workspace); err != nil {
		t.Fatal(err)
	}
	assertUnknownUserHookFields(t, hooksPath)
}

func TestManagerPreservesManagedHookExtensionsOnReconcile(t *testing.T) {
	workspace := t.TempDir()
	hooksPath := filepath.Join(workspace, "hooks.json")
	original := []byte(`{
  "hooks": {
    "Notification": [{
      "groupExtension": "keep",
      "hooks": [{
        "type": "command",
        "command": "ao hooks test notification",
        "timeout": 7,
        "async": true,
        "commandWindows": "ao-hooks.cmd"
      }]
    }]
  }
}`)
	if err := os.WriteFile(hooksPath, original, 0o600); err != nil {
		t.Fatal(err)
	}

	manager := Manager{
		Label:         "test",
		CommandPrefix: "ao hooks test ",
		Timeout:       30,
		Path:          func(string) string { return hooksPath },
		Managed: []HookSpec{
			{Event: "Notification", Command: "ao hooks test notification"},
		},
	}
	if err := manager.Install(t.Context(), workspace); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	group := settings["hooks"].(map[string]any)["Notification"].([]any)[0].(map[string]any)
	if group["groupExtension"] != "keep" {
		t.Fatalf("group extension changed: %#v", group["groupExtension"])
	}
	hook := group["hooks"].([]any)[0].(map[string]any)
	if hook["timeout"] != float64(30) || hook["async"] != true || hook["commandWindows"] != "ao-hooks.cmd" {
		t.Fatalf("managed hook fields = %#v", hook)
	}
}

func assertUnknownUserHookFields(t *testing.T, hooksPath string) {
	t.Helper()
	data, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(settings["customTop"], map[string]any{"keep": true}) {
		t.Fatalf("top-level extension changed: %#v", settings["customTop"])
	}
	hooks := settings["hooks"].(map[string]any)
	groups := hooks["Notification"].([]any)
	userGroup := groups[0].(map[string]any)
	if !reflect.DeepEqual(userGroup["groupExtension"], map[string]any{"version": float64(2)}) {
		t.Fatalf("matcher-group extension changed: %#v", userGroup["groupExtension"])
	}
	userHook := userGroup["hooks"].([]any)[0].(map[string]any)
	want := map[string]any{
		"type":            "command",
		"command":         "user hook",
		"timeout":         float64(7),
		"async":           true,
		"commandWindows":  "user-hook.cmd",
		"command_windows": "legacy-user-hook.cmd",
		"future":          map[string]any{"enabled": true},
	}
	if !reflect.DeepEqual(userHook, want) {
		t.Fatalf("user hook fields changed\nwant: %#v\n got: %#v", want, userHook)
	}
}
