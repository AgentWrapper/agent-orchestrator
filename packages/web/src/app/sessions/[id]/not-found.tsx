import { ErrorDisplay } from "@/components/ErrorDisplay";

export default function SessionNotFound() {
  return (
    <ErrorDisplay
      title="Session not found"
      message="The session you’re looking for does not exist anymore, or the link is stale."
      tone="not-found"
      primaryAction={{ label: "Back to dashboard", href: "/" }}
      compact
      chrome="card"
    />
  );
}
