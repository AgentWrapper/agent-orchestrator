"use client";

import { useEffect, useState } from "react";
import type { Artifact } from "@aoagents/ao-core";
import { useMuxOptional } from "@/providers/MuxProvider";

/**
 * `useArtifacts(sessionId)` — fetches the artifact list for a single session via
 * REST on mount, then applies live updates pushed in over the mux WebSocket.
 *
 * Returns:
 *   - `artifacts`: current list (REST snapshot, then patched by mux events)
 *   - `loading`: true until the initial fetch resolves or fails
 *   - `error`: most recent fetch/parse error message, or null
 *
 * Live updates: when the hook runs inside a `<MuxProvider>` (always true in
 * the real dashboard, optional in tests), it subscribes to artifact events for
 * the given `sessionId`. The provider has already subscribed to the global
 * `"artifacts"` topic on the mux; this hook just consumes the fan-out:
 *   - `artifact-update` → add or replace by `artifact.id`
 *   - `artifact-delete` → remove by `artifactId`
 *   - `artifact-error`  → ignored here (logged in the provider). v1.x might
 *                       surface these in the UI.
 *
 * Outside a MuxProvider, the hook degrades gracefully to REST-only behavior —
 * useful for unit tests of ArtifactRail without spinning up the provider.
 */
export function useArtifacts(sessionId: string): {
  artifacts: Artifact[];
  loading: boolean;
  error: string | null;
} {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mux = useMuxOptional();

  // Initial fetch via REST.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { artifacts?: Artifact[] };
        if (cancelled) return;
        setArtifacts(body.artifacts ?? []);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId]);

  // Live updates via mux. Subscribe when available; ignore otherwise.
  useEffect(() => {
    if (!mux?.subscribeArtifacts) return;
    const unsubscribe = mux.subscribeArtifacts(sessionId, (event) => {
      if (event.type === "artifact-update") {
        setArtifacts((prev) => {
          const idx = prev.findIndex((c) => c.id === event.artifact.id);
          if (idx === -1) return [event.artifact, ...prev];
          const next = prev.slice();
          next[idx] = event.artifact;
          return next;
        });
      } else if (event.type === "artifact-delete") {
        setArtifacts((prev) => prev.filter((c) => c.id !== event.artifactId));
      }
      // artifact-error: ignored at the per-session level in v1.
    });
    return unsubscribe;
  }, [mux, sessionId]);

  return { artifacts, loading, error };
}
