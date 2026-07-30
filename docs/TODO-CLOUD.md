# AO Cloud Deferred Work

This file records intentionally deferred cloud work so Cloud Agent V1 can stay
personal-account-first without closing the architecture to organizations and
additional providers.

Items here are not permission to ship visible placeholders. A deferred feature
must remain absent from the production UI until it has a real implementation.

## Current V1 hardening and parity gaps

- [ ] Generate the cloud browser client from a versioned cloud API schema;
      `frontend/src/landing/src/lib/cloud-api.ts` is currently hand-maintained
- [ ] Replace the temporary Render `AO_GITHUB_TOKEN`/local-`gh` credential
      source with a GitHub App, installation lookup, short-lived installation
      tokens, repository grants, and webhook verification
- [ ] Add a user-facing project/session delete flow that first persists sandbox
      delete intent, waits for provider confirmation, and only then removes
      project-owned database state
- [ ] Add cloud session-management parity where semantics apply: rename,
      terminate/delete, restore/resume, cleanup/archive, and cloud-specific
      branch/merge policy. Do not expose local worktree-only operations in the
      cloud UI; preserve desired/observed-state reconciliation for every
      lifecycle mutation.
- [ ] Add an orphan sweeper that compares AO labels in every configured
      provider with durable `ao_sandboxes` rows
- [ ] Automate worker-image rollout and safe replacement instead of manually
      deleting Machines when the worker protocol/image changes
- [ ] Complete cloud workspace file/content/diff APIs and UI
- [ ] Complete cloud PR/check/review actions beyond the current SCM observation
      and status projection
- [ ] Add authenticated preview routing
- [ ] Add durable cloud notifications
- [ ] Add Playwright coverage for login → project → prewarmed orchestrator →
      delegated worker → follow-up → refresh/reconnect → interrupt → delete
- [ ] Add metrics, traces, alerts, dashboards, and measured startup SLOs on top
      of the current structured Render request/turn/worker/VM logs
- [ ] Add quota, concurrency, idle-suspend, maximum-lifetime, and cost controls
- [ ] Add network egress policy and abuse controls
- [ ] Replace deployment-level secret encryption keys with managed KMS and
      document rotation/re-encryption
- [ ] Evaluate a model gateway or narrower short-lived agent credentials; the
      current encrypted provider credential is released to its authorized
      session worker
- [ ] Decide whether Electron should gain an authenticated cloud transport; it
      is currently local-only while the browser app is cloud-only
- [ ] Add a runtime-neutral “new task” shortcut/command if `Cmd+Shift+N` parity
      is desired; cloud task creation must not expose local worktree details
- [ ] Extend cloud worker support beyond Claude Code, Codex, and Cursor,
      prioritizing local AO harnesses that have an approved cloud credential
      flow and machine-readable or safely supported runtime protocol. Each
      added harness must support authenticated launch, streaming, interruption,
      reconnect, and resume—not just image installation.

## Organizations and collaboration

- [ ] Organization creation, rename, archive, and deletion
- [ ] Invite, accept, decline, resend, and revoke membership flows
- [ ] Owner, admin, and member roles
- [ ] Ownership transfer and protection against deleting the last owner
- [ ] Teams and team membership
- [ ] Repository-level permissions
- [ ] Project/session sharing
- [ ] Shared terminal collaboration and explicit control ownership
- [ ] Organization-managed Daytona/provider connections
- [ ] Organization-managed model and project secrets
- [ ] Organization quotas, concurrency, budgets, and spending alerts
- [ ] Organization audit-log UI and retention policy
- [ ] Enterprise SSO
- [ ] SCIM provisioning/deprovisioning
- [ ] Domain verification and organization discovery
- [ ] Data residency and regional policy controls

Cloud V1 still requires strict user-to-user authorization. Its private personal
account/workspace boundary must be designed so it can later participate in the
organization membership model without changing session or sandbox IDs.

## Additional source-control providers

- [ ] GitLab application/OAuth integration
- [ ] Bitbucket application/OAuth integration
- [ ] Provider-neutral repository installation/grant UI
- [ ] Provider-specific webhook normalization

GitHub is the only source-control target for Cloud V1. The deployed test
implementation uses the control plane's scoped token behind its Git proxy;
GitHub App installation auth remains required before multi-user production.

## Local/cloud portability

- [ ] Move an existing local session to cloud
- [ ] Transfer dirty tracked and untracked files safely
- [ ] Transfer conversation and native agent resume identity
- [ ] Move or continue a cloud session locally
- [ ] Optional local/cloud account metadata synchronization
- [ ] Conflict and ownership rules when both sides changed

No local/cloud database synchronization is part of Cloud V1.

## Additional execution modes and providers

- [ ] Re-test Daytona outbound HTTPS on an unrestricted account and document
      provider egress requirements; the earlier restricted-tier sandbox reset
      TLS connections even with `networkBlockAll=false`
- [ ] Run the same lifecycle/reconnect/cleanup contract suite against Daytona
      that is currently exercised by the deployed Fly adapter
- [ ] Revisit larger disk profiles if the Daytona tier is raised beyond the
      current 10-GiB limit
- [ ] AWS-native customer-hosted sandbox adapter
- [ ] Additional managed sandbox providers
- [ ] Customer-owned persistent host/BYOM mode
- [ ] Explicit lower-isolation shared-host mode
- [ ] Coordinated multiple-agent mode inside one sandbox
- [ ] Airgapped deployment profile

The safe default remains one isolated environment per AO session.

## Enterprise deployment

- [ ] Terraform/CloudFormation customer installer
- [ ] Customer RDS, S3, KMS, IAM, networking, and observability defaults
- [ ] Private VPC and private Git/model endpoints
- [ ] Signed offline update and rollback policy
- [ ] License and entitlement behavior for disconnected deployments
- [ ] Customer-controlled backup/restore and disaster-recovery runbooks

## Product integrations and automation

- [ ] Public cloud REST API and service accounts
- [ ] Webhooks
- [ ] GitHub issue/PR-triggered sessions
- [ ] Slack and Linear triggers
- [ ] Scheduled agents
- [ ] Mobile push notifications
- [ ] Browser/device session management
- [ ] Optional persisted browser history cache after defining encryption,
      per-account eviction, logout clearing, and storage limits; current chat
      caching is intentionally process-memory-only

## Repository and release boundaries

- [ ] Re-evaluate extracting AO Cloud only when separate release ownership or
      licensing justifies a second module/repository
- [ ] If extracted, move shared packages out of Go `internal`, version the
      contracts, and run local/cloud compatibility suites before splitting
- [ ] Decide commercial/open-source packaging independently of runtime
      architecture; do not maintain a duplicate cloud fork merely for policy
- [ ] Add signed worker images, provenance, SBOM publication, vulnerability
      scanning, and digest-pinned rollback

## Later billing and policy

- [ ] Revisit the initial 30-minute idle pause, 7-day completed-sandbox, and
      30-day event/log retention defaults using measured cost and recovery data
- [ ] Define maximum sandbox lifetime and per-plan keep-alive limits
- [ ] Define project snapshot retention, invalidation, and hard-deletion timing
- [ ] Team-level compute allocation
- [ ] Model-token billing and chargeback
- [ ] Storage billing
- [ ] Cost-center tags
- [ ] Policy hierarchy across deployment, organization, team, project, and user
- [ ] Approval policy for sensitive Git and external side effects
