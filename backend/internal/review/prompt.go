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

You are an AO code reviewer. You review a single pull request's changes in the current checkout — do not start unrelated work. Inspect what the PR changed by diffing the checkout against the PR's base branch, and review for correctness bugs, missing error handling, security issues, test coverage, and clear deviations from the surrounding code's conventions. Prefer a few high-confidence findings over nitpicks.

Post your review as a comment on the pull request, stating clearly whether it needs changes or is ready, with inline comments for specific findings. Do not push commits, edit files, or modify the branch — review only.`

	queueText := reviewQueueText(spec)
	prompt = fmt.Sprintf(`Review pull request %s (head commit %s).
%s

Do these steps in order:
1. Post your review on the pull request and capture its id in one call. Post with `+"`gh api`"+` rather than `+"`gh pr review`"+`: it is the only way to attach inline comments, and its response carries the created review's id, so AO can tell the worker exactly which review to address. Send the review as a JSON body so the inline comments form a proper array of objects:

    gh api --method POST repos/{owner}/{repo}/pulls/{number}/reviews --input - --jq '.id' <<'JSON'
    { "event": "COMMENT", "body": "<summary>",
      "comments": [ { "path": "<file>", "line": <n>, "body": "<finding>" } ] }
    JSON

   - Substitute the PR's owner/repo/number. Add one object to "comments" per inline finding; omit the field for a review with no inline comments.
   - Always use "event": "COMMENT": reviews are posted from the PR author's own account, and GitHub rejects both APPROVE and REQUEST_CHANGES on your own PR. State in the body whether you are requesting changes or approving; the machine-readable verdict goes to AO in step 2.
   - The printed number is the review id. If the call fails on the provider, leave the id empty.
2. Record the result with AO, passing your full review on stdin with --body - so nothing is ever written into the worktree (a file there could be committed onto the worker's branch):

    ao review submit --session %s --run %s --verdict <approved|changes_requested> --review-id <id-from-step-1> --body - <<'MD'
    <your full review markdown>
    MD

Only if step 1 genuinely fails on the provider, still run step 2 (without --review-id) so the result is recorded.`,
		spec.PRURL, spec.TargetSHA, queueText, spec.WorkerID, spec.RunID)
	return prompt, systemPrompt
}

func reviewQueueText(spec LaunchSpec) string {
	if len(spec.ReviewQueue) <= 1 {
		return "\nThis is the only review task in the current trigger."
	}
	current := spec.ReviewIndex + 1
	if current < 1 || current > len(spec.ReviewQueue) {
		current = 1
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\nAO created %d review tasks for this worker session. This is task %d of %d; complete and submit this task before moving to the next queued task.\n\nReview task queue:\n", len(spec.ReviewQueue), current, len(spec.ReviewQueue))
	for i, task := range spec.ReviewQueue {
		marker := " "
		if i == current-1 {
			marker = "*"
		}
		fmt.Fprintf(&b, "%s %d. %s (head commit %s, run %s)\n", marker, i+1, task.PRURL, task.TargetSHA, task.RunID)
	}
	return b.String()
}
