"use client";

import nextDynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";

const DirectTerminal = nextDynamic(
  () =>
    import("@/components/DirectTerminal").then((m) => ({
      default: m.DirectTerminal,
    })),
  { ssr: false },
);

const Terminal = nextDynamic(
  () => import("@/components/Terminal").then((m) => ({ default: m.Terminal })),
  { ssr: false },
);

// Force dynamic rendering (required for useSearchParams)
export const dynamic = "force-dynamic";

/**
 * Terminal Implementation Test & Documentation
 *
 * This page compares two terminal implementations and documents why DirectTerminal
 * (with XDA support) was necessary for proper clipboard functionality.
 *
 * By default, automatically picks two different sessions to avoid port conflicts.
 *
 * Examples:
 * - http://localhost:3000/dev/terminal-test (auto-picks two different sessions)
 * - http://localhost:3000/dev/terminal-test?old_session=ao-orchestrator&new_session=ao-20
 * - http://localhost:3000/dev/terminal-test?session=ao-20 (uses same session for both)
 *
 * Note: Using different sessions for old/new avoids port conflicts when both render simultaneously.
 */
function TerminalTestPageContent() {
  const searchParams = useSearchParams();
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [showComparison, setShowComparison] = useState(true);

  // Fetch available sessions on mount (only active ones)
  useEffect(() => {
    fetch("/api/sessions?active=true")
      .then((res) => res.json())
      .then((data) => {
        if (data.sessions && Array.isArray(data.sessions)) {
          const ids = data.sessions.map((s: { id: string }) => s.id);
          setAvailableSessions(ids);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch sessions:", err);
      });
  }, []);

  // Determine which sessions to use
  const sessionParam = searchParams.get("session");
  const oldSessionParam = searchParams.get("old_session");
  const newSessionParam = searchParams.get("new_session");

  // If no params provided, use first two available sessions (or fallback to defaults)
  const defaultOldSession = availableSessions[0] || "ao-orchestrator";
  const defaultNewSession = availableSessions[1] || availableSessions[0] || "ao-orchestrator";

  // Allow overriding individual sessions
  const oldSessionId = oldSessionParam || sessionParam || defaultOldSession;
  const newSessionId = newSessionParam || sessionParam || defaultNewSession;

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] p-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-bold text-[var(--color-text-primary)]">
            Terminal Implementation Test & Documentation
          </h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Comparing sessions:
            <span className="ml-2 font-mono text-[var(--color-accent-red)]">
              OLD: {oldSessionId}
            </span>
            <span className="ml-2 font-mono text-[var(--color-accent-green)]">
              NEW: {newSessionId}
            </span>
          </p>
        </div>

        {/* The Problem */}
        <section className="mb-8 rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6">
          <h2 className="mb-4 text-xl font-bold text-[var(--color-text-primary)]">
            🐛 The Problem
          </h2>
          <div className="space-y-3 text-sm text-[var(--color-text-secondary)]">
            <p>
              <strong className="text-[var(--color-text-primary)]">Issue:</strong> Browser clipboard
              (Cmd+C/Ctrl+C) only worked when an iTerm2 client was attached to the tmux session.
            </p>
            <p>
              <strong className="text-[var(--color-text-primary)]">Impact:</strong> Users had to
              keep iTerm2 tabs open in the background for clipboard to work in the web dashboard.
            </p>
            <p>
              <strong className="text-[var(--color-text-primary)]">Investigation time:</strong> 12+
              hours of debugging across tmux, ttyd, xterm.js, and macOS clipboard systems.
            </p>
          </div>
        </section>

        {/* Root Cause */}
        <section className="mb-8 rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6">
          <h2 className="mb-4 text-xl font-bold text-[var(--color-text-primary)]">
            🔍 Root Cause Analysis
          </h2>
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                1. How tmux Clipboard Works (OSC 52)
              </h3>
              <ul className="ml-6 list-disc space-y-1 text-[var(--color-text-secondary)]">
                <li>tmux uses OSC 52 escape sequences to synchronize clipboard with terminals</li>
                <li>
                  Format:{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">
                    \x1b]52;c;&lt;base64&gt;\x07
                  </code>
                </li>
                <li>Terminal must support OSC 52 and have proper capabilities declared</li>
              </ul>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                2. tmux Capability Detection (XDA)
              </h3>
              <ul className="ml-6 list-disc space-y-1 text-[var(--color-text-secondary)]">
                <li>tmux queries terminal capabilities using Device Attributes (DA/XDA)</li>
                <li>
                  XDA query: <code className="rounded-[2px] bg-black px-1 py-0.5">CSI &gt; q</code>{" "}
                  (also called XTVERSION)
                </li>
                <li>
                  Terminal responds with identification string containing terminal type (e.g.,
                  "XTerm(370)", "iTerm2 ")
                </li>
                <li>Based on response, tmux enables features like TTYC_MS (clipboard support)</li>
              </ul>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                3. The Missing Piece
              </h3>
              <div className="rounded-[2px] border border-[var(--color-accent-red)] bg-[var(--color-bg-tertiary)] p-4">
                <p className="font-semibold text-[var(--color-accent-red)]">
                  xterm.js does NOT implement XDA (Extended Device Attributes)
                </p>
                <ul className="ml-6 mt-2 list-disc space-y-1 text-[var(--color-text-secondary)]">
                  <li>
                    XDA is marked as TODO in xterm.js codebase:{" "}
                    <code className="rounded-[2px] bg-black px-1 py-0.5">
                      test.skip('CSI &gt; Ps q - Report xterm name and version (XTVERSION)')
                    </code>
                  </li>
                  <li>
                    Without XDA response, tmux doesn't recognize the terminal as clipboard-capable
                  </li>
                  <li>tmux never emits OSC 52 sequences → clipboard doesn't work</li>
                </ul>
              </div>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                4. Why iTerm2 "Fixed" It
              </h3>
              <ul className="ml-6 list-disc space-y-1 text-[var(--color-text-secondary)]">
                <li>
                  iTerm2 sends proper XDA response identifying itself as{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">"iTerm2 "</code>
                </li>
                <li>tmux detects this and enables clipboard for the entire session</li>
                <li>
                  OSC 52 sequences are then sent to ALL clients, including browser (ttyd/xterm.js)
                </li>
                <li>This is why clipboard "magically worked" when iTerm2 was attached</li>
              </ul>
            </div>
          </div>
        </section>

        {/* The Solution */}
        <section className="mb-8 rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6">
          <h2 className="mb-4 text-xl font-bold text-[var(--color-text-primary)]">
            ✅ The Solution
          </h2>
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                DirectTerminal Implementation
              </h3>
              <p className="mb-2 text-[var(--color-text-secondary)]">
                Created custom terminal component that registers an XDA handler using xterm.js
                parser API:
              </p>
              <pre className="overflow-x-auto rounded-[2px] bg-black p-4 text-xs">
                <code className="text-[var(--color-accent-green)]">
                  {`terminal.parser.registerCsiHandler(
  { prefix: ">", final: "q" }, // CSI > q is XDA query
  () => {
    // Respond with XTerm identification
    terminal.write("\\x1bP>|XTerm(370)\\x1b\\\\");
    return true;
  }
);`}
                </code>
              </pre>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                What This Does
              </h3>
              <ol className="ml-6 list-decimal space-y-1 text-[var(--color-text-secondary)]">
                <li>Intercepts XDA queries from tmux</li>
                <li>
                  Responds with{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">XTerm(370)</code>{" "}
                  identification
                </li>
                <li>tmux detects "XTerm(" in response and enables TTYC_MS capability</li>
                <li>
                  OSC 52 sequences now flow: tmux → WebSocket → xterm.js → navigator.clipboard
                </li>
                <li>
                  <strong className="text-[var(--color-accent-green)]">
                    Clipboard works without iTerm2!
                  </strong>
                </li>
              </ol>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                Architecture Changes
              </h3>
              <ul className="ml-6 list-disc space-y-1 text-[var(--color-text-secondary)]">
                <li>
                  <strong>Old:</strong> Browser → ttyd (iframe) → tmux
                </li>
                <li>
                  <strong>New:</strong> Browser → Custom WebSocket (node-pty) → tmux
                </li>
                <li>Bypasses ttyd for direct control over terminal initialization</li>
                <li>Full control over escape sequence handling and capabilities</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Node Version Requirement */}
        <section className="mb-8 rounded-[2px] border border-[var(--color-accent-orange)] bg-[var(--color-bg-secondary)] p-6">
          <h2 className="mb-4 text-xl font-bold text-[var(--color-text-primary)]">
            ⚠️ Node Version Requirement
          </h2>
          <div className="space-y-3 text-sm">
            <div className="rounded-[2px] border border-[var(--color-accent-orange)] bg-[var(--color-bg-tertiary)] p-4">
              <p className="font-semibold text-[var(--color-accent-orange)]">
                CRITICAL: This implementation requires Node 20.x (currently 20.20.0)
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">Why Node 20?</h3>
              <ul className="ml-6 list-disc space-y-1 text-[var(--color-text-secondary)]">
                <li>
                  <strong>node-pty 1.1.0 is incompatible with Node 25+</strong>
                </li>
                <li>
                  Error on Node 25.6.1:{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">posix_spawnp failed</code>
                </li>
                <li>
                  Root cause: node-pty's native module (darwin-arm64 prebuild) fails to spawn
                  processes on Node 25
                </li>
                <li>No darwin-arm64 prebuilds available that work with Node 25</li>
                <li>Building from source also fails with the same error</li>
              </ul>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                When Can We Upgrade?
              </h3>
              <ul className="ml-6 list-disc space-y-1 text-[var(--color-text-secondary)]">
                <li>
                  <strong>Option 1:</strong> Wait for node-pty 1.2.0 stable release with Node 25+
                  support
                </li>
                <li>
                  <strong>Option 2:</strong> Test node-pty beta versions (currently 1.2.0-beta.11)
                </li>
                <li>
                  <strong>Option 3:</strong> Switch to alternative PTY library (e.g., xterm-pty,
                  node-child-pty)
                </li>
              </ul>
            </div>

            <div className="rounded-[2px] bg-[var(--color-bg-tertiary)] p-4">
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                ⚡ Testing Instructions for Upgrades
              </h3>
              <p className="mb-2 text-[var(--color-text-secondary)]">
                Before upgrading Node or node-pty:
              </p>
              <ol className="ml-6 list-decimal space-y-1 text-xs text-[var(--color-text-secondary)]">
                <li>
                  Test node-pty directly:{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">
                    node -e "const pty = require('node-pty'); pty.spawn('/bin/bash', [],
                    &#123;&#125;)"
                  </code>
                </li>
                <li>
                  If no{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">posix_spawnp failed</code>{" "}
                  error, proceed
                </li>
                <li>Start dev servers and open this page</li>
                <li>Test DirectTerminal: verify connection, clipboard, resize</li>
                <li>Test multiple sessions to ensure stability</li>
                <li>If all tests pass, upgrade is safe</li>
              </ol>
            </div>
          </div>
        </section>

        {/* Comparison Toggle */}
        <div className="mb-4">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowComparison(!showComparison)}
              className="rounded-[2px] bg-[var(--color-accent-blue)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-80"
            >
              {showComparison ? "Hide" : "Show"} Side-by-Side Comparison
            </button>
            <span className="text-sm text-[var(--color-text-secondary)]">
              Compare old (ttyd iframe) vs new (DirectTerminal with XDA)
            </span>
          </div>
          {oldSessionId === newSessionId && (
            <div className="mt-2 rounded-[2px] border border-[var(--color-accent-orange)] bg-[var(--color-bg-tertiary)] p-2 text-xs text-[var(--color-text-secondary)]">
              ⚠️ Using same session for both terminals. To avoid port conflicts, use different
              sessions:
              <code className="ml-1 rounded-[2px] bg-black px-1">
                ?old_session=ao-orchestrator&new_session=ao-20
              </code>
            </div>
          )}
        </div>

        {/* Side-by-Side Comparison */}
        {showComparison && (
          <section className="mb-8">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Old Implementation */}
              <div className="rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-[2px] bg-[var(--color-accent-red)] px-2 py-1 text-xs font-semibold text-white">
                    OLD
                  </span>
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    ttyd iframe (no XDA)
                  </h3>
                </div>
                <div className="mb-2 rounded bg-[var(--color-bg-tertiary)] p-2 text-xs text-[var(--color-text-secondary)]">
                  ❌ Clipboard requires iTerm2 attached
                  <br />
                  ✅ Battle-tested (ttyd)
                  <br />❌ No control over capabilities
                </div>
                <Terminal sessionId={oldSessionId} />
              </div>

              {/* New Implementation */}
              <div className="rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-[2px] bg-[var(--color-accent-green)] px-2 py-1 text-xs font-semibold text-white">
                    NEW
                  </span>
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    DirectTerminal (with XDA)
                  </h3>
                </div>
                <div className="mb-2 rounded bg-[var(--color-bg-tertiary)] p-2 text-xs text-[var(--color-text-secondary)]">
                  ✅ Clipboard works standalone
                  <br />
                  ✅ Full control over terminal
                  <br />
                  ⚠️ Requires Node 20.x (node-pty)
                </div>
                <DirectTerminal sessionId={newSessionId} tmuxName={newSessionId} />
              </div>
            </div>

            <div className="mt-4 rounded-[2px] border border-[var(--color-accent-blue)] bg-[var(--color-bg-secondary)] p-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
                🧪 How to Test Clipboard
              </h3>
              <ol className="ml-6 list-decimal space-y-1 text-sm text-[var(--color-text-secondary)]">
                <li>Drag-select text in BOTH terminals above</li>
                <li>Press Cmd+C (macOS) or Ctrl+Shift+C (Linux/Windows)</li>
                <li>Paste in another application (Notes, VS Code, etc.)</li>
                <li>
                  <strong className="text-[var(--color-text-primary)]">
                    Expected: RIGHT terminal works, LEFT may not (unless iTerm2 is attached)
                  </strong>
                </li>
              </ol>
            </div>
          </section>
        )}

        {/* Debugging Journey */}
        <section className="rounded-[2px] border border-[var(--color-accent)] bg-[var(--color-bg-secondary)] p-6">
          <h2 className="mb-4 text-xl font-bold text-[var(--color-text-primary)]">
            🔬 The Debugging Journey
          </h2>

          <div className="space-y-4 text-sm text-[var(--color-text-secondary)]">
            <div className="rounded-[2px] bg-[var(--color-bg-tertiary)] p-4">
              <p className="font-semibold text-[var(--color-accent-red)]">
                Total Time Wasted: 12+ hours across Feb 15-16, 2026
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                ❌ What We Tried (That Didn't Work)
              </h3>
              <ol className="ml-6 list-decimal space-y-2">
                <li>
                  <strong>Suspected ttyd clipboard handling</strong> - Spent hours analyzing ttyd
                  source code, checking OSC 52 passthrough. ttyd was innocent - it passes escape
                  sequences correctly.
                </li>
                <li>
                  <strong>Blamed xterm.js configuration</strong> - Tried every possible xterm.js
                  option, clipboard addon configurations, terminal type settings. None made a
                  difference.
                </li>
                <li>
                  <strong>Investigated macOS clipboard permissions</strong> - Checked browser
                  permissions, sandbox attributes, navigator.clipboard API. All were correct.
                </li>
                <li>
                  <strong>Suspected WebSocket encoding issues</strong> - Checked binary vs text
                  mode, UTF-8 encoding, base64 handling. All correct.
                </li>
                <li>
                  <strong>Tried force-enabling tmux clipboard</strong> - Used{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">
                    set-option -s set-clipboard on
                  </code>{" "}
                  in tmux.conf. Didn't help - tmux needs the terminal to declare support.
                </li>
              </ol>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                💡 The Breakthrough
              </h3>
              <div className="space-y-2">
                <p>
                  <strong>What finally worked:</strong> Registering an XDA (Extended Device
                  Attributes) handler in xterm.js using{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">
                    terminal.parser.registerCsiHandler()
                  </code>
                </p>
                <pre className="mt-2 overflow-x-auto rounded-[2px] bg-black p-3 text-xs">
                  <code className="text-[var(--color-accent-green)]">
                    {`terminal.parser.registerCsiHandler(
  { prefix: ">", final: "q" },
  () => {
    terminal.write("\\x1bP>|XTerm(370)\\x1b\\\\");
    return true;
  }
);`}
                  </code>
                </pre>
                <p className="mt-2">
                  This single handler made tmux recognize our terminal as clipboard-capable.
                  Clipboard immediately started working.
                </p>
              </div>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                🎯 How We Finally Figured It Out
              </h3>
              <ol className="ml-6 list-decimal space-y-2">
                <li>
                  <strong>Deep-dive into tmux source code</strong> - Used DeepWiki.com to analyze
                  tmux's terminal capability detection logic in{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">tty-keys.c</code> and{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">tty.c</code>
                </li>
                <li>
                  <strong>Discovered XDA queries</strong> - Found that tmux sends{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">CSI &gt; q</code> (XTVERSION)
                  to detect terminal type
                </li>
                <li>
                  <strong>Traced the "iTerm2 magic"</strong> - Realized why clipboard worked when
                  iTerm2 was attached: iTerm2 responds to XDA queries, enabling clipboard for the
                  entire tmux session
                </li>
                <li>
                  <strong>Checked xterm.js implementation</strong> - Found that XDA is marked as
                  TODO in xterm.js tests:{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">
                    test.skip('CSI &gt; Ps q - Report xterm name and version (XTVERSION)')
                  </code>
                </li>
                <li>
                  <strong>Implemented custom handler</strong> - Used xterm.js parser API to register
                  our own XDA handler
                </li>
              </ol>
            </div>

            <div className="rounded-[2px] border border-[var(--color-accent-orange)] bg-[var(--color-bg-tertiary)] p-4">
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                ⚡ How We Could Have Figured It Out Faster
              </h3>
              <ol className="ml-6 list-decimal space-y-2 text-[var(--color-text-secondary)]">
                <li>
                  <strong>Start with tmux source code first</strong> - Instead of debugging xterm.js
                  and ttyd, we should have immediately checked how tmux detects terminal
                  capabilities
                </li>
                <li>
                  <strong>Monitor escape sequences</strong> - Running{" "}
                  <code className="rounded-[2px] bg-black px-1 py-0.5">tmux -vvv</code> or using a
                  terminal protocol analyzer would have revealed the XDA queries being sent
                </li>
                <li>
                  <strong>Compare working vs broken scenarios</strong> - Should have captured and
                  diffed the escape sequences when iTerm2 was attached vs not attached earlier
                </li>
                <li>
                  <strong>Check xterm.js issues/limitations first</strong> - A GitHub search for
                  "xterm.js XDA" or "xterm.js device attributes" would have revealed it's
                  unimplemented
                </li>
                <li>
                  <strong>Read tmux documentation on terminal types</strong> - tmux man page
                  mentions terminal capability detection, but we focused on clipboard settings
                  instead
                </li>
              </ol>
            </div>

            <div>
              <h3 className="mb-2 font-semibold text-[var(--color-text-primary)]">
                📚 Key Resources
              </h3>
              <ul className="ml-6 list-disc space-y-1">
                <li>tmux source analysis: DeepWiki.com (Feb 15, 2026)</li>
                <li>xterm.js parser API documentation</li>
                <li>XTerm Control Sequences: XTVERSION / Device Attributes</li>
                <li>
                  tmux <code className="rounded-[2px] bg-black px-1 py-0.5">tty-keys.c</code>:
                  Terminal type detection logic
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Implementation Files */}
        <section className="mt-6 rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6">
          <h2 className="mb-4 text-xl font-bold text-[var(--color-text-primary)]">
            📁 Implementation Files
          </h2>
          <ul className="ml-6 list-disc space-y-1 text-sm text-[var(--color-text-secondary)]">
            <li>
              <code className="rounded-[2px] bg-black px-1 py-0.5">
                packages/web/src/components/DirectTerminal.tsx
              </code>{" "}
              - Main component with XDA handler
            </li>
            <li>
              <code className="rounded-[2px] bg-black px-1 py-0.5">
                packages/web/server/direct-terminal-ws.ts
              </code>{" "}
              - WebSocket server using node-pty
            </li>
            <li>
              <code className="rounded-[2px] bg-black px-1 py-0.5">
                packages/web/src/app/dev/terminal-test/page.tsx
              </code>{" "}
              - This test page
            </li>
          </ul>
        </section>

        {/* Footer */}
        <div className="mt-8 border-t border-[var(--color-border-default)] pt-4 text-center text-xs text-[var(--color-text-secondary)]">
          <p>Investigation: Feb 15-16, 2026 • Duration: 12+ hours • Status: ✅ Resolved</p>
          <p className="mt-1">Node 20.20.0 • node-pty 1.1.0 • xterm.js 5.3.0</p>
        </div>
      </div>
    </div>
  );
}

export default function TerminalTestPage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}
    >
      <TerminalTestPageContent />
    </Suspense>
  );
}
