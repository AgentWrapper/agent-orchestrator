# AO Cloud TODO

These are the remaining items before AO Cloud is exposed as a public,
multi-tenant hosted service.

The core app model is already cloud-shaped: users, organizations,
memberships, invitations, projects, sessions, workers, provider connections,
SCM facts, terminal/preview tickets, and workspace RPC are controlled by the
Control Plane and scoped by organization. The current schema should not need a
large redesign for hosted launch. Hosted work should plug WorkOS and
GitHub App integration into the existing AO user/org tables rather than
replacing them.

## Hosted auth and organization mapping

- WorkOS browser session wiring is implemented behind
  `AO_CLOUD_AUTH_MODE=workos`.
- WorkOS JWT/JWKS verification is implemented in the Go CP and maps
  external users into `ao_users` using `auth_provider` and `external_user_id`.
- Keep WorkOS as the identity/session provider only; AO-owned authorization
  remains in `ao_users`, `ao_organizations`, `ao_org_memberships`, and
  `ao_org_invitations`.
- Link a WorkOS organization through `ao_organizations.external_org_id` only
  when an enterprise customer enables SSO/SCIM. Personal and ordinary team
  workspaces remain AO-owned and do not need WorkOS organizations.
- Decide hosted product mode before launch: solo-first personal orgs,
  org-first, or no personal projects. Enforce the mode in CP policy, not by
  changing the core schema.
- Verify local-auth and WorkOS requests hit the same CP authorization
  paths for org membership, role checks, terminal tickets, preview tickets,
  provider connections, projects, sessions, and invitations.
- Hosted WorkOS signup is invite-gated by default via
  `AO_CLOUD_ALLOW_PUBLIC_SIGNUP=false`. Before open signup, add quotas and rate
  limits.

## GitHub App and repository grants

- Replace local `gh auth token` with an AO GitHub App in hosted deployments.
- Let each user or organization connect a GitHub App installation.
- Add durable GitHub App installation and repository-grant tables.
- Store installation metadata and short-lived token exchange state in the CP;
  never bake or pass broad GitHub credentials into worker images.
- Verify repository grants when listing repositories, creating projects,
  observing SCM, claiming PRs, merging PRs, resolving review comments, and
  proxying Git operations.
- Keep local `gh` token support limited to explicit local development.

## Hosted deployment configuration

- Build and publish immutable CP and worker images with no baked credentials.
- Wire hosted frontend, CP, preview, terminal websocket, and callback URLs from
  environment-specific config.
- Run Postgres migrations as part of the hosted deploy path.
- Configure hosted secrets for WorkOS, GitHub App, sandbox provider, coding
  agent credential encryption, and any OAuth callbacks.
- Verify browser -> CP -> worker -> CP flows end-to-end with hosted URLs:
  sign in, org switch, invite accept/decline, role update, project create,
  orchestrator start, worker spawn, terminal attach, workspace inspector,
  preview, SCM/PR status, merge/review-thread actions, and deletion.

## Hosted launch wiring checklist

- Provision two public HTTPS origins, for example
  `https://app.example.com` for the Next.js site and
  `https://cloud.example.com` for the CP. Point DNS at their respective hosts;
  expose the CP through TLS ingress only, not its Postgres or internal listener.
- Run the site as a Next.js server rather than a static export so WorkOS
  AuthKit middleware, callback, session, and logout route handlers remain
  available.
- Configure the site with:
  - `NEXT_PUBLIC_API_URL=https://cloud.example.com`
  - `NEXT_PUBLIC_WEB_URL=https://app.example.com`
  - `NEXT_PUBLIC_AO_AUTH_MODE=workos`
  - server-only `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and a stable
    `WORKOS_COOKIE_PASSWORD`
  - `WORKOS_REDIRECT_URI` and `NEXT_PUBLIC_WORKOS_REDIRECT_URI` set to
    `https://app.example.com/callback`
- Configure the WorkOS dashboard with:
  - redirect URI `https://app.example.com/callback`
  - application homepage `https://app.example.com`
  - initiate-login URI `https://app.example.com/auth/workos/sign-in`
  - sign-out URI `https://app.example.com/auth`
  - allowed web origin `https://app.example.com`
- Configure the CP with `AO_CLOUD_PUBLIC_URL=https://cloud.example.com`,
  `AO_WEB_PUBLIC_URL=https://app.example.com`,
  `AO_CLOUD_AUTH_MODE=workos`, the same WorkOS client ID and server-only API
  key, and the intended `AO_CLOUD_ALLOW_PUBLIC_SIGNUP` policy. The exact web
  origin is the CP CORS boundary.
- Configure durable Postgres connectivity and backups. Keep
  `AO_ENCRYPTION_KEY`, `AO_WORKER_SIGNING_KEY`, database credentials, and
  `WORKOS_API_KEY` server-only and stable across deployments; never expose
  them through `NEXT_PUBLIC_*`.
- Configure the hosted sandbox provider with its API key and an immutable
  worker snapshot built from the same release as the CP.
- Let the CP apply embedded migrations on startup and verify `/readyz` before
  directing browser or worker traffic to the deployment.
- Bootstrap the first owner before enabling invite-gated production access.
  An empty database with `AO_CLOUD_ALLOW_PUBLIC_SIGNUP=false` has no existing
  owner who can create an invitation. Bootstrap privately with public signup
  temporarily enabled, then disable it and use AO invitations.
- Before enabling unrestricted public signup, implement signup/session rate
  limits and per-organization sandbox quotas.
- WorkOS organizations are not required for launch. WorkOS proves identity;
  AO Postgres remains authoritative for organizations, invitations,
  memberships, and roles.

## Enrollment, rate limiting, and sandbox quotas

- Keep public enrollment gated unless `AO_CLOUD_ALLOW_PUBLIC_SIGNUP=true` is
  intentionally enabled for a controlled beta.
- Rate-limit signup, login, session creation, and provider-connection
  validation.
- Enforce durable per-org and deployment-wide limits for active,
  provisioning, and recently created sandboxes.
- Return clear retry and quota errors without starting provider work.
- Add abuse and concurrent-provisioning tests.

## Reconciliation lease safety

- Renew sandbox reconciliation leases while provider operations are running.
- Do not claim more sandboxes than one reconciler can process before their
  leases expire.
- Size leases and renewal intervals against the maximum provider timeout.
- Add multi-control-plane tests proving that slow provider operations cannot be
  reclaimed and mutated concurrently.

## Provider and credential hardening

- Treat user-supplied provider API URLs as untrusted input.
- Require HTTPS and restrict connections to configured, allowlisted provider
  origins.
- Reject loopback, private, link-local, metadata-service, and other
  non-public destinations after DNS resolution.
- Revalidate redirects and resolved destinations for every provider request.
- Implement real validation for Claude Code, Codex, Cursor, and sandbox
  provider credentials.
- Keep credentials in pending or unverified state when validation is
  unavailable.
- Prevent project or sandbox provisioning with unverified credentials.
- Add tests covering invalid credentials, transient provider failures,
  redirects, DNS rebinding defenses, and blocked private-network targets.

## API and contract hygiene

- Generate the cloud browser client from a versioned Cloud API schema; remove
  manually maintained request/response drift in `cloud-api.ts`.
- Shared storage-free contracts for portable AO semantics are implemented in
  `backend/internal/contract` and are used for session kind, activity state,
  lifecycle command names, derived status, workspace diff/status concepts, and
  normalized SCM facts.
- Expand conformance coverage beyond the current shared status fixtures so
  lifecycle mutations, blocked/interrupt behavior, agent events, workspace
  diffs, and SCM facts have explicit local/cloud fixture tests.
- Add a capability matrix documenting intentional local/cloud
  differences: local worktrees/tmux/filesystem access versus cloud
  organizations, sandboxes, tickets, quotas, and hosted auth.
