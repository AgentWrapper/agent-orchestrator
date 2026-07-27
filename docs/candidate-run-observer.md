# Candidate-run observer boundary

Agent Orchestrator can attach one external candidate-run kernel as an
observer-only evaluation boundary. AO remains the sole dispatcher: it claims
the prepared task, allocates the native git worktree, launches Codex, observes
the pull request, and stops the runtime. The external module only configures its
journal and acknowledges AO-native facts.

This surface is disabled unless `AO_CANDIDATE_RUN_CONFIG` names an absolute
binding file. Normal AO behavior is unchanged when the variable is absent.

## Binding

The binding is non-secret. It must not contain provider tokens, login material,
or copied user configuration. Authentication is established separately before
activation and represented here only by non-secret status and policy
attestations in the schema-v2 activation profile.

This sample tracks the fixture candidate-run kernel contract at
`617bf9b6793932a4bbc7d84e999684d8cb1d043a`; activation must separately pin
the reviewed kernel module bytes with `kernel.sha256`.

```json
{
  "schemaVersion": 1,
  "nodeBinary": "/absolute/path/to/node",
  "journalDirectory": "/absolute/path/to/run-journal",
  "kernel": {
    "modulePath": "/absolute/path/to/candidate-run.mjs",
    "sha256": "<64-lowercase-hex>"
  },
  "controllerClaim": {
    "eventId": "<controller-event-id>",
    "claimId": "<controller-claim-id>",
    "claimedAt": "2026-07-26T20:00:00.000Z"
  },
  "codex": {
    "harness": "codex",
    "approvalPolicy": "on-request"
  },
  "activationProfile": {
    "schemaVersion": 2,
    "candidateSlug": "agent-orchestrator",
    "candidateVersion": "<exact-version>",
    "adapterRevision": "<exact-source-revision>",
    "adapterDigest": "<artifact-sha256>",
    "adapterArtifact": "<reviewed-adapter-artifact>",
    "workerRuntime": "Codex CLI",
    "modelProvider": "OpenAI",
    "modelAuthRoute": "<approved-enterprise-route>",
    "authStatus": "available",
    "authStateScope": "<approved-org-scope>",
    "model": "<exact-codex-model>",
    "effort": "<exact-effort>",
    "sandbox": "workspace-write",
    "privacyPosture": "<attested-policy>",
    "meteringPosture": "<attested-quota>",
    "lastVerifiedAt": "<ISO-8601>",
    "nextAuthAction": "none"
  },
  "prepared": {
    "candidateSlug": "agent-orchestrator",
    "runId": "<run-id>",
    "scenario": "<scenario-id>",
    "repository": "<owner/repository>",
    "controllerOwner": "<controller-id>",
    "dispatcher": "agent-orchestrator",
    "candidateRoleClass": "Orchestrator",
    "workspaceAllocator": "agent-orchestrator-worktree",
    "initiationMode": "automatic",
    "workerLimit": 1,
    "activationProfileDigest": "<canonical-profile-sha256>",
    "tasks": [
      {
        "slot": "<slot>",
        "issueNumber": 123,
        "schedulingOrder": 0,
        "idempotencyKey": "<idempotency-key>",
        "allocationKey": "<allocation-key>",
        "workspaceMode": "native-after-claim",
        "sourceWriterMode": "agent-orchestrator-session",
        "workspace": null,
        "branch": "<prepared-branch>",
        "sourceWriter": null,
        "authorizedFiles": ["<authorized-path>"]
      }
    ]
  }
}
```

AO rejects a relative binding, a symlinked binding or kernel module, an
unrecognized top-level field, a kernel digest mismatch, a non-v2 activation
profile, a non-Codex harness, any approval policy other than `on-request`, or a
profile without an exact model, effort, and `workspace-write` sandbox. AO also
requires a lowercase SHA-256 activation-profile digest and requires every task
to carry its zero-based array position as `schedulingOrder`. The digest value is
produced and compared with the full canonical schema-v2 activation profile by
the external fixture kernel, including `adapterArtifact` and `modelProvider`;
AO does not implement a competing digest authority.

The sidecar is one long-lived Node process owned by the AO daemon. Its protocol
is newline-framed JSON over stdio. Only `configure` and `observe` are accepted;
`start`, `resume`, `stop`, and every unknown method fail closed. The external
module must expose the candidate-run kernel and journal factories used by the
binding.

## Lifecycle order

For an admitted task, the session manager enforces:

1. Resolve the prepared GitHub issue and synchronously acknowledge
   `task-claimed`.
2. Create the AO session row and native worktree.
3. Record the complete allocation receipt before provisioning or runtime work.
4. Construct Codex launch argv with the profile's exact model, effort,
   `workspace-write` sandbox, and `on-request` approval policy.
5. Acknowledge `session-start-requested`, then let AO's native runtime create
   the session, then acknowledge `session-started`.
6. Persist a GitHub PR observation with its semantic hashes held back, validate
   the prepared repository, issue, and source branch through the candidate
   kernel, then let the normal lifecycle reducer acknowledge it.
7. On explicit session kill, destroy the native tmux session, terminate and
   enumerate its pane-session descendants, require zero survivors, record
   `worker-stopped` and `descendants-stopped`, and only then release the
   worktree.

Claim rejection has no session or workspace effect. Allocation or pre-runtime
rejection removes only the clean AO-created workspace and seed row. A
post-launch rejection requires proof-capable runtime teardown before AO may
release that workspace. PR rejection leaves the prior semantic hash cursor in
place so the observation is retried rather than treated as acknowledged.

## Deliberate limits

- AO's native worktree and runtime adapters remain authoritative. The external
  module is not a second controller and cannot allocate a workspace or launch a
  worker.
- Candidate-mode boot reconciliation and session restore are rejected because
  this observer protocol has no resume event. A run must use its isolated,
  controller-approved AO data directory.
- Closing the AO daemon does not imply a candidate stop. The run controller
  must use the explicit AO session-kill path while the observer is available.
- GitHub PR/review facts are observed through AO's existing GitHub adapter.
  GitHub Projects V2 **Human Review** state is not implemented by this
  boundary. A draft PR, a GitHub review decision, and the fixture's Human
  Review gate are distinct facts.
- The binding does not perform login, select an organization, inspect
  credential values, attest privacy policy, or reserve quota. Those remain
  activation checks owned by the admitting controller.
- On macOS/Linux, `tmux` must already resolve on the daemon's `PATH`. A
  controller may prepend a digest-pinned Nix store `bin` path; AO does not
  install or update tmux.
