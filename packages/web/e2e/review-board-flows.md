# Review Board E2E Flows

These flows cover the reviewer-agent UI as an orchestrator-owned surface, not as a second
command center. The project orchestrator is the entry point for creating and running reviews.
The review board observes, inspects, and navigates reviewer work. Reviewer runs remain linked to
a coding worker, but they must not reuse the worker's terminal context.

## Flow 1: Enter through the project orchestrator

1. Open the project coding dashboard at `/projects/:projectId`.
2. Open the header `Orchestrator` action.
3. Confirm the app lands on `/projects/:projectId/sessions/:orchestratorId`.
4. Confirm this is the project orchestrator session, not a worker or reviewer session.

## Flow 2: Coding to Reviews navigation stays available

1. Open the project coding dashboard at `/projects/:projectId`.
2. Confirm the shared header shows `Coding` as the active workspace mode.
3. Click `Reviews`.
4. Confirm the browser lands on `/review?project=:projectId`.
5. Confirm `Reviews` is now active and `Coding` links back to `/projects/:projectId`.

## Flow 3: Orchestrator requests reviews

1. Start with a worker card that is ready for review.
2. From the orchestrator flow, issue the AO review command for that worker.
3. Confirm a queued review run appears on the review board.
4. Confirm the review run is linked to the coding worker and displays worker metadata.
5. Confirm no reviewer coding session metadata is created.

## Flow 4: Orchestrator executes multiple queued reviewer runs

1. Create at least two queued review runs.
2. From the orchestrator flow, issue two reviewer execution commands without waiting between them.
3. Confirm both cards can be observed in a reviewing state.
4. Confirm completed runs move to either `Triage` when findings exist or `Clean` when no findings exist.

## Flow 5: Inspect findings

1. Let the orchestrator execute a run whose reviewer result contains a finding.
2. Confirm the run lands in `Triage`.
3. Click the `view` finding action or the card `details` action.
4. Confirm the details panel lists severity, title, location, body, open count, total count, and worker actions.
5. Close the drawer with the close button or Escape.

## Flow 6: Worker and orchestrator links

1. From a review card, click `Worker`.
2. Confirm the app navigates to the coding dashboard focused on the linked worker.
3. Return to the review board.
4. Confirm the header `Orchestrator` action opens or restores the same project orchestrator used by the coding dashboard.

## Flow 7: Failure and retry

1. Execute a queued run with a reviewer command that fails.
2. Confirm the card moves to `Failed`.
3. From the orchestrator flow, issue a retry command for the same run.
4. Confirm the retry can execute the same run again with `force: true`.

## Flow 8: Feedback availability

1. Show a review run linked to a worker with no live runtime.
2. Confirm the card shows the worker runtime state instead of a `Feedback` action.
3. Show a review run linked to a live worker.
4. Confirm `Feedback` sends open review findings to the linked worker.
5. Confirm the app opens the worker terminal section after the send succeeds.

## Flow 9: CLI and UI share the same review store

1. Request a review through the orchestrator AO command path.
2. Confirm the run appears in `/review?project=:projectId` without refreshing any mocked data.
3. Execute that run through the orchestrator AO command path and a deterministic local reviewer command.
4. Confirm the UI reflects the persisted result after a reload.

## Flow 10: Clean review result

1. Let the orchestrator execute a reviewer command that returns `{"findings":[]}`.
2. Confirm the run moves to `Clean`.
3. Confirm the card reports `0 findings`.
4. Open details and confirm it reports no captured findings.

## Flow 11: Reviewer isolation from coding sessions

1. Execute a reviewer run.
2. Confirm the reviewer has a snapshot workspace under `code-reviews/workspaces/:reviewerSessionId`.
3. Confirm there is no coding session metadata file for `:reviewerSessionId`.
4. Confirm the linked worker card and terminal route remain the coding worker, not the reviewer.

## Flow 12: New worker commit supersedes old review runs

1. Complete a review for the worker's current `HEAD`.
2. Commit a new change in the worker repository.
3. From the orchestrator flow, request a new review for the same worker.
4. Confirm older review runs for the previous `HEAD` move to `Outdated`.
5. Confirm the new review remains actionable in `Queued`.

## Flow 13: Same orchestrator across modes

1. Open the coding dashboard and capture the header `Orchestrator` link.
2. Open the review board and capture the header `Orchestrator` link.
3. Confirm both links point to the same project orchestrator session.
4. Confirm the review board does not offer `Spawn Orchestrator` when one already exists.

## Flow 14: Send reviewer findings back to worker

1. Complete a review run with open findings.
2. From the review board, click `Feedback` for that review run.
3. Confirm AO sends the stored finding details to the linked coding worker.
4. Confirm the review run moves to `Waiting`.
5. Confirm open findings become sent findings and are no longer counted as open.
