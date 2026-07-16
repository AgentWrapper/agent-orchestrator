# 2. Store SCM credentials in the operating system vault

Date: 2026-07-16
Status: Accepted

## Context

AO stores application state under `~/.ao`, but SCM access tokens are credentials,
not ordinary application state. Storing token bytes in SQLite or a plaintext file
would expose them through backups, diagnostics, and routine database inspection.
Encrypting a token with a key stored beside it under `~/.ao` would not create a
meaningful security boundary.

Desktop installations on macOS, Linux, and Windows already have native credential
vault APIs. Headless Linux environments may not have a Secret Service provider.

## Decision

Persist only SCM connection metadata and an opaque `credential_ref` in SQLite.
Persist desktop secrets through `github.com/zalando/go-keyring`, which delegates to
macOS Keychain, Linux Secret Service, or Windows Credential Manager. The adapter
is behind the `CredentialStore` port and an injected backend interface so tests do
not access the user's vault.

The OS vault is the deliberate exception to the rule that AO state lives under
`~/.ao`: its storage location and protection are owned by the operating system.
AO must not add a plaintext credential file or a file-encryption key under
`~/.ao` as a fallback.

Headless deployments without a usable OS credential vault supply credentials by
environment variable. In particular, later GitLab credential resolution may read
`AO_GITLAB_TOKEN` in memory, but must not persist it. Failure to reach Secret
Service is an error, not permission to fall back to a plaintext file.

## Consequences

- SQLite backups and connection read APIs contain metadata and credential
  references, never token bytes.
- Desktop secret persistence follows the security and unlock behavior of the OS.
- Headless operators must provision environment variables when no vault service is
  available.
- Moving an AO data directory does not move credentials; references must be
  reconfigured on a machine whose vault lacks the corresponding entry.
