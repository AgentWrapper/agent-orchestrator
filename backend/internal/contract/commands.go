package contract

// AOCommand names portable session lifecycle commands shared by local and Cloud.
type AOCommand string

const (
	CommandSpawn               AOCommand = "spawn"
	CommandSend                AOCommand = "send"
	CommandStatus              AOCommand = "status"
	CommandInspect             AOCommand = "inspect"
	CommandWait                AOCommand = "wait"
	CommandResult              AOCommand = "result"
	CommandKill                AOCommand = "kill"
	CommandClaimPullRequest    AOCommand = "claim-pr"
	CommandMergePullRequest    AOCommand = "merge-pr"
	CommandResolveReviewThread AOCommand = "resolve-review-thread"
	CommandReportBlocker       AOCommand = "blocker"
)
