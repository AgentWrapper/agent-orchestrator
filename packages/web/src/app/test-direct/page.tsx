"use client";

import nextDynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const DirectTerminal = nextDynamic(
  () =>
    import("@/components/DirectTerminal").then((m) => ({
      default: m.DirectTerminal,
    })),
  { ssr: false },
);

// Force dynamic rendering (required for useSearchParams)
export const dynamic = "force-dynamic";

/**
 * Test page for DirectTerminal with XDA clipboard support.
 *
 * Examples:
 * - http://localhost:3000/test-direct
 * - http://localhost:3000/test-direct?session=ao-20
 * - http://localhost:3000/test-direct?session=ao-20&fullscreen=true
 *
 * This uses native xterm.js with registered XDA handler,
 * which should enable clipboard (OSC 52) in tmux without
 * requiring iTerm2 attachment.
 */
function TestDirectPageContent() {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const sessionId = searchParams.get("session") || "ao-orchestrator";
  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            DirectTerminal Test - XDA Clipboard Support
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            This terminal has XDA (Extended Device Attributes) handler registered.
            <br />
            tmux should recognize it as XTerm and enable clipboard support (OSC 52).
          </p>
          <div className="mt-4 rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
            <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Testing: <span className="text-[var(--color-accent-green)]">{sessionId}</span>
            </h2>
            <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Test Steps:
            </h2>
            <ol className="list-inside list-decimal space-y-1 text-sm text-[var(--color-text-muted)]">
              <li>Connected to tmux session: {sessionId}</li>
              <li>
                Verify XDA badge shows{" "}
                <span className="text-[var(--color-accent-green)]">✓ XDA</span>
              </li>
              <li>Drag-select text in the terminal</li>
              <li>Press Cmd+C (macOS) or Ctrl+C (Linux/Windows)</li>
              <li>Paste elsewhere to verify clipboard works</li>
              <li>
                <strong>Expected:</strong> Clipboard works without iTerm2 attachment!
              </li>
            </ol>
          </div>
          <div className="mt-4 rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
            <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Technical Details:
            </h2>
            <ul className="list-inside list-disc space-y-1 text-sm text-[var(--color-text-muted)]">
              <li>Registers CSI &gt; q (XDA) handler in xterm.js parser</li>
              <li>Responds with DCS &gt; | XTerm(370) ST sequence</li>
              <li>tmux detects "XTerm(" and enables TTYC_MS (clipboard capability)</li>
              <li>OSC 52 sequences flow: tmux → WebSocket → xterm.js → navigator.clipboard</li>
            </ul>
          </div>
        </div>

        {/* Test with specified session - key forces remount on fullscreen change */}
        <DirectTerminal
          key={`${sessionId}-${startFullscreen ? "fullscreen" : "normal"}`}
          sessionId={sessionId}
          tmuxName={sessionId}
          startFullscreen={startFullscreen}
        />
      </div>
    </div>
  );
}

export default function TestDirectPage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}
    >
      <TestDirectPageContent />
    </Suspense>
  );
}
