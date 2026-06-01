# Mobile Access V1

Mobile Access V1 lets a user expose the AO dashboard through a temporary Cloudflare quick tunnel and open it from another device with a QR code. This document describes the implementation in this branch, not the more hardened token-session design from the earlier mobile access proposal.

## Goals

- Let a user access the dashboard from a phone or another network without manual VPN setup.
- Keep local dashboard access simple on `localhost`.
- Protect the public dashboard URL with credentials.
- Route terminal WebSocket traffic through the same protected public origin.
- Allow the user to enable, disable, and update credentials from the dashboard.

## User Flow

1. The user starts AO normally, then clicks the desktop-only Remote button in the dashboard.
2. AO downloads `cloudflared` if needed and starts a Cloudflare quick tunnel to the local dashboard.
3. The dashboard shows the public URL, QR code, username, and password.
4. The user scans the QR code from mobile and signs in with Basic Auth.
5. The user can update credentials or disable remote access from the same modal.

Remote access is a runtime toggle. `ao start` starts AO normally; the tunnel is created only when the user clicks Remote in the running dashboard.

## Implementation

The dashboard path is handled by `/api/remote-info`:

- `GET` returns current remote access state.
- `POST` enables remote access and starts a tunnel.
- `PATCH` saves remote credentials.
- `DELETE` disables remote access and stops the tunnel.

Credentials are read from the global config, with process environment variables still available as an override for development and tests:

```text
~/.agent-orchestrator/config.yaml
```

The stored shape is:

```yaml
remoteAccess:
  username: ao
  password: example-password
```

`cloudflared` is cached under:

```text
~/.agent-orchestrator/bin/
```

## Security Model

V1 uses Basic Auth for the public dashboard URL:

- `localhost`, `127.0.0.1`, and `[::1]` bypass Basic Auth so local use stays frictionless.
- Public remote access requires `AO_REMOTE_AUTH_USER` and `AO_REMOTE_AUTH_PASSWORD`.
- Terminal WebSocket traffic is proxied through the dashboard origin and authenticated with the same credentials.
- Direct terminal WebSocket connections also validate the active remote credentials.

The V1 credential store is intentionally simple: credentials are persisted in plaintext in the local AO global config. This is acceptable for V1 because the threat model is a user-controlled development machine plus a temporary tunnel, not a multi-user hosted service.

## What This V1 Does Not Implement

The earlier mobile access proposal described a stronger mobile-auth system. This branch does not implement those pieces:

- No URL-fragment token login flow.
- No `/api/mobile/login` endpoint.
- No signed HttpOnly session cookie.
- No token TTL or session TTL.
- No persisted lockout counter.
- No `mobile.json` token/hash/HMAC store.
- No revoke-all-sessions endpoint.
- No explicit WebSocket origin pinning beyond the current proxy/auth checks.

Those are good candidates for a hardened V2 if remote access becomes a long-lived or broader security surface.

## Current Scope

This V1 should be described as:

> Remote dashboard access through Cloudflare quick tunnel plus Basic Auth.

It is enough for a pragmatic first release because it solves the main product problem: scan a QR code, open the dashboard from mobile, and keep the public URL credential-protected.
