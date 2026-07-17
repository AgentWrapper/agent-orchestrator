# Nested Activity Signal Guard

## Issue

GH #334 tracks a false-death class where a nested raw agent CLI inherits a parent
session's AO activity environment and posts activity back onto the parent
session. Because the inherited runtime token is valid for the parent, token-only
acceptance cannot distinguish the parent harness from a child harness, and it is
blind to the same-harness diagonal.

## Decisions

The primary same-harness closure is a self-guarding hook for runtimes that can
mark the direct agent process. The tmux runtime launches the agent through an
inner exec shell that exports `AO_HOOK_PARENT_PID` to the PID that becomes the
agent process and sets `AO_HOOK_PARENT_PID_REQUIRED=1`. `ao hooks` compares that
marker to its direct parent process only when the required flag is present, and
returns without posting when a callback was launched by a nested child process.
Only adapters with a verified hook-launch topology opt into this direct-parent
contract and receive the required marker. Today that is Claude Code. Suppressed
callbacks append a quiet diagnostic to `hooks-suppressed.log`, because a
mis-marked launcher should not make a session go signal-dark without evidence or
churn the delivery-failure `hooks.log`. Older already-running sessions, runtimes
that cannot inject the marker, and adapters that do not opt into the
direct-parent contract remain on the existing token guard instead of going
signal-dark during deploy.
If the host cannot resolve the local process lineage, the guard also fails open:
runtime-token validation remains the durable backstop, and an invalid marker or
uninspectable process tree must not create a platform-wide no-signal failure.

That leaves a known residual same-harness gap for non-opt-in adapters: a raw
nested child using the same reporting harness can still inherit the parent's
runtime token. Those adapters intentionally stay fail-open here until their hook
launcher topology is verified or they gain their own lineage marker.

The daemon backstop is a harness guard in lifecycle activity acceptance. A signal
that omits the reporting harness or names one different from the live session's
reporting harness is ignored before token validation and before any state,
decision, usage, or tool-flight side effect can land. Claude-compatible delegates
(`grok`, `devin`, `continue`) are normalized to their `claude-code` hook reporter
so their legitimate delegated hooks still count as local.

Workspace hook reuse is handled during terminal cleanup. When an adapter supports
`UninstallHooks`, session manager removes AO-managed workspace hooks after the
terminated session's runtime is gone and only for a workspace cleanup is allowed
to reclaim. In-place workspaces and paths still occupied by a live successor keep
their hooks. Launch preparation remains fail-open: a transient hook-install
failure no longer erases previous working hooks.

Bearer auth is not the primary fix in this branch. It would harden the loopback
endpoint against non-hook callers, but inherited child hooks would inherit the
same bearer material unless the launch/lineage problem is fixed first.

Merge queue safety is covered by the existing `review-passed` merge-group
workflow, which checks each queued PR head for a SHA-current final-review gate.
This branch keeps the activity primitive focused on preventing false terminal
and state writes before a worker reaches posthumous merge behavior.

## Coverage

Regression coverage proves inherited-token foreign harness signals cannot mark
the parent exited, idle, blocked, active, or clear a permission dialog, including
the no-agent-field bypass shape. Hook coverage proves a same-harness nested
callback whose direct parent is not the launched agent process does not post
activity when the runtime requires the lineage marker, that a separately spawned
hook process posts when its real parent matches the marker, and that suppression
writes a durable diagnostic without hook stderr or delivery-log churn. Runtime
coverage executes the tmux wrapper and verifies the marker equals the exec'd
process PID; the keepalive inspection shell clears AO hook credentials before it
starts. Session-manager coverage pins hook cleanup during terminal cleanup and
proves in-place, global-config, or live-shared workspaces are not stripped.
