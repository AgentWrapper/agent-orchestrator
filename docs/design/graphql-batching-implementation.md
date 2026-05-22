# GraphQL Batching Implementation for Issue #608

## Summary

This implementation adds GraphQL batch PR enrichment to the orchestrator polling loop, reducing GitHub API calls from N×3 calls to ~1 call per polling cycle.

## Problem Statement

The orchestrator runs a status loop that polls GitHub for ALL active sessions every 30 seconds. For each PR, it needs:

1. PR state (merged, closed, open) - `getPRState()`
2. CI status - `getCISummary()`
3. Review decision - `getReviewDecision()`
4. Merge readiness (optional, for approved PRs) - `getMergeability()`

With the current implementation:
- 10 active PRs = 30 API calls per poll = 3,600 calls/hour
- 20 active PRs = 60+ API calls per poll = 7,200+ calls/hour

This exceeds GitHub's rate limit of 5,000 API calls/hour.

## Solution: GraphQL Batch Query

Using GraphQL aliases, we can query multiple PRs in a single request:

```graphql
query BatchPRs(
  $pr0Owner: String!, $pr0Name: String!, $pr0Number: Int!,
  $pr1Owner: String!, $pr1Name: String!, $pr1Number: Int!
) {
  pr0: repository(owner: $pr0Owner, name: $pr0Name) {
    pullRequest(number: $pr0Number) {
      title, state, additions, deletions, isDraft,
      mergeable, mergeStateStatus, reviewDecision,
      reviews(last: 5) { nodes { author { login }, state } },
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
  pr1: repository(owner: $pr1Owner, name: $pr1Name) {
    pullRequest(number: $pr1Number) {
      # same fields as pr0
    }
  }
}
```

## Changes Made

### 1. Core Type Extensions (`packages/core/src/types.ts`)

Added new interface for batch enrichment:

```typescript
export interface PREnrichmentData {
  state: PRState;
  ciStatus: CIStatus;
  reviewDecision: ReviewDecision;
  mergeable: boolean;
  title?: string;
  additions?: number;
  deletions?: number;
  isDraft?: boolean;
  hasConflicts?: boolean;
  isBehind?: boolean;
  blockers?: string[];
}
```

Extended SCM interface with optional batch method:

```typescript
export interface SCM {
  // ... existing methods

  /**
   * Batch fetch PR data for multiple PRs in a single GraphQL query.
   * Used by the orchestrator to poll all active sessions efficiently.
   */
  enrichSessionsPRBatch?(prs: PRInfo[]): Promise<Map<string, PREnrichmentData>>;
}
```

### 2. GraphQL Batch Module (`packages/plugins/scm-github/src/graphql-batch.ts`)

New module with:
- `generateBatchQuery()` - Dynamically generates GraphQL queries with aliases
- `enrichSessionsPRBatch()` - Main entry point that:
  - Deduplicates PRs by key
  - Splits into batches of 25 PRs (MAX_BATCH_SIZE)
  - Executes queries via `gh api graphql`
  - Returns Map<key, PREnrichmentData>

Key features:
- Batch size limit of 25 PRs per query (well under GitHub's complexity limit)
- Graceful handling of missing/deleted PRs
- Error handling at batch level (one failed PR doesn't break the batch)
- CI status parsing from statusCheckRollup for comprehensive CI detection

### 3. GitHub Plugin Integration (`packages/plugins/scm-github/src/index.ts`)

Added implementation of `enrichSessionsPRBatch()`:

```typescript
async enrichSessionsPRBatch(prs: PRInfo[]): Promise<Map<string, PREnrichmentData>> {
  return enrichSessionsPRBatch(prs);
}
```

The method is optional in the SCM interface, ensuring backward compatibility.

### 4. Lifecycle Manager Updates (`packages/core/src/lifecycle-manager.ts`)

Added batch enrichment to the polling loop:

1. **Cache variable**: `prEnrichmentCache` - Map cleared at each poll cycle
2. **Populate function**: `populatePREnrichmentCache()` - Groups PRs by SCM plugin and calls batch enrichment
3. **Poll cycle update**: Calls `populatePREnrichmentCache()` before checking sessions
4. **Status detection**: Uses cached data when available, falls back to individual calls on cache miss

```typescript
// At start of pollAll()
await populatePREnrichmentCache(sessionsToCheck);

// In determineStatus()
const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
const cachedData = prEnrichmentCache.get(prKey);
if (cachedData) {
  // Use cached data - no API calls
} else {
  // Fall back to individual calls
}
```

### 5. Unit Tests (`packages/plugins/scm-github/test/graphql-batch.test.ts`)

Added comprehensive tests for:
- Single PR query generation
- Multiple PR query generation with different aliases
- Empty PR array handling
- Required field inclusion in queries
- Sequential numeric alias generation
- Special characters in owner/repo names

## Performance Impact

### API Call Reduction

| Active PRs | Before | After (Batch) | Reduction |
|-------------|---------|-----------------|------------|
| 5           | 15      | 1               | 93%        |
| 10          | 30      | 1               | 97%        |
| 20          | 60      | 1               | 98%        |
| 50          | 150     | 2               | 99%        |

### Hourly Rate Limit Usage (30s polling)

| Active PRs | Before (calls) | After (calls) | % of 5,000 Limit |
|-------------|----------------|-----------------|-------------------|
| 10         | 3,600          | 120             | 2.4% ✅           |
| 20         | 7,200 ❌       | 240             | 4.8% ✅           |
| 50         | 18,000 ❌      | 600             | 12% ✅            |

## Backward Compatibility

The implementation maintains full backward compatibility:

1. **Optional SCM method**: `enrichSessionsPRBatch()` is optional in the SCM interface
2. **Graceful fallback**: If batch enrichment fails or isn't available, the lifecycle manager falls back to individual API calls
3. **No breaking changes**: All existing SCM methods (`getPRState`, `getCISummary`, `getReviewDecision`, `getMergeability`) remain unchanged

## Edge Cases Handled

| Case | Handling |
|------|----------|
| PR deleted during polling | Returns enrichment data with state "closed" and appropriate blockers |
| GraphQL query failure | Falls back to individual API calls |
| Mixed SCM plugins | Groups PRs by plugin and calls batch enrichment for each group |
| Batch size > MAX_BATCH_SIZE | Splits into multiple batches |
| Cache miss | Falls back to individual API calls |

## GraphQL Rate Limits

GitHub GraphQL uses a points-based system. Our implementation:
- Uses ~50 points per PR (estimated)
- Allows ~100 PRs per hour within the 5,000 point limit
- Stays well under complexity limits with MAX_BATCH_SIZE=25

Note: Actual point costs should be monitored in production and MAX_BATCH_SIZE adjusted if needed.

## Future Improvements

1. **Metrics**: Add observability metrics for batch query success/failure rates
2. **Cache persistence**: Consider caching enrichment data across poll cycles for stable PRs
3. **Dynamic batching**: Auto-tune batch size based on GraphQL point usage
4. **Feature flag**: Add feature flag for gradual rollout

## Testing

Run the unit tests:

```bash
cd packages/plugins/scm-github
npm test graphql-batch.test.ts
```

Integration testing should verify:
- Batch queries work with real GitHub repos
- PR state detection is accurate
- CI status parsing matches individual calls
- Review decision detection is accurate
- Error handling works as expected

## Related Issues

- Issue #608: GraphQL batching for orchestrator polling
- PR #617: Previous batching optimization (1 call per PR)

## References

- GitHub GraphQL API: https://docs.github.com/en/graphql
- GraphQL Aliases: https://graphql.org/learn/queries/#aliases
- gh CLI GraphQL: https://cli.github.com/manual/gh_api_graphql
