"use client";

import { useState, useEffect, useRef } from "react";
import { backoffDelayMs, sleep, untilVisible } from "./pollUtils";

export interface RawFileData {
  kind: "raw";
  content: string;
  path: string;
  size: number;
  mtime: string;
}

export interface DiffFileData {
  kind: "diff";
  path: string;
  status: string;
  diff: string | null;
  content: string | null;
}

export type FileViewData = RawFileData | DiffFileData;

interface FileViewError {
  error: string;
  message: string;
  path?: string;
  size?: number;
}

interface FileViewState {
  data: FileViewData | null;
  error: FileViewError | null;
  loading: boolean;
}

type DiffScope = "local" | "branch";

function buildUrl(sessionId: string, path: string, mode: "raw" | "diff", scope: DiffScope): string {
  if (mode === "diff") {
    const segments = path.split("/").filter(Boolean).map(encodeURIComponent);
    return `/api/sessions/${encodeURIComponent(sessionId)}/diff/${segments.join("/")}?scope=${scope}`;
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(path)}`;
}

export function useFileView(
  sessionId: string,
  path: string | null,
  mode: "raw" | "diff",
  scope: DiffScope = "local",
) {
  const [state, setState] = useState<FileViewState>({
    data: null,
    error: null,
    loading: !!path,
  });

  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    etagRef.current = null;

    setState({ data: null, error: null, loading: true });

    async function doFetch(): Promise<{ ok: boolean }> {
      const url = buildUrl(sessionId, path as string, mode, scope);
      const headers: Record<string, string> = {};
      if (etagRef.current) headers["If-None-Match"] = etagRef.current;

      try {
        const res = await fetch(url, { signal, headers });
        if (signal.aborted) return { ok: true };

        if (res.status === 304) {
          setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
          return { ok: true };
        }

        if (res.status === 422) {
          const body = (await res.json()) as FileViewError;
          if (signal.aborted) return { ok: true };
          setState({ data: null, error: body, loading: false });
          // 422 is a terminal content-state (binary/too_large); don't treat as
          // a transient failure that should trigger backoff.
          return { ok: true };
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const newEtag = res.headers.get("ETag");
        if (newEtag) etagRef.current = newEtag;

        const json = await res.json();
        if (signal.aborted) return { ok: true };

        const data: FileViewData =
          mode === "raw"
            ? { kind: "raw", ...(json as Omit<RawFileData, "kind">) }
            : { kind: "diff", ...(json as Omit<DiffFileData, "kind">) };

        setState({ data, error: null, loading: false });
        return { ok: true };
      } catch (err) {
        if ((err as Error).name === "AbortError") return { ok: true };
        console.error("useFileView fetch error:", err);
        if (signal.aborted) return { ok: true };
        setState((prev) => ({
          data: prev.data,
          error: {
            error: "fetch_error",
            message: "Failed to load file",
            path: path ?? undefined,
          },
          loading: false,
        }));
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
          console.error("useFileView loop crashed:", err);
        }
      }
    }

    void run();
    return () => {
      controller.abort();
    };
  }, [sessionId, path, mode, scope]);

  return { data: state.data, error: state.error, loading: state.loading };
}
