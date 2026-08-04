import type { AgentCatalog } from "../hooks/useAgentsQuery";

/**
 * How many agents an install actually has available.
 *
 * The open product question is whether most people ever configure more than one
 * agent. Nothing answered it: `ao.session.spawned` carries the harness that ran,
 * so it shows which agents get *used*, not how many were available to choose
 * from. An install with six authorized agents that always picks one looks
 * identical to an install that only has one.
 *
 * `installed` means the binary resolved; `authorized` means its auth probe
 * recently succeeded, which is the number that matters for "can this person
 * actually spawn it".
 */
export type AgentInventory = {
  installed_count: number;
  authorized_count: number;
  supported_count: number;
  /**
   * Sorted, comma-joined authorized agent ids.
   *
   * Safe because agent ids are a fixed vocabulary from AO's own registry
   * (`claude-code`, `codex`, …), not user-supplied text. Sorted so the same set
   * produces the same value and can be grouped in analysis.
   */
  authorized_agents: string;
};

/** Agent ids are short registry slugs; this bounds the joined string anyway. */
const MAX_AGENT_LIST_LENGTH = 200;

export function buildAgentInventory(catalog: AgentCatalog): AgentInventory {
  const authorized = (catalog.authorized ?? [])
    .map((agent) => agent.id)
    .filter((id): id is string => typeof id === "string" && id !== "")
    .sort();
  const joined = authorized.join(",");
  return {
    installed_count: (catalog.installed ?? []).length,
    authorized_count: authorized.length,
    supported_count: (catalog.supported ?? []).length,
    authorized_agents: joined.slice(0, MAX_AGENT_LIST_LENGTH),
  };
}
