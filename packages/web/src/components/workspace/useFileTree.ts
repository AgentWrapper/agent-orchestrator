"use client";

import { useState, useEffect, useRef } from "react";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";
import { backoffDelayMs, sleep, untilVisible } from "./pollUtils";

type GitStatus = "M" | "A" | "D" | "?" | "R";

type DiffScope = "local" | "branch";

export interface FileTreeState {
  tree: FileNode[];
  gitStatus: Record<string, GitStatus>;
  baseRef: string | null;
}

export function useFileTree(sessionId: string, scope: DiffScope = "local") {
  const [state, setState] = useState<FileTreeState>({ tree: [], gitStatus: {}, baseRef: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    etagRef.current = null;

    async function doFetch(): Promise<{ ok: boolean }> {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/files?scope=${scope}`;
      const headers: Record<string, string> = {};
      if (etagRef.current) headers["If-None-Match"] = etagRef.current;

      try {
        const res = await fetch(url, { signal, headers });
        if (signal.aborted) return { ok: true };

        if (res.status === 304) {
          setLoading(false);
          return { ok: true };
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const newEtag = res.headers.get("ETag");
        if (newEtag) etagRef.current = newEtag;

        const data = (await res.json()) as FileTreeState & { scope?: string; baseRef?: string | null };
        if (signal.aborted) return { ok: true };

        setState({ tree: data.tree, gitStatus: data.gitStatus, baseRef: data.baseRef ?? null });
        setError(null);
        setLoading(false);
        return { ok: true };
      } catch (err) {
        if ((err as Error).name === "AbortError") return { ok: true };
        console.error("Failed to fetch file tree:", err);
        if (signal.aborted) return { ok: true };
        setError("Failed to load file tree");
        setLoading(false);
        return { ok: false };
      }
    }

    async function run() {
      try {
        let errors = (await doFetch()).ok ? 0 : 1;
        while (true) {
          await sleep(backoffDelayMs(errors), signal);
          await untilVisible(signal);
          const result = await doFetch();
          errors = result.ok ? 0 : errors + 1;
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("useFileTree loop crashed:", err);
        }
      }
    }

    void run();
    return () => {
      controller.abort();
    };
  }, [sessionId, scope]);

  return { tree: state.tree, gitStatus: state.gitStatus, baseRef: state.baseRef, loading, error };
}
