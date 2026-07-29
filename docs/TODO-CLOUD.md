# AO Cloud Deferred Work

This file records intentionally deferred cloud work so Cloud Agent V1 can stay
personal-account-first without closing the architecture to organizations and
additional providers.

Items here are not permission to ship visible placeholders. A deferred feature
must remain absent from the production UI until it has a real implementation.

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

GitHub App integration is the only source-control target for Cloud V1.

## Local/cloud portability

- [ ] Move an existing local session to cloud
- [ ] Transfer dirty tracked and untracked files safely
- [ ] Transfer conversation and native agent resume identity
- [ ] Move or continue a cloud session locally
- [ ] Optional local/cloud account metadata synchronization
- [ ] Conflict and ownership rules when both sides changed

No local/cloud database synchronization is part of Cloud V1.

## Additional execution modes and providers

- [ ] Re-test Daytona outbound HTTPS from a fresh sandbox and document provider
      egress requirements; the 2026-07-30 US container test reset TLS
      connections even with `networkBlockAll=false`
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
