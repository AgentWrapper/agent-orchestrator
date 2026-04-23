"use client";

import { useMemo } from "react";
import type { ActivityState } from "@/lib/types";
import { useMuxOptional } from "@/providers/MuxProvider";

export function useMuxSessionActivity(
  sessionId: string,
): { activity: ActivityState | null } | null {
  const mux = useMuxOptional();
  const patch = mux?.sessions.find((s) => s.id === sessionId);
  return useMemo(
    () => (patch ? { activity: (patch.activity as ActivityState) ?? null } : null),
    [patch],
  );
}
