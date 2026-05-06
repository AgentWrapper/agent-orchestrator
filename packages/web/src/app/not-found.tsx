import { ErrorDisplay } from "@/components/ErrorDisplay";

export default function NotFound() {
  return (
    <ErrorDisplay
      title="Page not found"
      message="This route does not exist in the dashboard. Return to the main view to pick an active project or session."
      tone="not-found"
      primaryAction={{ label: "Back to dashboard", href: "/" }}
    />
  );
}
