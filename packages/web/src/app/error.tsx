"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ErrorDisplay } from "@/components/ErrorDisplay";

export default function Error({
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
      title="Something went wrong"
      message="The dashboard hit an unexpected error. Try reloading the route data or head back to the main dashboard."
      tone="warning"
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
