/**
 * POST /api/update — kick off `ao update` from the dashboard banner.
 *
 * Refuses when any session is in working/idle/needs_input/stuck — the
 * release doc is explicit: never auto-stop a user's agent. The banner
 * surfaces the refusal as a 409 with a guidance message.
 *
 * On success, spawns the install detached and returns 202 immediately.
 * The dashboard process exits when the install replaces the binary; the
 * banner shows progress until the SSE stream drops, at which point the
 * user re-runs `ao start` to pick up the new version.
 */

import { spawn } from "node:child_process";
import { NextResponse, type NextRequest } from "next/server";
import { isWindows } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = new Set([
  "working",
  "idle",
  "needs_input",
  "stuck",
]);

interface UpdateResponse {
  ok: boolean;
  message: string;
  activeSessions?: number;
}

export async function POST(_req: NextRequest) {
  // Active-session guard mirrors the CLI's `ensureNoActiveSessions`. We
  // duplicate it here (rather than shelling out to `ao update --check`)
  // so the dashboard can give an immediate, structured 409 response.
  let activeCount: number;
  try {
    const { sessionManager } = await getServices();
    const sessions = await sessionManager.list();
    activeCount = sessions.filter((s) => ACTIVE_STATUSES.has(s.status)).length;
  } catch (err) {
    return NextResponse.json<UpdateResponse>(
      {
        ok: false,
        message: `Failed to check active sessions: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  if (activeCount > 0) {
    return NextResponse.json<UpdateResponse>(
      {
        ok: false,
        message: `${activeCount} session${activeCount === 1 ? "" : "s"} active. Run \`ao stop\` first, then click Update again.`,
        activeSessions: activeCount,
      },
      { status: 409 },
    );
  }

  // Spawn `ao update` detached so this request can return before the install
  // tears down the dashboard process. We rely on PATH resolution because the
  // user installed `ao` themselves — there's no canonical install location.
  //
  // `shell: isWindows()` is required so PATHEXT gets consulted on Windows —
  // npm's `ao` shim is `ao.cmd`, and Node.js does not look at PATHEXT for
  // non-shell spawns, so the bare `ao` lookup would silently ENOENT on every
  // Windows install. `windowsHide: true` keeps the shell window from flashing.
  //
  // ENOENT still fires asynchronously as an `error` event on the child (POSIX
  // case where `ao` isn't on PATH), NOT as a sync throw — without an explicit
  // handler it would propagate as an unhandled error and crash the test
  // runner. The handler is a noop in production; the user will see "no
  // version change" on next page load if the install never ran.
  try {
    const child = spawn("ao", ["update"], {
      detached: true,
      stdio: "ignore",
      shell: isWindows(),
      windowsHide: true,
      // AO_NON_INTERACTIVE_INSTALL=1 tells the CLI's handleNpmUpdate to skip
      // the isTTY gate and run the install. Without this, stdio:"ignore"
      // makes isTTY() return false, the CLI falls into the "print the
      // command and exit" branch, and the dashboard's "Update" button is
      // effectively a no-op (banner returns 202, nothing installs).
      env: { ...process.env, AO_NON_INTERACTIVE_INSTALL: "1" },
    });
    child.on("error", () => {
      // Swallow async spawn errors (ENOENT etc.) so they don't become
      // unhandled errors. The user will see "no version change" if it failed.
    });
    child.unref();
  } catch (err) {
    return NextResponse.json<UpdateResponse>(
      {
        ok: false,
        message: `Failed to spawn 'ao update': ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json<UpdateResponse>(
    {
      ok: true,
      message:
        "Update started. The dashboard will restart once the new version is installed; re-run `ao start` to resume.",
    },
    { status: 202 },
  );
}
