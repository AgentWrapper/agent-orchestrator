# Merge Gate Runbook

## Activating `review-passed`

The `review-passed` gate has two producers:

- PR heads: `ops/final-review-status.mjs set` posts a `review-passed` commit
  status on the reviewed head SHA after it posts the authoritative
  `final-review` status.
- Merge queue groups: `.github/workflows/review-passed.yml` emits the
  `review-passed` check on `merge_group` and verifies each queued PR head still
  has a clean SHA-current `final-review` status.

Only add `review-passed` to the live `mainprotect` required status checks after
this workflow and helper are on `main`. Before flipping the ruleset, make sure
any in-flight PR that should remain queueable has rerun final review on its
current head so the `review-passed` head status exists. Keep GitHub-native
auto-merge disabled for this repo; autonomous enqueuers must continue checking
the `merge-park` human-required signal before queueing.
