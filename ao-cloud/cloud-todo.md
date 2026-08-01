# AO Cloud TODO

These items must be completed before AO Cloud is exposed as a public,
multi-tenant hosted service.

## GitHub App and tenant isolation

- Replace the deployment-wide `AO_GITHUB_TOKEN` with an AO GitHub App.
- Let each user connect their own GitHub account or organization installation.
- Store installation credentials per account and keep them out of worker
  environments.
- Verify repository grants when listing repositories, creating projects, and
  proxying Git operations.
- Disable the static-token fallback outside explicitly local development.

## Enrollment, rate limiting, and sandbox quotas

- Gate public enrollment until hosted signup is intentionally enabled.
- Rate-limit signup, login, session creation, and provider-connection
  validation.
- Enforce durable per-account and deployment-wide limits for active,
  provisioning, and recently created sandboxes.
- Return clear retry and quota errors without starting provider work.
- Add abuse and concurrent-provisioning tests.

## Reconciliation lease safety

- Renew sandbox reconciliation leases while provider operations are running.
- Do not claim more sandboxes than one reconciler can process before their
  leases expire.
- Size leases and renewal intervals against the maximum provider timeout.
- Add multi-control-plane tests proving that slow Daytona operations cannot be
  reclaimed and mutated concurrently.

## Daytona API URL SSRF protection

- Treat a user-supplied Daytona API URL as untrusted input.
- Require HTTPS and restrict connections to configured, allowlisted Daytona
  origins.
- Reject loopback, private, link-local, metadata-service, and other
  non-public destinations after DNS resolution.
- Revalidate redirects and resolved destinations for every provider request.
- Add tests covering alternate URL forms, redirects, DNS rebinding defenses,
  and blocked private-network targets.

## Coding-agent credential validation

- Implement real validation for Claude Code, Codex, and Cursor credentials.
- Do not mark credentials usable based only on format, prefix, or non-empty
  input.
- Keep credentials in an explicit pending or unverified state when validation
  is unavailable.
- Prevent project or sandbox provisioning with unverified credentials.
- Distinguish invalid credentials from transient provider failures and test
  both paths.

## Local and Cloud semantic parity

- Define a small storage-free shared contract for behavior that must match:
  session kind, harness capability, activity state, lifecycle commands,
  derived-status inputs, workspace-file/diff results, and normalized SCM facts.
- Keep SQLite and PostgreSQL schemas, runtime adapters, and local/cloud-only
  APIs separate. Do not put accounts, sandboxes, worker tickets, or persistence
  records in the shared contract.
- Generate the cloud browser client from a versioned cloud API schema; remove
  the manually maintained request/response types in `cloud-api.ts`.
- Add shared fixture-based conformance tests for portable behavior: lifecycle
  mutations, blocked/interrupt behavior, status derivation, agent events, SCM
  facts, and workspace diffs.
- Maintain a capability matrix documenting operations that intentionally differ,
  such as local worktrees/tmux/filesystem access and cloud organizations,
  sandboxes, tickets, and quotas.
