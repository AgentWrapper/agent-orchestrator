"use client";

import Link from "next/link";

import { useAuth } from "../../auth/AuthProvider";
import { DownloadButton } from "../DownloadButton";

const secondaryButtonClass =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-2xl border border-border bg-background px-3 text-sm font-medium tracking-[-0.5px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50";

export function HeaderCTA() {
  const { status, login, logout } = useAuth();

  return (
    <>
      {status === "authenticated" ? (
        <>
          <Link href="/app" className={secondaryButtonClass}>
            Open app
          </Link>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void logout()}
          >
            Logout
          </button>
        </>
      ) : (
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={status === "loading"}
          onClick={() => void login()}
        >
          Login
        </button>
      )}
      <DownloadButton size="sm" />
    </>
  );
}
