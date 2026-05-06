"use client";

import { useEffect } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body className="bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <ErrorDisplay
          title="Something broke at the app shell"
          message="The dashboard could not recover from this error at the layout level. Try again first, then reload the page if it still fails."
          tone="error"
          primaryAction={{ label: "Try again", onClick: reset }}
          secondaryAction={{ label: "Reload page", onClick: () => window.location.reload() }}
          error={error}
        />
      </body>
    </html>
  );
}
