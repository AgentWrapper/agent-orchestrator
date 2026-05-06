import { describe, expect, it } from "vitest";
import {
  ACTIVITY_STRONG_WINDOW_MS,
  ACTIVITY_WEAK_WINDOW_MS,
  classifyActivitySignal,
  createActivitySignal,
  hasPositiveIdleEvidence,
  isWeakActivityEvidence,
  summarizeActivityFreshness,
  supportsRecentLiveness,
} from "../activity-signal.js";

describe("summarizeActivityFreshness", () => {
  const now = new Date("2025-01-01T12:00:00.000Z");

  it("returns none without a timestamp", () => {
    expect(summarizeActivityFreshness(undefined, now)).toBe("none");
  });

  it("classifies exact strong and weak boundaries correctly", () => {
    expect(
      summarizeActivityFreshness(new Date(now.getTime() - ACTIVITY_STRONG_WINDOW_MS), now),
    ).toBe("strong");
    expect(
      summarizeActivityFreshness(new Date(now.getTime() - ACTIVITY_WEAK_WINDOW_MS), now),
    ).toBe("weak");
  });

  it("treats future timestamps as strong instead of going negative", () => {
    expect(summarizeActivityFreshness(new Date("2025-01-01T12:01:00.000Z"), now)).toBe("strong");
  });

  it("returns stale when the timestamp is older than the weak window", () => {
    expect(
      summarizeActivityFreshness(new Date(now.getTime() - ACTIVITY_WEAK_WINDOW_MS - 1), now),
    ).toBe("stale");
  });
});

describe("classifyActivitySignal", () => {
  const now = new Date("2025-01-01T12:00:00.000Z");

  it("keeps fresh active activity as valid", () => {
    expect(
      classifyActivitySignal(
        {
          state: "active",
          timestamp: new Date("2025-01-01T11:59:30.000Z"),
        },
        "native",
        now,
      ),
    ).toEqual({
      state: "valid",
      activity: "active",
      timestamp: new Date("2025-01-01T11:59:30.000Z"),
      source: "native",
      detail: undefined,
    });
  });

  it("marks idle-without-timestamp as stale missing_timestamp evidence", () => {
    expect(classifyActivitySignal({ state: "idle" }, "native", now)).toEqual({
      state: "stale",
      activity: "idle",
      timestamp: undefined,
      source: "native",
      detail: "missing_timestamp",
    });
  });

  it("marks blocked-without-timestamp as stale missing_timestamp evidence", () => {
    expect(classifyActivitySignal({ state: "blocked" }, "terminal", now)).toEqual({
      state: "stale",
      activity: "blocked",
      timestamp: undefined,
      source: "terminal",
      detail: "missing_timestamp",
    });
  });

  it("keeps active-without-timestamp valid because it is positive liveness evidence", () => {
    expect(classifyActivitySignal({ state: "active" }, "native", now).state).toBe("valid");
  });

  it("marks stale active evidence as stale_timestamp", () => {
    expect(
      classifyActivitySignal(
        {
          state: "active",
          timestamp: new Date(now.getTime() - ACTIVITY_WEAK_WINDOW_MS - 1),
        },
        "native",
        now,
      ),
    ).toMatchObject({
      state: "stale",
      activity: "active",
      detail: "stale_timestamp",
    });
  });

  it("keeps exited activity valid even without timestamp", () => {
    expect(classifyActivitySignal({ state: "exited" }, "runtime", now)).toEqual({
      state: "valid",
      activity: "exited",
      timestamp: undefined,
      source: "runtime",
      detail: undefined,
    });
  });
});

describe("activity signal helpers", () => {
  const now = new Date("2025-01-01T12:00:00.000Z");

  it("detects positive idle evidence only for valid idle states with timestamps", () => {
    expect(
      hasPositiveIdleEvidence(
        createActivitySignal("valid", {
          activity: "idle",
          timestamp: new Date("2025-01-01T11:59:00.000Z"),
          source: "native",
        }),
      ),
    ).toBe(true);
    expect(
      hasPositiveIdleEvidence(createActivitySignal("valid", { activity: "idle", source: "native" })),
    ).toBe(false);
    expect(
      hasPositiveIdleEvidence(
        createActivitySignal("stale", {
          activity: "idle",
          timestamp: new Date("2025-01-01T11:59:00.000Z"),
          source: "native",
        }),
      ),
    ).toBe(false);
  });

  it("supports recent liveness only for valid active/ready timestamps within the weak window", () => {
    expect(
      supportsRecentLiveness(
        createActivitySignal("valid", {
          activity: "ready",
          timestamp: new Date("2025-01-01T11:56:00.000Z"),
          source: "native",
        }),
        now,
      ),
    ).toBe(true);
    expect(
      supportsRecentLiveness(
        createActivitySignal("valid", {
          activity: "active",
          timestamp: new Date("2025-01-01T11:54:59.999Z"),
          source: "native",
        }),
        now,
      ),
    ).toBe(false);
  });

  it("treats all non-valid signals as weak evidence", () => {
    expect(isWeakActivityEvidence(createActivitySignal("valid", { activity: "active" }))).toBe(
      false,
    );
    expect(isWeakActivityEvidence(createActivitySignal("stale", { activity: "active" }))).toBe(
      true,
    );
    expect(isWeakActivityEvidence(createActivitySignal("unavailable"))).toBe(true);
  });
});
