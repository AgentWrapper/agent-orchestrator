package review

import (
	"fmt"
	"strings"
)

// reviewTexts returns the user-facing prompt and the system prompt to deliver to
// a reviewer, authored in one place — the reviewer analogue of
// session_manager.buildSpawnTexts. The standing reviewer role lives in the
// system prompt; the per-pass task (which PR/commit, and the exact submit
// command carrying the ids) lives in the prompt, so it is also what AO injects
// into an already-running reviewer to review a new commit.
//
// The texts are self-contained — they carry the ids the reviewer needs to
// submit — so no environment variables are required.
func reviewTexts(spec LaunchSpec) (prompt, systemPrompt string) {
	systemPrompt = `## Code reviewer role

You are an AO code reviewer. You review the requested change in the current checkout — do not start unrelated work. Inspect what each change introduced by diffing the checkout against its base branch, and review for correctness bugs, missing error handling, security issues, test coverage, and clear deviations from the surrounding code's conventions. Prefer a few high-confidence findings over nitpicks.

Publish your review through AO, stating clearly whether it needs changes or is ready, with inline findings for specific issues. Do not push commits, edit files, or modify the branch — review only.`

	queueText := reviewQueueText(spec)
	prompt = fmt.Sprintf(`Review the requested change(s) for worker session %s.
%s

Complete every review task in the queue autonomously. Do not ask the user whether to continue to the next change, and do not stop after the first change unless the provider or checkout is genuinely unusable for every queued task.

After reviewing every queued change, publish and record all results with one command. Pass JSON on stdin so nothing is written into the worktree. Include one object per change/run from the queue, and add one object to "findings" for each line-specific issue; omit "findings" when there are none:

    printf '%%s' '{ "reviews": [ { "runId": "<run-id>", "verdict": "<approved|changes_requested>", "body": "<your full review markdown>", "findings": [ { "path": "<file>", "line": <n>, "body": "<finding>" } ] } ] }' | ao review publish --session %s --reviews -

Keep the JSON on one line and shell-escape any single quotes in review text before passing it to printf; do not use a heredoc because reviewer panes run through an interactive PTY. AO selects the worker project's configured provider and records the review run only after publication succeeds.`,
		spec.WorkerID, queueText, spec.WorkerID)
	return prompt, systemPrompt
}

func reviewQueueText(spec LaunchSpec) string {
	if len(spec.ReviewQueue) <= 1 {
		return fmt.Sprintf("\nReview task queue:\n* 1. %s (head commit %s, run %s)\n", spec.PRURL, spec.TargetSHA, spec.RunID)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\nAO created %d review tasks for this worker session. Review every queued change, then publish all results together.\n\nReview task queue:\n", len(spec.ReviewQueue))
	for i, task := range spec.ReviewQueue {
		fmt.Fprintf(&b, "* %d. %s (head commit %s, run %s)\n", i+1, task.PRURL, task.TargetSHA, task.RunID)
	}
	return b.String()
}
