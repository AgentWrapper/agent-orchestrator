package project_test

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	project "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

// The clobbering write (issue #298, R3 / decision D1).
//
// PUT /projects/{id}/config is a whole-object replace. The Settings form snapshots
// the config once at mount and PUTs that snapshot back, so anything another writer
// changed in between — the orchestrator, `ao project set-config`, the config-as-code
// restore, a second tab — is silently reverted. This is the scenario, end to end.

func TestSetConfigRejectsAWriteBuiltOnAStaleRead(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	// T0: the operator opens Settings. The form snapshots the config and its token.
	opened, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	staleToken := opened.Project.ConfigETag
	if staleToken == "" {
		t.Fatal("a read must return a config token, or a client cannot prove freshness")
	}
	snapshot := *opened.Project.Config

	// T1: someone else writes. Here: the config-as-code restore path flips
	// autonomousMerge on. The operator's open form knows nothing about it.
	concurrent := snapshot
	concurrent.AutonomousMerge = true
	if _, err := m.SetConfig(ctx, "ao", project.SetConfigInput{Config: concurrent}); err != nil {
		t.Fatalf("concurrent write: %v", err)
	}

	// T2: the operator edits ONE unrelated field and saves, carrying the T0 base.
	edited := snapshot
	edited.DefaultBranch = "develop"

	_, err = m.SetConfig(ctx, "ao", project.SetConfigInput{Config: edited, IfMatch: staleToken})
	wantCode(t, err, "PROJECT_CONFIG_STALE")

	// And the concurrent writer's field survived. Without the check, the operator's
	// snapshot would have replaced the whole config and turned autonomousMerge back
	// off — a merge-authority bit, silently reverted by an unrelated branch edit.
	after, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get after rejected write: %v", err)
	}
	if !after.Project.Config.AutonomousMerge {
		t.Fatal("the concurrent writer's autonomousMerge was clobbered by a stale save")
	}
	if after.Project.Config.DefaultBranch == "develop" {
		t.Fatal("the stale write must not have been applied at all")
	}
}

func TestSetConfigAcceptsAWriteBuiltOnTheCurrentRead(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	got, err := m.Get(ctx, "ao")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	edited := *got.Project.Config
	edited.DefaultBranch = "develop"

	updated, err := m.SetConfig(ctx, "ao", project.SetConfigInput{
		Config:  edited,
		IfMatch: got.Project.ConfigETag,
	})
	if err != nil {
		t.Fatalf("a write on a current read must succeed: %v", err)
	}
	if updated.Config.DefaultBranch != "develop" {
		t.Fatalf("edit was not applied: %#v", updated.Config)
	}
	// The token must move, or the next save would replay against a dead one.
	if updated.ConfigETag == got.Project.ConfigETag {
		t.Fatal("the config token must change when the config changes")
	}
}

// The config-as-code restore path (`ops/project-config.mjs apply`) exists to
// overwrite drift. It must be able to say so explicitly rather than be blocked by
// a concurrency check it is deliberately opting out of.
func TestSetConfigWildcardOptsOutOfTheStalenessCheck(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	restored := spawnable(domain.ProjectConfig{DefaultBranch: "develop"})
	if _, err := m.SetConfig(ctx, "ao", project.SetConfigInput{
		Config:  restored,
		IfMatch: "*",
	}); err != nil {
		t.Fatalf("the wildcard must authorize a deliberate whole-object write: %v", err)
	}
}

// Clients that send no token keep working — they are exactly as safe as they were
// before, no more and no less. Only a client that TRIED to prove freshness and
// failed is refused.
func TestSetConfigWithoutATokenIsStillAccepted(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	if _, err := m.Add(ctx, project.AddInput{Path: gitRepo(t), ProjectID: ptr("ao")}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	cfg := spawnable(domain.ProjectConfig{DefaultBranch: "develop"})
	if _, err := m.SetConfig(ctx, "ao", project.SetConfigInput{Config: cfg}); err != nil {
		t.Fatalf("a tokenless write must still be accepted: %v", err)
	}
}
