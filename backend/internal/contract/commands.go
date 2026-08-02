package contract

// AOCommand names portable session lifecycle commands shared by local and Cloud.
type AOCommand string

const (
	// CommandSpawn creates a delegated worker session.
	CommandSpawn AOCommand = "spawn"
	// CommandSend sends a message to an existing session.
	CommandSend AOCommand = "send"
	// CommandStatus reports session state.
	CommandStatus AOCommand = "status"
	// CommandInspect reads session workspace and runtime context.
	CommandInspect AOCommand = "inspect"
	// CommandWait waits for session progress or completion.
	CommandWait AOCommand = "wait"
	// CommandResult reports final worker output.
	CommandResult AOCommand = "result"
	// CommandKill terminates a session.
	CommandKill AOCommand = "kill"
	// CommandClaimPullRequest associates a PR with a session.
	CommandClaimPullRequest AOCommand = "claim-pr"
	// CommandMergePullRequest merges a claimed PR.
	CommandMergePullRequest AOCommand = "merge-pr"
	// CommandResolveReviewThread marks a review thread resolved.
	CommandResolveReviewThread AOCommand = "resolve-review-thread"
	// CommandReportBlocker reports a worker blocker to the orchestrator.
	CommandReportBlocker AOCommand = "blocker"
)
