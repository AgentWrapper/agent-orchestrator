"use client";

import { cn } from "@/lib/cn";

const activityLabels: Record<string, string> = {
  active: "active",
  ready: "ready",
  idle: "idle",
  waiting_input: "waiting",
  blocked: "blocked",
  exited: "exited",
};

interface ActivityDotProps {
  activity: string | null;
  /** When true renders only the dot (no label pill) — for detail page headers */
  dotOnly?: boolean;
  size?: number;
}

export function ActivityDot({ activity, dotOnly = false, size = 6 }: ActivityDotProps) {
  const label = (activity !== null && activityLabels[activity]) || activity || "unknown";
  const dataActivity = activity ?? undefined;
  const isPulsing = activity === "active";

  if (dotOnly) {
    return (
      <div
        className={cn("activity-dot shrink-0 rounded-full", isPulsing && "dot-pulse")}
        style={{ width: size, height: size }}
        data-activity={dataActivity}
      />
    );
  }

  return (
    <span
      className="activity-pill inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5"
      data-activity={dataActivity}
    >
      <span
        className={cn("activity-dot h-1.5 w-1.5 shrink-0 rounded-full", isPulsing && "dot-pulse")}
        data-activity={dataActivity}
      />
      <span className="activity-pill__text text-[10px] font-medium" data-activity={dataActivity}>
        {label}
      </span>
    </span>
  );
}
