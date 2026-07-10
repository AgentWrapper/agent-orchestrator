# Codex-family CLIs run in the foreground only

**Operator standing rule (2026-07-10):** codex and codex-fugu run in the
foreground under all circumstances — never in the background, no exceptions.
Invoke them as blocking, attached commands that run to completion in view.

This is the durable record of that rule and of the audit that confirmed ao's
own code already honors it. The agent-facing form of the rule lives in
`agent-instructions/source/55-extensions.md` (regenerated into the root
`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`); this doc explains _why_ and inventories
_where_ so a future change to the review skills or the daemon does not
silently regress to backgrounding.

## Why

During the 2026-07-10 supervised run, workers repeatedly launched
codex/codex-fugu reviewers as detached background shells (rationale: "it can
exceed the shell's 10-minute cap") and paid for it:

- silent stalls at MCP startup (e.g. worker 91 fugu review hung at
  `mcp: sx/list_my_assets`, killed with exit 144);
- exit-144 deaths nobody could observe;
- hour-long reviewer waits with no attached output;
- workers (93/94/95) stalling while polling a background reviewer process that
  had already died.

A foreground invocation is attached, observable, and fails loudly. A
backgrounded one hides exactly the failure modes above until a human notices
the worker is stuck.

## The rule, operationally

- **Never** `nohup`, `&`, `setsid`, `disown`, a detached background shell, or
  any launch-and-poll pattern that starts codex and returns to poll it later.
- A long review uses the **maximum foreground timeout**; if it still does not
  fit, split it into smaller foreground passes and re-run — never detach to
  dodge a shell's time cap.
- If codex hangs at MCP startup, disable MCP for that run
  (`-c 'mcp_servers={}'`) and keep it in the foreground — do not background it.
- This binds every codex invocation a worker or orchestrator _drives_: review
  passes (`/codex:review`, `/final-review`), diagnosis, and rescue runs.

**For anyone editing the review skills (`final-review`, `phase-review`,
`ship-*`, `fix-bug`, `bug-hunt`, `codex:*`):** do not add a
background/detach/poll step for a codex reviewer to work around a timeout. The
correct escape hatch is a longer foreground timeout or a split-and-re-run, both
still attached. Backgrounding a codex reviewer is the regression this rule
exists to prevent.

## Invocation-path audit (ao's own code)

Audited 2026-07-10 for #185. The architecture separates **argv construction**
(the codex adapter builds command strings but does not spawn) from
**execution**. Codex reaches a process in exactly two ways: the generic tmux
runtime spawns the built argv into a user-visible pane (session launch and
reviewer runs), and a handful of direct `os/exec` probe/health call sites run
it to completion under a bounded context. **There are zero background/detached
(`nohup` / `setsid` / `&` / `Start()`-without-`Wait()` / fire-and-poll) codex
exec patterns anywhere in the tree.**

| #   | Path / feature                         | Call site                                                                                                                                                                           | Disposition                                                                                                                                          | Timeout                                                                                                                     |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Worker/orchestrator session launch     | argv: `adapters/agent/codex/codex.go` `GetLaunchCommand`/`GetRestoreCommand`; spawn: `adapters/runtime/tmux/tmux.go` via `tmux new-session -d`                                      | **Attached** — `-d` detaches the tmux _client_, but codex runs foreground in a persistent pane the user can attach to; the daemon never blocks on it | codex process is long-lived by design; only the `tmux` control command carries `ctx`                                        |
| 2   | Model probe (#143 `ValidateModel`)     | `adapters/agent/codex/codex.go` `exec.CommandContext(...).CombinedOutput()`                                                                                                         | **Foreground / blocking** — runs `codex exec … "Reply exactly OK"` to completion; process-group SIGKILL on timeout is cleanup, not a detach          | yes — `context.WithTimeout` (45s) in `service/agent/service.go`; also worker-mix validation in `service/project/service.go` |
| 3   | Auth / login health probe              | `adapters/agent/codex/codex.go` `loginStatusForBinary` → `exec.CommandContext(...).CombinedOutput()`                                                                                | **Foreground / blocking** — `codex login status`; reached from `AuthStatus` and the fugu shared-account fallback                                     | yes — 3s inner `WithTimeout`; 10s outer bound in `service/agent/service.go`                                                 |
| 4   | `ao doctor` version check              | `cli/doctor.go` `CommandOutput(reqCtx, path, VersionArg)`                                                                                                                           | **Foreground / blocking** — `codex --version` / `codex-fugu --version`                                                                               | yes — `context.WithTimeout(ctx, probeTimeout)`                                                                              |
| 5   | `ao doctor` launch-flag canary         | `cli/doctor.go` `checkCodexLaunchFlags` → `CommandOutput(...)` over `codex.DoctorLaunchProbes()`                                                                                    | **Foreground / blocking** — canary probes (e.g. `codex --dangerously-bypass-hook-trust --version`)                                                   | yes — `context.WithTimeout(ctx, probeTimeout)` per probe                                                                    |
| 6   | ao-native reviewer runs (`review_run`) | argv: `adapters/reviewer/codex/codex.go` `ReviewCommand` (delegates to `GetLaunchCommand`, adds `--sandbox read-only`); spawn: `review/launcher.go` via the same tmux runtime as #1 | **Attached** — user-visible tmux pane, not blocking on the daemon                                                                                    | interactive pane, as #1                                                                                                     |

No-exec sites (build argv or locate the binary only, never spawn):
`adapters/agent/codex/hooks.go` (writes `.codex/hooks.json`),
`install.go`/`ResolveBinary`/`ResolveCodexBinary` (`exec.LookPath` + `os.Stat`).
Node/JS under `ops/`, `scripts/`, `frontend/` reference codex only in
comments, enums, and UI labels — no `child_process` spawn of any codex binary
(the daemon owns all spawns).

**Conclusion:** ao's own code needs no change. Every direct exec is
run-to-completion (`CombinedOutput()` / `CommandOutput()`) under a bounded
`context.WithTimeout`; every interactive codex process lives in a
user-attachable tmux pane rather than being fire-and-forgotten. The rule is
enforced going forward by the agent-instruction fragment above and by this
note.
