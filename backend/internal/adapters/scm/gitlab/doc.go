// Package gitlab observes GitLab merge requests for AO's SCM integrations.
//
// It implements the provider-neutral scm.Provider interface using the GitLab
// REST API v4. Unlike the GitHub adapter which uses both REST and GraphQL,
// this adapter is REST-only because GitLab's GraphQL coverage for CI pipelines
// and merge-request approvals is incomplete.
//
// # State mapping
//
// Each SCMObservation field is derived as follows:
//
//   - PR state: from merge_request.state + draft bool.
//     | GitLab state | draft | domain.PRState |
//     |--------------|-------|----------------|
//     | opened       | true  | draft          |
//     | opened       | false | open           |
//     | merged       | *     | merged         |
//     | closed       | *     | closed         |
//     | locked       | *     | closed         |
//
//   - CI: derived from the latest pipeline's status.
//     | Pipeline status        | domain.CIState |
//     |------------------------|----------------|
//     | success                | passing        |
//     | failed, canceled       | failing        |
//     | running, pending, ...  | pending        |
//     | skipped, manual, ""    | unknown        |
//
//   - Review: GitLab has no "changes_requested" concept. Approval is
//     derived from the merge_request/approvals endpoint:
//     | Condition                    | domain.ReviewDecision   |
//     |------------------------------|-------------------------|
//     | approved == true             | approved                |
//     | approvals_required > granted | review_required         |
//     | otherwise                    | none                    |
//
//   - Mergeability: from merge_request.merge_status (or detailed_merge_status).
//     | merge_status              | domain.Mergeability |
//     |---------------------------|---------------------|
//     | can_be_merged             | mergeable           |
//     | cannot_be_merged          | conflicting         |
//     | checking, unchecked, ""   | unknown             |
//     | ci_must_pass, not_approved, etc. | blocked      |
//
// # Authentication
//
// Tokens are resolved from AO_GITLAB_TOKEN, GITLAB_TOKEN, or by shelling out
// to `glab auth token`. The PRIVATE-TOKEN header is used for REST requests.
//
// # Host detection
//
// ParseRepository recognises gitlab.com and self-hosted instances configured
// via AO_GITLAB_HOST. Hosts containing "gitlab" in their name are also matched
// as a heuristic, with explicit rejection of GitHub host patterns to prevent
// collisions in the multi-provider dispatcher.
package gitlab
