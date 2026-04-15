"use client";

import type { ActivityState } from "@/lib/types";
import { useMux } from "@/providers/MuxProvider";

export function useMuxSessionActivity(
  sessionId: string,
): { activity: ActivityState | null } | null {
  const mux = useMux();
  const patch = mux.sessions.find((s) => s.id === sessionId);
  if (!patch) return null;
  return { activity: (patch.activity as ActivityState) ?? null };
}
