"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RepairDegradedProjectButton({
  projectId,
}: {
  projectId: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repair = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Failed to repair project config.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error while repairing project config.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => void repair()}
        disabled={submitting}
        className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-tint-blue)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Repairing..." : "Repair config"}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-[var(--color-status-error)]">{error}</p>
      ) : null}
    </div>
  );
}
