import { describe, expect, it } from "vitest";
import { resolveNotificationRoute } from "../notifier-resolution.js";
import type { EventPriority, OrchestratorConfig } from "../types.js";

function makeConfig(
  defaults: string[],
  notificationRouting: Partial<Record<EventPriority, string[]>> = {},
): Pick<OrchestratorConfig, "defaults" | "notificationRouting"> {
  return {
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: defaults,
    },
    notificationRouting: notificationRouting as OrchestratorConfig["notificationRouting"],
  };
}

describe("resolveNotificationRoute", () => {
  it("applies config-light dashboard + desktop default routing", () => {
    const config = makeConfig(["dashboard", "desktop"]);

    expect(resolveNotificationRoute(config, "urgent")).toEqual(["desktop", "dashboard"]);
    expect(resolveNotificationRoute(config, "warning")).toEqual(["desktop", "dashboard"]);
    expect(resolveNotificationRoute(config, "action")).toEqual(["dashboard"]);
    expect(resolveNotificationRoute(config, "info")).toEqual(["dashboard"]);
  });

  it("treats explicit priority routes as authoritative", () => {
    const config = makeConfig(["dashboard", "desktop"], {
      action: ["desktop"],
      warning: [],
    });

    expect(resolveNotificationRoute(config, "action")).toEqual(["desktop"]);
    expect(resolveNotificationRoute(config, "warning")).toEqual([]);
  });

  it("routes custom default notifiers to all priorities when no explicit route exists", () => {
    const config = makeConfig(["dashboard", "desktop", "alerts"]);

    expect(resolveNotificationRoute(config, "urgent")).toEqual(["desktop", "dashboard", "alerts"]);
    expect(resolveNotificationRoute(config, "action")).toEqual(["dashboard", "alerts"]);
  });
});
