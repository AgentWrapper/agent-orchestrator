# @aoagents/ao-plugin-scm-github

## 0.5.0

### Patch Changes

- Updated dependencies [dd07b6b]
  - @aoagents/ao-core@0.5.0

## 0.4.0

### Patch Changes

- c8af50f: Make `ProjectConfig.repo` optional to support projects without a configured remote.

  **Migration:** `ProjectConfig.repo` is now `string | undefined` instead of `string`.
  External plugins that access `project.repo` directly (e.g. `project.repo.split("/")`) must
  add a null check first. Use a guard like `if (!project.repo) return null;` or a helper that
  throws with a descriptive error.

- a8bc746: scm-github: cache 4 more hot-path reads (CI, mergeability, pending comments, detectPR)

  Completes the bulk of the AO-side caching work alongside the prior PR view
  cache. Per-method TTLs match the approved policy: 5s max for
  decision-influencing fields.
  - `getCIChecks` (`gh pr checks`): 5s TTL
  - `getMergeability` (composite `pr view` + CI + state): 5s TTL on the composite result
  - `getPendingComments` (`gh api graphql` review threads): 5s TTL — ETag doesn't help on GraphQL per Experiment 2
  - `detectPR` (`gh pr list --head BRANCH`): 5s TTL, **positive-only** — `[]` results are never cached so a freshly created PR surfaces on the next poll. Branch-keyed entry is invalidated by `mergePR`/`closePR` alongside the number-keyed entries.

  Combined with the prior PR view cache, this covers the top 6 AO-side gh
  operation categories that accounted for ~85% of calls in tier-5 bench traces.

  Tests: 85 existing + 9 new cache tests, all 162 passing.

- a8bc746: scm-github: cache 5 `gh pr view` callsites with per-method TTLs

  The lifecycle worker repeatedly polls each PR for state, summary, reviews,
  and review decision. Trace data showed `gh pr view` was the single largest
  AO-side endpoint at 1,280 calls per 5-session tier-5 run with >97% duplicate
  rate (e.g. PR #184 polled 86× for `--json state` alone in 11.5 minutes).

  Adds an in-process per-instance cache inside `createGitHubSCM()`, keyed by
  `${owner}/${repo}#${prKey}:${method}` so different field-sets stay isolated.
  Per-method TTLs balance reduction against staleness on decision-influencing
  fields:
  - `resolvePR`: 60s (identity metadata only — number, url, title, branch refs, isDraft)
  - `getPRState`: 5s
  - `getPRSummary`: 5s
  - `getReviews`: 5s
  - `getReviewDecision`: 5s

  `assignPRToCurrentUser`, `mergePR`, and `closePR` each invalidate the entire
  PR cache for that PR after the mutation, so AO never sees stale state from
  its own writes. Failures are not cached.

  `getCIChecksFromStatusRollup` and `getMergeability` are intentionally NOT
  cached here — those need ETag-based revalidation, not blind TTL, and will
  land in a follow-up change.

  Expected reduction: ~1,165 of ~1,280 `gh pr view` calls per tier-5 run.

  Tests: 73 existing + 12 new cache tests, all passing.

- Updated dependencies [2306078]
- Updated dependencies [faaddb1]
- Updated dependencies [f330a1e]
- Updated dependencies [a862327]
- Updated dependencies [331f1ce]
- Updated dependencies [703d584]
- Updated dependencies [f674422]
- Updated dependencies [62353eb]
- Updated dependencies [bd36c7b]
- Updated dependencies [e7ad928]
- Updated dependencies [ca8c4cc]
- Updated dependencies [7b82374]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [1cbf657]
- Updated dependencies [c447c7c]
- Updated dependencies [a45eb32]
- Updated dependencies [7072143]
- Updated dependencies [ed2dcea]
  - @aoagents/ao-core@0.4.0

## 0.2.0

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
