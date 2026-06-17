# Session Replacement + PR Handoff — Design Plan

## Status

**Separate feature from PR claiming. Not implemented.**

The new `claim-pr` flow solves one problem: explicitly attaching an existing PR to a running AO session.

This document covers a different problem: **when the original owner session is no longer the right place to continue work, how should AO replace that session, transfer PR ownership, and preserve enough context for the new session to continue effectively?**

---

## Why This Is Separate

`claim-pr` establishes **PR ownership**.

Session replacement / handoff adds two more concerns that are not solved by `claim-pr` alone:

1. **Successor semantics** — how AO knows that session `app-12` is replacing `app-7`.
2. **Context continuity** — how the replacement session gets enough prior context to continue work without starting cold.

These are workflow and product questions, not just plumbing.

---

## Existing Capability

AO already has two adjacent primitives:

- **In-place restore**: restore the same session ID using existing metadata/workspace/runtime recovery.
- **PR claiming**: attach an existing PR to a session and optionally take it over from another session.

Those are related, but not the same as a true replacement flow.

### Important distinction

- **Restore** = revive the same logical session.
- **Replace / handoff** = create a new logical session that succeeds an old one.

A replacement flow needs explicit lineage, ownership transfer, and context transfer.

---

## Problem

Example:

- `app-7` owns PR `#123`
- CI fails or review changes arrive
- `app-7` is stuck, crashed, too confused, or otherwise not the right worker anymore
- AO wants to continue work in a fresh session `app-12`

Today, AO does not have a first-class notion that:

- `app-12` is the successor of `app-7`
- `app-12` should inherit the PR
- `app-12` should receive a usable summary of what `app-7` already did

That should be its own feature.

---

## Goal

Add a safe, explicit **session replacement + handoff** workflow that lets AO:

1. Create a replacement session for an existing worker.
2. Mark the new session as the successor of the old one.
3. Transfer PR ownership to the new session.
4. Preserve enough context for the new session to continue productively.
5. Ensure lifecycle/reactions route future CI/review work to the replacement session.

---

## Non-Goals

This feature should **not** initially try to:

- Guess successor relationships heuristically from branch names or issue IDs alone.
- Silently transfer PR ownership during normal polling.
- Move full conversational state between arbitrary agent tools unless a native resume primitive exists and is proven reliable.
- Preserve every detail of the old session transcript as a hard requirement.

For MVP, explicit replacement is better than clever inference.

---

## Recommended Product Shape

### User-facing workflow

Introduce a replacement-oriented command or API, such as:

```bash
ao session replace app-7
```

Potential options later:

```bash
ao session replace app-7 --reason stuck
ao session replace app-7 --claim-pr
ao session replace app-7 --carry-context
```

### Internal behavior

High-level flow:

1. Read session `app-7` metadata.
2. Spawn a new session `app-12`.
3. Mark `app-12` as successor of `app-7`.
4. If `app-7` owns a PR, call `claimPR("app-12", pr, { takeover: true })`.
5. Build a handoff context package for `app-12`.
6. Send that package to `app-12` as its first instruction, or launch it with that context.
7. Mark `app-7` as replaced/superseded so lifecycle and humans can see what happened.

---

## Core Design Principle

**Replacement must be explicit.**

AO should not assume that a fresh session is the successor of an older session unless:

- the orchestrator explicitly created it as a replacement, or
- metadata explicitly links the two sessions.

This avoids accidental PR hijacking and bad routing.

---

## Proposed Metadata Model

Add lineage metadata so the relationship is durable and inspectable.

### On the new session

```text
supersedes=app-7
handoffReason=stuck
handoffAt=2026-03-06T12:34:56.000Z
handoffContextMode=summary
```

### On the old session

```text
replacedBy=app-12
replacedAt=2026-03-06T12:34:56.000Z
status=replaced
```

Notes:

- `status=replaced` would likely be a new lifecycle status if we want it surfaced directly.
- If we do not want a new lifecycle status immediately, we can keep old status and rely on `replacedBy`, but that is less visible.

---

## PR Ownership Transfer

This part is now mechanically straightforward because `claimPR(...)` exists.

If the old session owns PR `#123`, replacement should do:

```ts
claimPR(newSessionId, "123", { takeover: true })
```

Expected result:

- new session becomes the PR owner
- PR branch is checked out in the replacement workspace
- old session loses PR ownership
- old session has PR auto-detect disabled so lifecycle does not reattach it by branch

This gives AO a clean single-owner model.

---

## Context Handoff: The Real Hard Part

This is the main reason the feature should be treated separately.

There are several possible levels of context carry-over.

### Option 1 — No transfer, just replace the worker

AO spawns a fresh session and only tells it what PR/issue to work on.

**Pros**
- simplest implementation
- lowest coupling to agent internals

**Cons**
- replacement session starts cold
- loses reasoning trail, failed attempts, prior decisions
- more likely to repeat work or miss subtle repo context

This is probably too weak for a good user experience.

---

### Option 2 — AO-generated handoff summary (recommended MVP)

AO constructs a structured handoff package from existing session state and gives that to the replacement session.

Example contents:

- issue ID / PR URL
- branch name
- latest agent summary
- last known status (`ci_failed`, `changes_requested`, etc.)
- recent terminal output excerpt
- unresolved review comments
- failing CI checks
- replacement reason (`stuck`, `crashed`, `manual takeover`)

Example first prompt:

```text
You are replacing session app-7.

Context:
- Issue: INT-1234
- PR: https://github.com/org/repo/pull/123
- Branch: feat/INT-1234
- Previous session status: ci_failed
- Replacement reason: previous session became stuck
- Summary from previous session: implemented API validation and tests; CI failing in e2e
- Current failing checks: e2e / login flow
- Review comments still open: 2

You now own this PR. Continue from the current branch state. First inspect CI failures and confirm the current blocking issue before changing code.
```

**Pros**
- explicit and portable across agents
- works even without native resume support
- keeps the product behavior understandable

**Cons**
- summary may omit useful detail
- quality depends on how good the summary extraction is

This is the best MVP path.

---

### Option 3 — Native agent resume into successor workflow

Some agents already expose native resume semantics for the same underlying conversation/thread.

Examples in the current codebase:

- Codex agent supports a native `resume` flow.
- Claude Code agent supports a native `--resume` flow.

However, these are currently used for **restoring the same session**, not necessarily transferring work to a brand-new successor session with a different AO identity.

Open questions:

- Can a new AO session safely wrap an old agent thread?
- Does the agent assume the same workspace path?
- Does resuming a thread into a new worktree cause confusion or hidden state mismatch?
- Can the runtime/plugin reliably expose the old thread ID for successor use?

**Pros**
- highest continuity if it works reliably
- preserves reasoning and full tool-use context

**Cons**
- agent-specific
- potentially fragile across workspace changes
- harder to reason about operationally

Recommendation: treat native resume as an **optional enhancement**, not the MVP baseline.

---

### Option 4 — Full transcript migration

AO could theoretically extract the old transcript and replay or summarize it into the new session.

This should **not** be the MVP.

Problems:

- privacy / verbosity concerns
- can be extremely long
- transcript replay is not the same as genuine state transfer
- tool outputs and local state may no longer match replayed text

Use summary, not transcript migration, for MVP.

---

## Recommended MVP

### MVP scope

Build a **manual, explicit replacement workflow** with **summary-based context handoff**.

### Suggested flow

1. User or orchestrator chooses to replace `app-7`.
2. AO spawns replacement session `app-12`.
3. AO records:
   - `app-12 supersedes app-7`
   - `app-7 replacedBy app-12`
4. AO transfers PR ownership via `claimPR(..., { takeover: true })`.
5. AO builds a structured handoff summary.
6. AO sends the summary to `app-12` immediately.
7. AO marks future lifecycle/reaction routing to `app-12`.

### Why this is the right MVP

- simple mental model
- explicit ownership
- no unsafe heuristics
- works across different agents
- does not depend on native conversation-resume semantics

---

## Suggested API Shape

### Core

Potential new core API:

```ts
sessionManager.replace(sessionId, options?)
```

Possible return shape:

```ts
{
  oldSessionId: "app-7",
  newSessionId: "app-12",
  projectId: "my-app",
  claimedPR: "https://github.com/org/repo/pull/123",
  contextMode: "summary",
}
```

### Internal helper

Potential helper for context packaging:

```ts
buildSessionHandoffContext(oldSession, project)
```

Output could be structured JSON or a formatted prompt block.

---

## Handoff Context Sources

The summary-based MVP can pull from existing AO state:

- session metadata
- agent summary (`summary`)
- PR URL / branch / issue metadata
- recent terminal output
- current lifecycle status
- failing CI checks
- unresolved review comments
- replacement reason

This is enough to make the new session useful without pretending to clone the old agent’s memory perfectly.

---

## Lifecycle / Routing Implications

After replacement:

- the replacement session should be the only active PR owner
- CI/review reactions should target the replacement session
- old session should not receive future automated PR-routing work
- dashboard / `ao session ls` should show the lineage clearly

This is where explicit lineage metadata matters.

---

## Open Questions

1. Should `replaced` be a first-class session status?
2. Should replacement always imply PR takeover if the old session has a PR?
3. Should the old session be killed immediately, or only marked superseded?
4. Should native resume be attempted for certain agents, or only after summary handoff is stable?
5. How much terminal output should be included in the handoff summary?
6. Should the replacement session reuse the old workspace, or always get a fresh workspace and rely on branch checkout?

---

## Risks

### Product risk

If replacement is too implicit, users may not trust why a new session suddenly “owns” a PR.

### Technical risk

Native resume across successor sessions may look attractive but be brittle if workspace/runtime assumptions differ.

### Operational risk

If old and new sessions both appear to own the same branch/PR, routing becomes confusing and reactions may duplicate work.

This is why explicit lineage + single-owner transfer is essential.

---

## Acceptance Criteria

A future implementation should satisfy:

- A replacement session is explicitly linked to the session it supersedes.
- If the old session owned a PR, the new session can take it over cleanly.
- Future CI/review reactions route only to the replacement session.
- The replacement session receives a usable handoff context package.
- The user can see replacement lineage in AO metadata / UX.
- The workflow is explicit and inspectable, not heuristic magic.

---

## Recommendation

Yes — this should absolutely be treated as a **separate feature** from PR claiming.

Recommended order:

1. **PR claiming** — done first, because it provides the ownership-transfer primitive.
2. **Replacement lineage + summary handoff** — next, as the real workflow feature.
3. **Optional native resume enhancements** — later, agent by agent, only if they are reliable.

That sequencing keeps the system understandable and avoids mixing ownership transfer with the much harder question of conversational continuity.
