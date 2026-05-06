"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";

function getSessionErrorMessage(error: Error): string {
  const normalized = error.message.toLowerCase();
  if (normalized.includes("timed out")) {
    return "The session request did not complete in time. Check the backend process and try again once the API is responsive.";
  }
  if (normalized.includes("network")) {
    return "The session request failed before the dashboard got a response. Check the server connection and try again.";
  }
  if (normalized.includes("403")) {
    return "The dashboard could not access this session. Permissions or auth may have changed.";
  }
  if (normalized.includes("404")) {
    return "This session is no longer available. It may have been removed while the page was open.";
  }
  if (normalized.includes("500")) {
    return "The server returned an internal error while loading this session. Try re-fetching the session data.";
  }
  if (error.message.trim().length > 0) {
    return error.message;
  }
  return "The dashboard could not load this session cleanly. Try again to re-fetch the latest state.";
}

export default function SessionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorDisplay
      title="Failed to load session"
      message={getSessionErrorMessage(error)}
      tone="error"
      primaryAction={{
        label: "Try again",
        onClick: () => {
          reset();
          router.refresh();
        },
      }}
      secondaryAction={{ label: "Back to dashboard", href: "/" }}
      error={error}
      compact
      chrome="card"
    />
  );
}
