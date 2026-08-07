"use client";

import { TESTFLIGHT_APP_URL, TESTFLIGHT_URL } from "@ao/shared/constants";
import { AnimatePresence, motion } from "motion/react";
import { Check, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { track } from "@/lib/analytics";

// Once a visitor clears the gate, it should stay cleared - on a return visit
// or a manual reload, not just for the rest of this page view. Re-showing a
// gate they already cleared is the exact frustration this sheet exists to
// remove. So the cleared gate is persisted.
const STORAGE_KEY = "ao.testflight.hasApp";

function readHasTestFlight(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Private mode or blocked storage: fall back to in-memory gating.
    return false;
  }
}

// Writes both ways: the toggle is reversible, so a visitor who taps it by
// mistake can put the gate back rather than being stuck with a step 2 that
// sends them nowhere.
function rememberHasTestFlight(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, "true");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal - the gate still works for this page view.
  }
}

const ACTION_BASE =
  "flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-sm font-semibold transition-opacity";

interface TestFlightMobileSheetProps {
  open: boolean;
  onClose: () => void;
  deviceName: "iPhone" | "iPad";
}

// The phone counterpart to TestFlightDialog. It carries no QR: the visitor is
// holding the target device, so the invite has to be tappable, not scannable.
// Step 2 stays inert until step 1 is taken because TestFlight betas are
// meaningless without Apple's TestFlight app, and nothing in the old dialog
// stopped a visitor tapping the invite first.
export function TestFlightMobileSheet({
  open,
  onClose,
  deviceName,
}: TestFlightMobileSheetProps) {
  const [hasTestFlight, setHasTestFlight] = useState(() => readHasTestFlight());

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // The page behind a sheet must not scroll under it.
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  const unlock = useCallback(() => {
    setHasTestFlight(true);
    rememberHasTestFlight(true);
  }, []);

  // The toggle is the one control that must never disappear: someone who
  // already has TestFlight needs the fast path visible on arrival, not hidden
  // behind having first tapped the step they don't need.
  const toggleHasTestFlight = useCallback(() => {
    setHasTestFlight((previous) => {
      const next = !previous;
      track(
        next ? "testflight_already_installed" : "testflight_gate_restored",
      );
      rememberHasTestFlight(next);
      return next;
    });
  }, []);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <motion.button
            type="button"
            aria-label="Close"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm outline-none"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="testflight-sheet-title"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", duration: 0.36, bounce: 0.08 }}
            // max-h + scroll so a short screen (an SE, or landscape) can still
            // reach the last control instead of having it clipped off-screen.
            className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-card px-5 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.8)]"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              autoFocus
              className="absolute right-4 top-4 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </button>

            <h2
              id="testflight-sheet-title"
              className="pr-8 text-xl font-semibold text-foreground"
            >
              Get AO on this {deviceName}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Two taps, about a minute. The beta is free while it lasts.
            </p>

            <ol className="mt-6 space-y-6">
              <li>
                <div className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background"
                  >
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-semibold text-foreground">
                        Install TestFlight
                      </p>
                      {hasTestFlight ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-foreground">
                          <Check className="size-3.5" aria-hidden="true" />
                          Ready
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      Apple&apos;s free app for betas. Come back here once it
                      finishes installing.
                    </p>
                  </div>
                </div>
                <a
                  href={TESTFLIGHT_APP_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => {
                    track("testflight_app_store_clicked");
                    unlock();
                  }}
                  className={`${ACTION_BASE} mt-3 bg-foreground text-background hover:opacity-85`}
                >
                  Get TestFlight
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>

                <button
                  type="button"
                  role="checkbox"
                  aria-checked={hasTestFlight}
                  onClick={toggleHasTestFlight}
                  className="mt-2.5 flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      hasTestFlight
                        ? "border-foreground bg-foreground text-background"
                        : "border-muted-foreground"
                    }`}
                  >
                    {hasTestFlight ? <Check className="size-3" /> : null}
                  </span>
                  I already have TestFlight
                </button>
              </li>

              <li>
                <div className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      hasTestFlight
                        ? "bg-foreground text-background"
                        : "bg-foreground/25 text-background"
                    }`}
                  >
                    2
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      Open the AO invite
                    </p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      TestFlight opens on the AO beta. Tap Accept, then Install.
                    </p>
                  </div>
                </div>

                {hasTestFlight ? (
                  <a
                    href={TESTFLIGHT_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => track("testflight_invite_clicked")}
                    className={`${ACTION_BASE} mt-3 bg-foreground text-background hover:opacity-85`}
                  >
                    Open invite
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ) : (
                  <>
                    {/* A disabled button, not a dimmed anchor: the invite must
                        be genuinely unactivatable, not merely discouraged. */}
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className={`${ACTION_BASE} mt-3 cursor-not-allowed bg-foreground/25 text-background`}
                    >
                      Open invite
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </button>
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      Install TestFlight first
                    </p>
                  </>
                )}
              </li>
            </ol>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
