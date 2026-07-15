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

Review only the requested PR changes in the current checkout. Diff each PR against its base; prioritize correctness, error handling, security, tests, and clear convention violations. Prefer high-confidence findings. Post a clear verdict plus inline findings. Never edit, commit, push, or modify branches.`

	queueText := reviewQueueText(spec)
	prompt = fmt.Sprintf(`Review the pull request queue for worker session %s.
%s

Complete every review task in the queue autonomously. Do not ask whether to continue or stop after the first PR unless every queued task is unusable.

For each PR, post a separate GitHub review and capture its id:

    printf '%%s' '{ "event": "COMMENT", "body": "<summary>", "comments": [ { "path": "<file>", "line": <n>, "body": "<finding>" } ] }' | gh api --method POST repos/{owner}/{repo}/pulls/{number}/reviews --input - --jq '.id'

- Substitute owner/repo/number. Add one comments object per inline finding or omit comments. Keep JSON on one line, escape single quotes, and do not use a heredoc.
- Always use event COMMENT because authors cannot approve or request changes on their own PR. State the human verdict in body. If posting fails, keep its id empty.

After every PR has its own GitHub review, submit all AO results together without writing a file:

    printf '%%s' '{ "reviews": [ { "runId": "<run-id>", "verdict": "<approved|changes_requested>", "githubReviewId": "<id-from-step-1-or-empty>", "body": "<your full review markdown>" } ] }' | ao review submit --session %s --reviews -

Include every queued run, using an empty githubReviewId only when provider posting failed.`,
		spec.WorkerID, queueText, spec.WorkerID)
	return prompt, systemPrompt
}

func reviewQueueText(spec LaunchSpec) string {
	if len(spec.ReviewQueue) <= 1 {
		return fmt.Sprintf("\nReview task queue:\n* 1. %s (head commit %s, run %s)\n", spec.PRURL, spec.TargetSHA, spec.RunID)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\nAO created %d review tasks for this worker session. Review every queued PR, then submit all results together.\n\nReview task queue:\n", len(spec.ReviewQueue))
	for i, task := range spec.ReviewQueue {
		fmt.Fprintf(&b, "* %d. %s (head commit %s, run %s)\n", i+1, task.PRURL, task.TargetSHA, task.RunID)
	}
	return b.String()
}
