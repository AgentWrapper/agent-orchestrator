import { afterEach, expect, it, vi } from "vitest";

import {
  clearCloudTerminalConnections,
  syncCloudTerminalConnections,
} from "./cloud-terminal-pool";

afterEach(() => {
  clearCloudTerminalConnections();
});

it("does not attach hidden runtime terminals during status sync", () => {
  const api = {
    terminalTicket: vi.fn(),
  };

  syncCloudTerminalConnections(api as never, "org-one", ["session-one"]);

  expect(api.terminalTicket).not.toHaveBeenCalled();
});
