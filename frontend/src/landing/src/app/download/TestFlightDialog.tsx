"use client";

import { TESTFLIGHT_APP_URL, TESTFLIGHT_URL } from "@ao/shared/constants";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import { FaApple } from "react-icons/fa";

const STEPS = [
  {
    title: "Install TestFlight",
    body: "Apple distributes betas through its TestFlight app. Get it from the App Store first — the invite link does nothing without it.",
  },
  {
    title: "Scan to install AO Mobile",
    body: "Point your iPhone camera at the code. TestFlight opens on the AO beta; tap Accept, then Install.",
  },
] as const;

// The QR is the whole point of the dialog: the person reading this is on a
// desktop, and the invite has to reach the phone in their hand. The direct link
// stays as a fallback for anyone already on the device.
export function TestFlightDialog() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    // The page behind a modal must not scroll under it.
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-3xl bg-foreground px-3 py-2 text-sm font-semibold tracking-[-0.5px] text-background transition-opacity hover:opacity-85 sm:px-6 sm:py-3 sm:text-base"
      >
        <FaApple className="size-4 shrink-0" aria-hidden="true" />
        Join the iOS beta
      </button>

      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.button
              type="button"
              aria-label="Close"
              onClick={close}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm outline-none"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="testflight-dialog-title"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: "spring", duration: 0.34, bounce: 0.12 }}
              className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.8)] sm:p-7"
            >
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                autoFocus
                className="absolute right-4 top-4 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-4" aria-hidden="true" />
              </button>

              <h2
                id="testflight-dialog-title"
                className="pr-8 text-xl font-semibold text-foreground"
              >
                Get AO Mobile on iOS
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Two steps, about a minute. The beta is free while it lasts.
              </p>

              <ol className="mt-6 space-y-5">
                {STEPS.map((step, index) => (
                  <li key={step.title} className="flex gap-3.5">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background"
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {step.title}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {step.body}
                      </p>
                      {index === 0 ? (
                        <a
                          href={TESTFLIGHT_APP_URL}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-foreground underline underline-offset-4 transition-opacity hover:opacity-75"
                        >
                          Open TestFlight on the App Store
                          <ExternalLink className="size-3.5" aria-hidden="true" />
                        </a>
                      ) : (
                        <div className="mt-3 flex justify-center">
                          {/* White plate, always — a QR needs the light quiet zone
                              to scan, whatever theme the page is in. */}
                          <div className="rounded-xl bg-white p-3">
                            <QRCodeSVG
                              value={TESTFLIGHT_URL}
                              size={148}
                              className="block"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              <a
                href={TESTFLIGHT_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-3xl border border-border px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5"
              >
                Already on your iPhone? Open the invite
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
