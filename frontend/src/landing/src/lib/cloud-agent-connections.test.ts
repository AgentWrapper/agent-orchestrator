import { describe, expect, it } from "vitest";

import type { ProviderConnection } from "./cloud-api";
import {
  connectedAgentIDs,
  defaultConnectedAgent,
} from "./cloud-agent-connections";

function connection(
  provider: ProviderConnection["provider"],
  validationState: ProviderConnection["validationState"] = "valid",
): ProviderConnection {
  return {
    id: `${provider}-connection`,
    provider,
    label: "default",
    config: {},
    validationState,
  };
}

describe("cloud agent connections", () => {
  it("excludes Daytona and invalid agent credentials", () => {
    const connected = connectedAgentIDs([
      connection("daytona"),
      connection("claude-code", "invalid"),
      connection("codex"),
    ]);

    expect([...connected]).toEqual(["codex"]);
  });

  it("chooses the first connected agent in product priority order", () => {
    expect(
      defaultConnectedAgent([connection("cursor"), connection("codex")]),
    ).toBe("codex");
    expect(defaultConnectedAgent([])).toBeUndefined();
  });
});
