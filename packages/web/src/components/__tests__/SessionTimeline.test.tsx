import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTimeline } from "../SessionTimeline";
import { makeSession } from "../../__tests__/helpers";

describe("SessionTimeline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let an older poll response overwrite a newer one", async () => {
    const deferred: Array<(value: Response) => void> = [];
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          deferred.push(resolve);
        }),
    );

    let pollTick: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") {
        pollTick = handler as () => void;
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {
      pollTick = null;
    });

    render(
      <SessionTimeline
        session={makeSession({
          id: "race-session",
          projectId: "proj",
          agentReportAudit: [],
        })}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);
    expect(pollTick).not.toBeNull();

    await act(async () => {
      pollTick!();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(deferred).toHaveLength(2);

    const responseWithSummary = (summary: string): Response =>
      ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            events: [
              {
                id: 1,
                ts: new Date().toISOString(),
                tsEpoch: Date.now(),
                projectId: "proj",
                sessionId: "race-session",
                source: "lifecycle",
                kind: "lifecycle.transition",
                level: "info",
                summary,
                data: null,
              },
            ],
          }),
        text: () => Promise.resolve(""),
      }) as Response;

    await act(async () => {
      deferred[1]!(responseWithSummary("newer snapshot"));
      await Promise.resolve();
    });
    expect(await screen.findByText("newer snapshot")).toBeInTheDocument();

    await act(async () => {
      deferred[0]!(responseWithSummary("older snapshot"));
      await Promise.resolve();
    });
    expect(screen.getByText("newer snapshot")).toBeInTheDocument();
    expect(screen.queryByText("older snapshot")).not.toBeInTheDocument();
  });
});
