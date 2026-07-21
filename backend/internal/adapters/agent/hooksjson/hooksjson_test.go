package hooksjson

import (
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
