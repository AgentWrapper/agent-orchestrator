"use client";

import { useEffect, useState } from "react";
import type { CanvasArtifact } from "@aoagents/ao-core";

const POLL_INTERVAL_MS = 5000;

export function useSessionCanvases(sessionId: string | null): {
  canvases: CanvasArtifact[];
  loading: boolean;
  error: string | null;
} {
  const [canvases, setCanvases] = useState<CanvasArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset on session change so canvases from a previous session never bleed
    // into the new view.
    setCanvases([]);
    setError(null);

    if (!sessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Track in-flight requests so an older response can't overwrite a newer one
    // when polls overlap (e.g. the API takes longer than POLL_INTERVAL_MS).
    let nextSeq = 0;
    let latestApplied = -1;

    const fetchOnce = async () => {
      const seq = nextSeq++;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/canvases`);
        if (cancelled || seq < latestApplied) return;
        if (!res.ok) {
          latestApplied = seq;
          setError(`HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { canvases?: CanvasArtifact[] };
        if (cancelled || seq < latestApplied) return;
        latestApplied = seq;
        setCanvases(data.canvases ?? []);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled || seq < latestApplied) return;
        latestApplied = seq;
        setError(err instanceof Error ? err.message : "fetch failed");
        setLoading(false);
      }
    };

    const schedule = () => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          await fetchOnce();
        }
        if (!cancelled) schedule();
      }, POLL_INTERVAL_MS);
    };

    void fetchOnce();
    schedule();

    const onVisibilityChange = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void fetchOnce();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [sessionId]);

  return { canvases, loading, error };
}
