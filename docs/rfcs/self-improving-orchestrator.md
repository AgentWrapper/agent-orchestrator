# RFC: Self-improving orchestrator

**Issue:** [#1459](https://github.com/ComposioHQ/agent-orchestrator/issues/1459)
**Status:** Draft — design for discussion
**Author:** ao-29 (orchestrator worker session)
**Depends on:** #1457 (observability), does not require #855 / #336 / #1414
**Related:** #1454, #1455, #1456, #1458 (fault classes that form the phase-1 test corpus), #1252 (existing `ao doctor`)

---

## 1. Problem statement

On 2026-04-22 the operator ran a self-diagnose exercise on AO. The sequence was:

- 5 parallel Explore agents surveying subsystems
- A Codex second-opinion pass to catch hallucinations
- 23 parallel sub-agents filing GitHub issues, each cross-correlating with existing open/closed issues
- `batch-spawn` of 23 worker sessions with anti-over-engineering briefs
- **60+ minutes of manual cross-referencing** across `~/.agent-orchestrator/{hash}/sessions/`, `tmux list-sessions`, `ps`, `lsof`, and `lifecycle-status-decisions.ts` / `session-manager.ts` to understand state flicker, handle loss, and zombie tmux

The orchestrator pattern worked for discovery and fanout. What failed is the closing of the loop. Once the workers' PRs merged, **the same orchestrator session that filed the issues had no ergonomic way to re-run the same diagnosis and confirm the fix held.** Verification either happened manually or not at all — in practice not at all.

"CI green" is not verification. CI catches regressions against things that are tested. These bugs — state flicker, handle loss, orphan worktrees, duplicate tmux — live in the gap between what can be unit-tested and what can be observed in live runtime. Verifying a fix means **re-running the discovery procedure that surfaced the bug** and confirming the fault signature is gone.

The gap is structural, not motivational. This RFC proposes the minimum structure to close it.

## 2. Vision

When the operator says "self-diagnose," AO runs the full loop:

1. Read its own logs + live runtime + codebase to identify faults.
2. File GitHub issues with evidence, cross-correlated against existing issues, tagged with a stable `diagnosis-id`.
3. Spawn worker sessions per issue, embedding the `diagnosis-id` in session metadata.
4. After each worker PR merges, re-run that specific diagnosis; close the issue if clean, re-open with new evidence if not.
5. Feed recurring patterns back into `orchestrator-prompt.ts` / `memory/` so future orchestrators find the same faults faster.

Scope is explicitly **AO's own fault classes**. Not generalized AI ops. Not self-healing transitions. Not autonomous remediation. Just: find, file, spawn, verify, close.

## 3. Capabilities

### 3.1 `ao diagnose` — one-shot scan

Runs every registered diagnosis rule. Emits structured findings:

```jsonl
{"ruleId":"state-flicker","fingerprint":"ao-17","severity":"high","summary":"...","evidence":{...},"at":"2026-..."}
```

Fields match the `DiagnosisFinding` interface in §4.1 exactly. Any identifiers normally thought of as top-level (session id, workspace path) live in `evidence` unless they are also the `fingerprint`.

Flags:

- `--rule <id>[,<id>]` — run a subset
- `--json` / `--format=human` (default human)
- `--project <id>` — scope (defaults to all configured)
- `--since <duration>` — limit to sessions/events newer than

Exit codes: `0` clean, `1` findings present, `2` rules crashed.

### 3.2 `ao diagnose --triage`

Maps findings to GitHub issues.

- `--dry-run` (default): prints what would be filed, including the computed `<!-- ao-diagnose id=<id> fp=<percent-encoded-fingerprint> -->` marker used for dedupe.
- `--file`: actually files, after deduping against open AND closed issues that contain the same marker. Requires interactive `y/N` confirmation (or `--yes` to skip) when ≥1 issue would be filed — matches `gh`'s confirmation pattern and avoids accidental 20-issue batches.
- One issue per `(rule, fingerprint)` pair. Fingerprint is rule-defined (typically `sessionId` or `workspacePath` or the minimal tuple that makes findings distinct).
- Label applied: `ao-diagnosed`. The marker is the machine-readable dedupe key; the label is the human-readable filter.

**Marker format.** The marker uses key=value attributes rather than colon-delimited positional fields so fingerprints may contain arbitrary characters (Windows paths with `C:\`, compound keys like `project:session`, etc.) without breaking the parser:

```
<!-- ao-diagnose id=state-flicker fp=ao-17 -->
<!-- ao-diagnose id=orphan-worktree fp=C%3A%5Cworktrees%5Cao-42 -->
```

- `id` values are ASCII identifiers controlled by the rule author (`[a-z0-9-]+`) — no encoding required.
- `fp` values are **percent-encoded** per RFC 3986 unreserved-character rules. Parsing: match `/<!-- ao-diagnose id=([a-z0-9-]+) fp=(\S+) -->/`, then `decodeURIComponent` the fingerprint.
- Round-trip is total: any string the rule produces as a fingerprint can be encoded, stored in the marker, and decoded back byte-identical.
- The marker format is versioned by the `id=`/`fp=` attribute set. Adding new attributes is backward-compatible (unknown attributes are ignored); changing existing ones is not, and would require a new marker prefix (`ao-diagnose-v2`).

### 3.2.1 PR → issue resolution

See §5.1. The cascade is:

1. `session.issueId` from session metadata, if the PR was opened by an AO session we still have metadata for.
2. `gh pr view --json closingIssuesReferences` if (1) is unavailable (session archived, operator-invoked verify on an arbitrary PR).
3. If neither resolves a linked issue, `ao diagnose --verify` errors out explicitly rather than guessing.

No scraping of PR bodies or commit messages — only the two structured sources above.

### 3.3 `ao diagnose --verify <pr|issue>`

Given a PR or issue, extract the `<!-- ao-diagnose id=... fp=... -->` marker from the issue body (§3.2 format), look up the rule by `id`, decode the fingerprint, and re-run `rule.verify(ctx, fingerprint)` against current state.

Outputs:

- `pass` → if the rule has a tracker linked, apply the existing `verified` workflow (close issue, remove `merged-unverified`, add `verified`). Matches the current `ao verify` command's labels.
- `fail` → reopen issue, comment with the fresh evidence, add `verification-failed`.
- `indeterminate` → preserve status, comment noting the rule couldn't execute (missing runtime, insufficient data).

This command is the entire point of the RFC. It is what `ao verify` already does for human judgment — but driven by the same rule that found the bug.

### 3.4 Orchestrator spawn protocol

`ao spawn --from-issue <N>` (exists today via issue argument) gains one optional flag:

- `--verify-with <diagnosis-id>` — writes `verifyWith=<id>` into session metadata.

When the session's PR merges, the lifecycle reaction layer (or an operator-triggered `ao diagnose --verify <pr>`) looks up `verifyWith` from session metadata and runs the named rule. **No new reaction type is strictly required for MVP** — operator runs the command. Automating it is phase 2.

### 3.5 Memory integration

A recurring fingerprint (same rule firing N times across sessions) is surfaced by `ao diagnose --summary`. Promoting a pattern into `orchestrator-prompt.ts` or `memory/` stays human-gated. No code writes to those files autonomously. This is a reporting capability, not an automation.

## 4. Architecture

Minimum that fits the problem: **three files**, zero new plugin slots, zero new packages.

```
packages/core/src/diagnose.ts           # types + registry + runDiagnosis/verifyDiagnosis helpers
packages/core/src/diagnose-rules.ts     # static array of DiagnosisRule values, one per fault class
packages/cli/src/commands/diagnose.ts   # CLI surface
```

Rules are plain values in an array. If the list gets long enough to warrant splitting, split — don't pre-build a discovery/registration framework. YAGNI.

### 4.1 Rule contract

```typescript
// packages/core/src/diagnose.ts

export interface DiagnosisFinding {
  /** Stable rule identifier. */
  ruleId: string;
  /** Stable per-finding fingerprint used for issue dedupe. Typically a session id or path. */
  fingerprint: string;
  severity: "low" | "medium" | "high";
  summary: string;
  /** Minimal structured evidence — file:line, session snapshots, log excerpts. */
  evidence: Record<string, unknown>;
  at: string; // ISO timestamp
}

export interface DiagnosisContext {
  config: OrchestratorConfig;
  projects: ProjectConfig[];
  /** All sessions across all configured projects. */
  sessions: Session[];
  /** Convenience: read the project-level event stream (from #1457) when available. */
  readEvents?: (projectId: string, opts?: { since?: Date }) => AsyncIterable<Event>;
}

export interface DiagnosisRule {
  id: string;
  description: string;
  /** Scan current state, return zero or more findings. */
  detect(ctx: DiagnosisContext): Promise<DiagnosisFinding[]>;
  /**
   * Given a finding previously produced by detect(), re-run just the check
   * that produced it and say whether the fault is gone.
   * Most rules implement verify as: re-run detect() for the same fingerprint
   * and return "pass" iff no finding matches. Override only if detect() is
   * too expensive to re-run or needs different framing (e.g. verify-only evidence).
   */
  verify(ctx: DiagnosisContext, fingerprint: string): Promise<"pass" | "fail" | "indeterminate">;
}

export const diagnosisRules: DiagnosisRule[] = [
  stateFlickerRule,    // #1454
  handleLossRule,      // #1458
  duplicateTmuxRule,   // #1456
  unpolledProjectRule, // #1455
  // orphan-worktree, zombie-tmux, stale-terminated — added as rules stabilize
];
```

That is the whole contract. A rule is a `{id, description, detect, verify}` tuple. The "registry" is an exported array. Adding a fault class = adding one entry.

### 4.2 Why not a plugin slot

We already have 8 plugin slots. Each is an extension point for a replaceable **responsibility**: "where do agents run," "where are issues tracked." A diagnosis rule is none of those — it is a closed-world, internal check on AO's own state. The set of fault classes is known, small, and bounded by AO's architecture. Plugins optimize for "users can swap implementations"; diagnosis rules optimize for "maintainers can add one more check." An array is the right shape for the latter.

If a plugin ever needs to contribute rules (e.g. agent-codex has a codex-specific fault class), the plugin module can export `diagnosisRules: DiagnosisRule[]` and core concatenates them at load time. That's a one-liner extension, not a framework. Defer until it's actually needed.

### 4.3 Where code lives

| File | Size target | Responsibility |
|---|---|---|
| `packages/core/src/diagnose.ts` | <150 lines | Types, `runDiagnosis(ctx, ruleIds?)`, `verifyDiagnosis(ctx, ruleId, fingerprint)`, `fingerprintFromIssueBody(body)` helper |
| `packages/core/src/diagnose-rules.ts` | <300 lines for phase 1 | Four rule implementations |
| `packages/cli/src/commands/diagnose.ts` | <250 lines | Flag parsing, context assembly, output rendering, tracker calls for triage |

The CLI command orchestrates existing primitives: `loadConfig`, `createSessionManager`, `tracker.listIssues`/`createIssue`/`updateIssue`, the #1457 event stream if available. It does not introduce new IO patterns.

### 4.4 Why not extend `ao doctor`

`ao doctor` answers "is my install healthy": plugin resolution, notifier connectivity, version freshness, PASS/WARN/FAIL. It runs once, its findings are ephemeral, it does not file issues or link PRs.

`ao diagnose` answers "does AO have faults in its own runtime": stateful, persistent, evidence-bearing, cross-referenced with the issue tracker, re-runnable against a specific merged PR. Different command, different contract, same binary. Keep them separate; link them in help text.

## 5. Verification workflow

```
┌─ operator ──────────────────────────────────────────────────┐
│ ao diagnose                                                  │
│   → finds 4 state-flicker findings, prints table             │
│ ao diagnose --triage --file                                  │
│   → files issue #X with body containing:                     │
│     <!-- ao-diagnose id=state-flicker fp=ao-17 -->           │
│     label: ao-diagnosed                                      │
│ ao spawn --from-issue X --verify-with state-flicker          │
│   → session metadata gets verifyWith=state-flicker           │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
              worker fixes + opens PR + merges
                            │
                            ▼
┌─ operator (or lifecycle reaction in phase 2) ────────────────┐
│ ao diagnose --verify <pr>                                    │
│   1. resolve PR → linked issue                               │
│   2. parse issue body for ao-diagnose marker                 │
│   3. look up rule by id, read fingerprint from marker        │
│   4. run rule.verify(ctx, fingerprint)                       │
│   5. pass → close issue, label "verified"                    │
│      fail → reopen, comment with fresh evidence              │
│      indeterminate → comment, no label change                │
└──────────────────────────────────────────────────────────────┘
```

The dedupe marker is the canonical link: it lives in the issue body (survives edits, reflow), is readable via `gh api`, and makes re-runs idempotent. No additional metadata files, no new storage. Session-side, `verifyWith` is a single key in the existing flat metadata.

### 5.1 PR → issue resolution

`ao diagnose --verify <pr>` resolves a PR to an issue by:

1. Checking the `session.issueId` on the session that owns the PR (metadata is authoritative when present).
2. Falling back to `gh pr view` closing-refs if the session is gone (archived).

Both paths use primitives already in `scm-github` / `tracker-github`. No new plugin surface.

## 6. Safety rails (non-negotiable)

The system **must not** autonomously:

- `git push --force` (or `--force-with-lease`) anywhere
- `git worktree remove --force` / `rm -rf` any worktree
- `tmux kill-session` / `tmux kill-server`
- `git commit --amend` or any history rewrite
- Close an issue without a verifying rule run and a comment citing it
- Re-open and re-spawn a failed verification more than `MAX_VERIFY_ATTEMPTS = 3` times per issue

These align with the existing memory rule ("NEVER force-remove worktrees, kill tmux sessions, or take destructive actions to work around errors") and apply transitively: rules may **detect** these conditions but must not remediate them. Remediation is a fix PR authored by a worker session and reviewed by a human.

### 6.1 Loop guards

| Risk | Guard |
|---|---|
| Duplicate issue filing on repeated `--triage` | Marker-based dedupe against open + closed issues |
| Zombie worker that never lands a PR | Existing session reactions / operator oversight — not a diagnose concern |
| Failed fix re-spawned infinitely | `MAX_VERIFY_ATTEMPTS=3`, then add label `verification-escalated` and stop; operator intervenes |
| Rule regresses and fires for everything | `--rule` allows disabling individual rules; failing rule is isolated |
| Verification run on stale data | Rule's `verify()` reads live runtime; no cached evidence replay |

## 7. Phase 1 MVP scope

Ships:

- `packages/core/src/diagnose.ts` + `diagnose-rules.ts` (both files, four rules)
- `packages/cli/src/commands/diagnose.ts` with `--rule`, `--json`, `--project`, `--triage --dry-run`, `--triage --file`, `--verify <pr|issue>`
- `ao spawn --verify-with <id>` flag → writes `verifyWith` to session metadata
- Tests for all four rules with synthetic session fixtures
- One demo recipe in `docs/rfcs/self-improving-orchestrator.md` (this file) showing: inject synthetic fault → `ao diagnose` finds it → `ao diagnose --triage --file` → worker fixes → `ao diagnose --verify <pr>` → issue closes

Does NOT ship in phase 1:

- Automated verify on PR merge (operator runs the command; lifecycle reaction is phase 2)
- Prompt / memory auto-recycling (report only; operator promotes patterns)
- Cross-project deduplication across separate AO installs
- Rich evidence serialization (JSON blobs are enough; pretty formatting phase 2)
- Plugin-contributed rules (defer until first concrete need)

### 7.1 Fault classes for phase 1

Chosen because they are (a) filed as current issues, (b) have concrete detection procedures the operator already ran by hand, and (c) exercise distinct axes of the rule contract.

| Rule id | Issue | Detection signal | Verify = re-run detect? |
|---|---|---|---|
| `state-flicker` | #1454 | `session.state=terminated` AND `runtime.state=alive` AND activity within threshold | Yes |
| `handle-loss` | #1458 | `statePayload.runtime.state=alive` AND (`runtimeHandle` missing OR `statePayload.runtime.handle=null`) | Yes |
| `duplicate-tmux` | #1456 | `tmux list-sessions` returns both `{hash}-{id}` AND bare `{id}` for same id | Yes |
| `unpolled-project` | #1455 | Daemon `running.projects` does not include a project that has active sessions | Yes |

Each rule is ~50 lines. The harness is ~150 lines. The CLI is ~250 lines. Total phase-1 footprint: **~600 lines, three files**.

## 8. Out of scope

- Autonomous destructive actions (explicit, see §6)
- Replacing human review on worker PRs — verify is post-merge sanity, not pre-merge gating
- General AI ops beyond AO's own fault classes
- Rewriting the lifecycle manager to support self-healing transitions (separate RFC if needed)
- A plugin system for diagnosis rules (defer until a plugin actually has one)
- Cross-install / cross-org rule sharing

## 9. Open questions

1. **Confirmation flow for `--triage --file`** — resolved in §3.2: default `--dry-run`, interactive `y/N` when ≥1 issue would be filed, `--yes` to skip. Remaining question for maintainers: should batches above a threshold (say, 10 issues) require a separate `--batch` opt-in? Pre-MVP nicety, not a blocker.
2. **Where does the phase-2 automated verify-on-merge hook live?** Most likely the lifecycle reaction that fires on `pr.merged` — it already runs after merge detection. The reaction assembles a `DiagnosisContext` and invokes the helper defined in §4.3:

   ```typescript
   const ctx = await buildDiagnosisContext(config);
   const result = await verifyDiagnosis(ctx, session.verifyWith, session.id);
   ```

   (Not the two-arg sketch shown in earlier revisions — that was inconsistent with the helper signature.) Defer to phase 2 so the contract can settle first.
3. **Does the diagnosis marker belong only in the issue body, or also in session metadata?** Both: body is the durable source for dedupe and orchestrator lookup; session metadata has `verifyWith` so the PR→rule resolution does not require scraping issue bodies on every merge. Both are one string each.
4. **How does diagnose interact with #1414 (CanonicalSessionState unification)?** Rules that read `session.state` / `session.statePayload.*` will benefit directly — less field aliasing. No blocker, but rules should be written against the canonical shape once #1414 lands.
5. **Attempt cap of 3 — is it configurable?** Keep it hard-coded for phase 1. If users hit it in practice, make it a per-rule field on `DiagnosisRule` (`maxVerifyAttempts?: number`). Don't pre-build configurability.
6. **Reconcile with #1252 (`ao doctor` bug-report subject).** The scope of `ao doctor` is install/env; `ao diagnose` is runtime-fault. Wire `ao doctor` to mention `ao diagnose` in its footer when findings are present. No merge of the two commands.

## 10. Non-goals of this RFC

This RFC does **not**:

- Decide the wire format for #1457's event stream; it consumes whatever lands.
- Decide how orchestrator-prompt.ts gets edited; it only reports patterns.
- Propose a new daemon, service, or long-running process.
- Introduce configuration surface beyond what is already in `agent-orchestrator.yaml`.

---

## Appendix A — example: `state-flicker` rule

Illustrative only; final code lives in `packages/core/src/diagnose-rules.ts`.

```typescript
export const stateFlickerRule: DiagnosisRule = {
  id: "state-flicker",
  description: "Session latched to terminated while runtime/activity say alive (#1454).",

  async detect(ctx) {
    const findings: DiagnosisFinding[] = [];
    for (const session of ctx.sessions) {
      const state = session.statePayload?.session?.state;
      const runtime = session.statePayload?.runtime;
      const activityAt = session.activityEvidence?.at;
      const activityFresh =
        activityAt && Date.now() - new Date(activityAt).getTime() < 5 * 60_000;

      if (
        state === "terminated" &&
        runtime?.state === "alive" &&
        activityFresh
      ) {
        findings.push({
          ruleId: "state-flicker",
          fingerprint: session.id,
          severity: "high",
          summary: `Session ${session.id} is terminated but runtime is alive with fresh activity.`,
          evidence: {
            sessionState: state,
            runtimeState: runtime.state,
            terminatedAt: session.statePayload?.session?.terminatedAt,
            runtimeLastObservedAt: runtime.lastObservedAt,
            activityAt,
          },
          at: new Date().toISOString(),
        });
      }
    }
    return findings;
  },

  async verify(ctx, fingerprint) {
    const session = ctx.sessions.find((s) => s.id === fingerprint);
    if (!session) return "indeterminate";
    // Reference the outer constant by name; do NOT use `this.detect(...)`.
    // Method-shorthand on an object literal loses `this` when extracted
    // (e.g. `const { verify } = rule`), and the framework MAY extract it.
    const findings = await stateFlickerRule.detect({ ...ctx, sessions: [session] });
    return findings.length === 0 ? "pass" : "fail";
  },
};
```

## Appendix B — example issue body template

````markdown
## Summary
State flicker detected on session `ao-17` (runtime alive but session latched to terminated).

## Evidence
```json
{
  "sessionState": "terminated",
  "runtimeState": "alive",
  "terminatedAt": "2026-04-21T20:50:16.964Z",
  "runtimeLastObservedAt": "2026-04-21T20:54:04.694Z",
  "activityAt": "2026-04-21T20:54:03.284Z"
}
```

## Related
- #1454 (parent fault class)

<!-- ao-diagnose id=state-flicker fp=ao-17 -->
````

The HTML-comment marker is the only thing `ao diagnose --verify` relies on. Everything above it is for human readers.
