package daemon

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	prsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pr"
)

func buildPRActionService(prs prsvc.OpenPRLister, scm prsvc.CommitChecksReader, tracker ports.Tracker) prsvc.ActionManager {
	if prs == nil || scm == nil {
		return nil
	}
	return prsvc.NewActionServiceWithDeps(prsvc.ActionDeps{
		MainCI: &prsvc.LiveMainCIGate{
			PRs:     prs,
			SCM:     scm,
			Tracker: tracker,
		},
	})
}
