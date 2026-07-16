# Task 3 Report: SCM Connection Service and HTTP API

## Status

Complete on branch `codex/gitlab-provider-coordinator-wakeup` from task base
`44fab017`.

Commit subject: `feat: add SCM connection API`

## Delivered

- Added the global SCM connection service with create, list, get, update,
  delete, and test operations.
- Added GitHub and GitLab URL defaults plus GitLab `/api/v4` derivation.
- Enforced absolute HTTPS base URLs, with loopback HTTP as the only plaintext
  exception, and rejected credentials, queries, fragments, and relative URLs.
- Kept token input write-only. Read models expose metadata,
  `credentialConfigured`, normalized status, and optional username, but no token
  or credential reference.
- Preserved token presence semantics on update:
  - omitted token retains the existing credential and reference;
  - present non-empty token writes a new secret and removes the old one;
  - present empty token removes the credential.
- Added compensation for failed metadata/credential create, update, rotation,
  removal, and delete paths.
- Mapped referenced connection deletion to HTTP 409 and missing connections to
  HTTP 404 through structured API errors.
- Added provider-neutral connection-test results with bounded identity,
  capability, and status fields. Provider errors are replaced by redacted API
  errors; raw provider response bodies and tokens are never returned.
- Added all six REST routes under `/api/v1/scm/connections`, daemon wiring to
  the OS keyring-backed credential store, and nil-service 501 stubs used by
  partial/test configurations.
- Registered the operations and schemas in the code-first API spec and
  regenerated both OpenAPI YAML and frontend TypeScript types.

## TDD Evidence

### Inherited RED

The interrupted implementer's handoff recorded two RED stages before production
implementation. This resume preserved that work rather than deleting or
replaying it:

```text
go test ./internal/service/scmconnection
```

The service tests failed to compile because the new service types and methods
did not exist.

```text
go test ./internal/httpd/controllers ./internal/httpd
```

The controller/wiring tests failed to compile because `httpd.APIDeps` did not
yet have the SCM connection dependency and the controller routes were absent.

The handoff also recorded GREEN focused service/controller/httpd tests after the
minimal implementation was added. I did not manufacture a new RED by reverting
working inherited code.

### Resume Audit

I read the complete inherited diff and its callers before editing. No new
behavior defect was found, so no additional production-code RED/GREEN cycle was
needed. The audit checked:

- create/list/get/update/delete/test behavior and strict JSON decoding;
- `*string` token presence through HTTP decoding and service mutation;
- credential reference rotation and old/new secret cleanup;
- metadata restoration when credential deletion or reading fails;
- duplicate, missing, referenced, invalid-input, and internal error mapping;
- URL defaults, derivation, escaped paths, HTTPS enforcement, and loopback HTTP;
- normalized test statuses and raw provider error redaction;
- daemon/API dependency wiring and nil-service stubs;
- route/OpenAPI parity and generated artifact synchronization.

## Secret Boundary Verification

Service/controller tests prove that token bytes are accepted only as mutation
input, stored only through `CredentialStore`, and absent from every JSON read
response. They also reject an attempted `credentialRef` request field.

A structural OpenAPI check verified that `SCMConnection` has neither `token` nor
`credentialRef`, while `CreateSCMConnectionRequest.token` and
`UpdateSCMConnectionRequest.token` both have `writeOnly: true`.

The generated TypeScript schema likewise includes `token` only on the create and
update request types. It is absent from `SCMConnection` and response envelopes.

## Final Verification

Passed:

```text
cd backend && go test -count=1 ./internal/service/scmconnection ./internal/httpd/...
cd backend && go test -race -count=1 ./internal/service/scmconnection
npm run api
PATH=/opt/homebrew/opt/node@20/bin:$PATH npm --prefix frontend test
PATH=/opt/homebrew/opt/node@20/bin:$PATH npm --prefix frontend run typecheck
git diff --check
```

Results:

- focused backend service and all HTTP packages passed uncached;
- the focused service race test passed;
- API spec and TypeScript generation completed successfully;
- frontend Vitest passed 55 files and 596 tests;
- frontend TypeScript checking passed;
- the generated `frontend/src/renderer/routeTree.gen.ts` was removed and is not
  part of the Task 3 diff;
- `git diff --check` reported no whitespace errors.

The first frontend test attempt used the shell's Node 18.12.0 and failed during
Vitest startup, before test collection, because that runtime does not export
`node:util.styleText`. Repository CI pins Node 20. Re-running with the installed
Node 20.20.0 completed successfully with the results above.

## Scope and Residual Risk

Real GitHub/GitLab provider networking is intentionally not part of Task 3.
`ConnectionTester` is an injected provider-neutral boundary; daemon wiring does
not yet supply an implementation. A configured connection therefore returns the
structured redacted `SCM_CONNECTION_TEST_UNAVAILABLE` error until the later
provider/resolver tasks wire the real preflight. Missing credentials are already
reported locally as the normalized `missing_credential` status.

No resolver/provider GitLab networking or frontend UI code was changed. The only
frontend change is the generated API schema.
