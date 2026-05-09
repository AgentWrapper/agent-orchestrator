---
"@aoagents/ao-cli": minor
---

Add `AO_PUBLIC_URL` environment variable for users running AO behind a reverse proxy (remote dev containers, VPS deployments, internal tooling). When set, all user-facing dashboard URLs — `ao start` / `ao dashboard` console output, `ao open` browser launches, and `projectSessionUrl()` links surfaced to the orchestrator agent — use the public URL instead of `http://localhost:<port>`. Internal IPC (`daemon.ts` reload calls) still uses localhost since that traffic stays on the host.
