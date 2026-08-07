"use client";

import { useEffect, useState } from "react";
import { FaApple } from "react-icons/fa";
import { track } from "@/lib/analytics";
import { isIPadOS, usePlatform } from "../hooks/useOS";
import { TestFlightDialog } from "./TestFlightDialog";
import { TestFlightMobileSheet } from "./TestFlightMobileSheet";

const TRIGGER_CLASS =
  "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-3xl bg-foreground px-3 py-2 text-sm font-semibold tracking-[-0.5px] text-background transition-opacity hover:opacity-85 sm:px-6 sm:py-3 sm:text-base";

// Picks the install flow by device. A QR is the right answer on desktop - its
// job is to move the invite onto a phone - and exactly the wrong answer on the
// phone itself, which is what confused visitors before this split existed.
export function MobileAppCTA() {
  const { mobileOS } = usePlatform();
  const [open, setOpen] = useState(false);
  const [deviceName, setDeviceName] = useState<"iPhone" | "iPad">("iPhone");

  useEffect(() => {
    setDeviceName(
      isIPadOS(navigator.userAgent, navigator.maxTouchPoints)
        ? "iPad"
        : "iPhone",
    );
  }, []);

  // mobileOS is null until usePlatform's effect runs, so the first render here
  // always matches TestFlightDialog - same as everywhere else - then swaps to
  // the button + sheet below once iOS is detected. That's a full component
  // swap (dialog -> sheet), not a text change; it merely looks seamless
  // because TRIGGER_CLASS here and the trigger className in TestFlightDialog
  // are byte-identical. Keep the two in sync or the swap will visibly jump.
  // Android and desktop both keep the original QR dialog. Android additionally
  // sees the untouched "Android coming soon" chip beside it.
  if (mobileOS !== "ios") return <TestFlightDialog />;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          track("testflight_sheet_opened");
          setOpen(true);
        }}
        className={TRIGGER_CLASS}
      >
        <FaApple className="size-4 shrink-0" aria-hidden="true" />
        Install on this {deviceName}
      </button>

      <TestFlightMobileSheet
        open={open}
        onClose={() => setOpen(false)}
        deviceName={deviceName}
      />
    </>
  );
}
