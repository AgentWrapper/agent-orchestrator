# Daytona Cloud Agents v6 Plan

**Status:** Plan; supersedes `daytona-v5-plan.md` for implementation  
**Scope:** Add an isolated Cloud tab to the existing Electron app. Run AO and Codex inside one Daytona sandbox. Keep all existing local behavior unchanged.

## 1. Goal

The desktop app should support two independent modes:

```text
Local tab
  -> local AO daemon
  -> local repositories and worktrees

Cloud tab
  -> signed Daytona preview URL
  -> AO daemon inside a Daytona sandbox
  -> cloud repository, worktrees, tmux and Codex
```

The Cloud tab uses the existing AO React interface. It changes the AO API base URL; it does not run another Electron app inside the sandbox.

One cloud workspace initially means:

- one Daytona sandbox;
- one AO daemon;
- one SQLite database;
- one selected GitHub repository;
- one or more AO/Codex sessions inside that repository.

The repository is the workspace identity. The same normalized GitHub repository reuses its existing
sandbox; a repository that has not been configured before gets a new sandbox. Switching repositories
does not overwrite or delete the previous sandbox.

There is no separate coordinator, Azure VM, Caddy server or Postgres database in v1.

## 2. Decisions carried forward from v5

- The complete AO backend runs inside one Daytona sandbox.
- AO continues to use its existing tmux runtime and git-worktree workspace adapter.
- SQLite remains the v1 database and lives under `~/.ao` in the sandbox.
- Codex credentials also live under the sandbox's `~/.ao` tree through `CODEX_HOME`.
- Stop/start preserves the sandbox disk. Delete removes the workspace and all local sandbox state.
- `AutoStopInterval: 0` and `AutoPauseInterval: 0` are used during the experiment so a quiet daemon is not stopped unexpectedly.
- The sandbox image is built from the original `AgentWrapper/agent-orchestrator` source, not a fork.
- The v1 sandbox ceiling remains 4 vCPU, 8 GB RAM and 10 GB disk.
- A proper off-sandbox persistence design remains deferred. Postgres is not required for the first cloud experiment.

## 3. Changes from v5

The smoke test clarified the architecture:

- Electron runs only on the user's laptop. Do not run `npm run dev` or Electron inside Daytona.
- AO stays on its normal loopback listener, `127.0.0.1:3001`.
- Daytona's preview proxy exposes sandbox port `3001` over HTTPS.
- The old v5 plan to enable the Connect Mobile listener on `0.0.0.0:3011` is removed.
- The Electron renderer talks directly to a short-lived **signed preview URL**. There is no local HTTP proxy and no background SSH tunnel in this experiment.
- The Daytona API key and GitHub token are managed by Electron's main process, not by the renderer.
- GitHub CLI and GitHub credentials must be added before the pull-request smoke test.
The smoke test has already shown:

- the Dockerfile can build AO from the original source;
- a Daytona sandbox can run the AO daemon;
- AO becomes healthy at `127.0.0.1:3001/readyz`;
- a signed Daytona preview URL reaches port `3001`;
- the preview returns `502` when the daemon is stopped, as expected;
- Electron cannot and should not be displayed in the headless sandbox.

Still to prove before full UI work: AO's `/mux` WebSocket and SSE streams through the signed preview URL.

## 4. Component responsibilities

### Electron renderer

The renderer owns presentation only:

- show Local and Cloud tabs;
- show cloud setup and connection status;
- collect setup fields and send them to Electron main through narrow IPC calls;
- receive a short-lived signed AO preview URL;
- create a cloud AO client whose base URL is the signed preview URL;
- connect REST, SSE and `/mux` WebSocket traffic directly to Daytona;
- refresh visible data and reconnect streams when the URL changes.

The renderer must not receive the Daytona API key or persist credentials in React state, local storage, session storage or logs. The renderer may receive the signed preview URL because it needs that URL to connect directly; treat it as a short-lived secret.

### Electron main process

Electron main is the cloud workspace supervisor, not an AO coordinator. It owns:

- encrypted credential storage under `~/.ao/electron`;
- Daytona SDK/API calls;
- create, find, start, stop, archive and delete operations;
- sandbox bootstrap commands;
- Codex device-auth PTY and output relay;
- GitHub credential injection and repository clone;
- starting and checking the AO daemon;
- generating and refreshing signed preview URLs;
- returning non-secret status and the current signed preview URL to the renderer.

The existing local-daemon supervisor remains unchanged and continues serving the Local tab.

### Daytona sandbox

The sandbox owns all cloud execution state:

- baked `ao` binary;
- `ao daemon` on `127.0.0.1:3001`;
- SQLite and AO state under `/root/.ao/data`;
- Codex login under `/root/.ao/codex`;
- selected repository under `/workspace/<repo>`;
- git worktrees and tmux sessions;
- GitHub authentication used for clone, push and pull requests.

## 5. Credentials and onboarding

The first Cloud-tab setup screen asks for:

1. **Daytona API key** - create and manage the user's sandbox.
2. **GitHub repository** - owner/name or repository URL to clone into the cloud workspace.
3. **GitHub fine-grained PAT** - v1 authentication for private clone, push and pull requests.
4. **Git author name and email** - required for agent commits.
5. **Codex authentication choice** - ChatGPT device authorization for the experiment, with `OPENAI_API_KEY` as a later optional path.

Recommended v1 fine-grained PAT permissions for the selected repository:

- Metadata: read;
- Contents: read/write;
- Pull requests: read/write;
- Checks/statuses: read;
- Workflows: only if agents must edit workflow files.

The PAT must not be placed in a clone URL, printed, or written into normal git config. Install `gh` in the image and use a credential-helper or similarly scoped runtime mechanism. A GitHub App with short-lived installation tokens should replace PAT onboarding after the experiment.

Secret rules:

- setup fields are rendered by React but submitted immediately to Electron main;
- Electron main stores only encrypted ciphertext under `~/.ao/electron`;
- secrets are never sent through renderer logs or telemetry;
- only the selected sandbox receives the GitHub credential it needs;
- the Daytona API key never enters the sandbox;
- Codex device credentials remain in the sandbox's `CODEX_HOME`;
- signed preview URLs are short-lived and are never stored as permanent credentials.

## 6. First-time cloud setup flow

### Repository-to-sandbox mapping

Electron main stores an encrypted local mapping under `~/.ao/electron`:

```text
github.com/owner/repository -> Daytona sandbox ID
```

Normalize SSH URLs, HTTPS URLs, optional `.git` suffixes and owner/repository case before lookup. Then:

- if the normalized repository already maps to an existing sandbox, start or reuse that sandbox;
- if the mapping exists but the sandbox was deleted, create a replacement and update the mapping;
- if the repository is new, create a new sandbox and record the mapping;
- never repurpose an old repository's sandbox for a different repository;
- when switching repositories, keep the previous sandbox stopped or unchanged so switching back can reuse it.

Different branches of the same repository use the same sandbox. The AO project/worktree model handles
branch-level isolation inside that sandbox.

```text
User opens Cloud tab
  -> enters Daytona key, repository, GitHub PAT and git identity
  -> Electron main validates the Daytona key
  -> main normalizes the repository and checks the repository-to-sandbox mapping
  -> known repository: main starts or reuses its existing sandbox
  -> new repository: main creates a new sandbox and saves the mapping
  -> sandbox is built from the AO Dockerfile/snapshot
  -> main creates ~/.ao and /workspace directories
  -> main configures git identity and temporary GitHub authentication
  -> main clones the selected repository
  -> main opens Codex device authentication through a Daytona PTY
  -> renderer displays the URL and device code
  -> user approves on the laptop
  -> main starts `ao daemon` in the sandbox
  -> main waits for http://127.0.0.1:3001/readyz
  -> main registers the repository as an AO project
  -> main requests a signed Daytona preview URL for port 3001
  -> renderer points its cloud AO client at that URL
  -> existing AO screens load sessions, terminals and events from cloud AO
```

For v1, create the sandbox from the current Dockerfile on demand. Once the environment is stable, build a reusable Daytona snapshot to reduce startup time.

## 7. Normal launch and reconnection flow

Opening the desktop app must not automatically disturb either environment.

### Local tab

- discover/start the local AO daemon using the existing supervisor;
- use the local API base URL;
- show only local projects and sessions.

### Cloud tab

When opened:

1. Electron main normalizes the selected repository and looks up its mapped sandbox.
2. If stopped, it starts the sandbox.
3. It checks whether `ao daemon` is healthy and starts it if necessary.
4. It requests a new signed preview URL for port `3001`.
5. The renderer sets the cloud client's API base URL.
6. The renderer opens REST, SSE and `/mux` connections.

The initial signed-link lifetime should be one hour. Electron main refreshes it before expiry and sends the replacement URL to the renderer. The renderer then recreates the affected AO streams and retries failed requests. The maximum signed-link lifetime is 24 hours, but automatic refresh is still required.

Expected UI states:

- Not configured;
- Creating sandbox;
- Waiting for Codex approval;
- Starting AO;
- Connected;
- Reconnecting;
- Stopped;
- Error with a retry action.

## 8. Local/cloud isolation

The Cloud tab must not interfere with local AO:

- maintain separate local and cloud API-client instances;
- use separate query/cache keys that include the connection mode or workspace ID;
- never send a cloud action to the local API base URL or the reverse;
- do not stop the local daemon when the cloud tab closes;
- do not stop the sandbox when the Local tab is selected;
- clearly label project/session origin as Local or Cloud;
- keep cloud configuration separate from local daemon discovery state;
- clear cloud in-memory session state when disconnecting or changing sandboxes.

One tab may be selected at a time, but local and cloud sessions may continue running independently underneath.

## 9. Signed preview behavior

For the experiment, the renderer connects directly to a signed URL such as:

```text
https://3001-<signed-token>.<daytona-preview-domain>
```

The `3001` prefix tells Daytona to forward traffic to AO's port `3001` inside the sandbox. The token is embedded in the hostname, so browser `fetch`, EventSource and WebSocket connections do not need a custom preview-token header.

Important behavior:

- the signed URL is a credential;
- it expires and must be regenerated;
- expiry does not stop the sandbox or AO;
- a valid URL returns `502` when no process is listening on port `3001`;
- a newly created URL replaces the renderer's full API base URL, including WebSocket/SSE origins;
- the Electron CSP and AO origin checks must allow the active Daytona preview domain;
- no public sandbox mode is required.

If signed-preview WebSocket or SSE behavior fails acceptance testing, the fallback is a main-process transport or SSH tunnel. Do not implement the fallback before the direct-preview spike is complete.

## 10. Sandbox process model

Do not run the frontend inside Daytona. The minimum sandbox processes are:

```text
PID 1 / sandbox entrypoint
  -> AO daemon supervisor or persistent tmux session
  -> AO-created tmux sessions for Codex agents
```

The experiment can continue using tmux for the daemon. The product flow should eventually make daemon startup idempotent and automatic after every sandbox start.

Stopping a sandbox terminates active processes but preserves disk. Starting it again must:

1. restart the sandbox;
2. restart AO;
3. reuse SQLite and Codex login state;
4. obtain a fresh signed preview URL;
5. reconnect the Cloud tab.

## 11. Implementation phases

### Phase A - Finish the smoke test

- remove the unnecessary frontend install and `ao-frontend` tmux process from the smoke design;
- verify signed-preview `/readyz` from the laptop;
- verify `/mux` WebSocket and both SSE streams;
- install `gh`, configure a test token and git identity;
- register the test repository, spawn Codex, make a commit, push and open a PR;
- stop/start the sandbox and verify AO/Codex state recovery.

### Phase B - Cloud tab shell

- add Local and Cloud navigation without changing local behavior;
- add setup, connection-status and retry states;
- create separate local/cloud client contexts and cache namespaces.

### Phase C - Electron main Daytona supervisor

- add narrow IPC contracts for credentials and lifecycle actions;
- validate/store encrypted credentials;
- list/create/start/stop/delete the configured sandbox;
- report progress without returning raw credentials.

### Phase D - Automated sandbox bootstrap

- configure git identity and GitHub authentication;
- clone the selected repository;
- relay Codex device authorization to the setup screen;
- start AO idempotently and register the AO project.

### Phase E - Direct cloud AO connection

- generate a one-hour signed preview URL for port `3001`;
- set the cloud AO client base URL;
- support REST, SSE and `/mux` WebSocket through that URL;
- refresh the URL before expiry and reconnect cleanly;
- update CSP/origin configuration narrowly for Daytona preview domains.

### Phase F - Full workflow acceptance

- spawn and prompt a Codex session from the Cloud tab;
- display live terminal output;
- resume and send follow-up prompts;
- show session status consistently after tab switches and app restart;
- push a branch and open a GitHub PR;
- prove no local AO project/session was modified.

### Phase G - Lifecycle and hardening

- stop, start, archive and delete controls with clear destructive confirmation;
- reconnect after app restart, network loss and sandbox restart;
- redact secrets and signed URLs from logs;
- add expiry, retry and partial-bootstrap recovery;
- decide automatic idle-stop policy after the experiment.

## 12. Acceptance criteria

The Electron cloud experiment is complete when:

- the Local tab behaves exactly as before;
- the Cloud tab can create or reuse a Daytona sandbox;
- selecting the same repository reuses its mapped sandbox and persisted state;
- selecting a new repository creates a separate sandbox without modifying the old one;
- Codex device auth can be completed from the Cloud-tab flow;
- the selected GitHub repository is cloned and registered automatically;
- the renderer reaches AO through a signed preview URL;
- REST, SSE and `/mux` WebSocket all work;
- prompts and live terminal output work from Electron;
- AO can commit, push and open a PR;
- signed-link renewal does not require user action;
- sandbox stop/start preserves AO data and Codex login;
- cloud actions never appear in the local AO database;
- no Daytona API key or GitHub PAT reaches renderer storage or logs.

## 13. Deferred

- GitHub App/OAuth replacing the v1 PAT;
- a hosted control plane for users who should not supply their own Daytona key;
- mobile access through an authenticated cloud gateway/custom preview proxy;
- serving a standalone web/mobile UI;
- durable off-sandbox backup or Postgres migration;
- multi-sandbox fan-out and a unified cross-sandbox view;
- custom preview domain;
- autoscaling and production idle-cost policy;
- per-agent sandbox isolation.

Mobile can temporarily use a signed preview URL for API experiments, but a production mobile client must not receive the Daytona API key. A cloud gateway will eventually own Daytona credentials, user authentication, workspace lookup and preview-token refresh.

## 14. Immediate next step

Complete Phase A before changing the Electron app. In particular, prove `/mux`, SSE and a GitHub PR through the current sandbox. Then implement Phase B as a UI/client-isolation slice before automating sandbox creation and credentials.
