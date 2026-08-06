import { useEffect, useRef } from "react";

import { buildAgentInventory } from "../lib/agent-inventory-telemetry";
import { captureRendererEvent } from "../lib/telemetry";
import { useAgentsQuery } from "./useAgentsQuery";

/**
 * Reports the install's agent inventory once per app launch.
 *
 * Mounted from the shell so it runs once, and reads the cached agents query, so
 * it adds no request of its own. Reported a single time per launch because the
 * inventory only changes when someone installs or authorizes an agent, and the
 * query refetches on focus and after a refresh mutation, which would otherwise
 * make this a repeating stream.
 */
export function useAgentInventoryTelemetry(): void {
  const { data } = useAgentsQuery();
  const reported = useRef(false);

  useEffect(() => {
    if (!data || reported.current) return;
    reported.current = true;
    void captureRendererEvent("ao.renderer.agents_available", buildAgentInventory(data));
  }, [data]);
}
