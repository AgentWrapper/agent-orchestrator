import type { components } from "../../api/schema";

type AgentInfo = components["schemas"]["AgentInfo"];

export const DEFAULT_AGENT_PRIORITY = ["claude-code", "codex", "cursor", "opencode", "aider"] as const;
export const DEFAULT_AGENT_PRIORITY_RANK = new Map<string, number>(
	DEFAULT_AGENT_PRIORITY.map((agent, index) => [agent, index]),
);

export type AgentStatusTone = "success" | "warning" | "muted";

export type RankedAgentOption = AgentInfo & {
	disabled: boolean;
	priorityRank: number;
	rank: number;
	status: string;
	statusTone: AgentStatusTone;
};

export function agentLabelCompare(a: AgentInfo, b: AgentInfo): number {
	return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function agentStatus(
	installedAgent: AgentInfo | undefined,
	isAuthorized: boolean,
	isAuthUnknown: boolean,
): Pick<RankedAgentOption, "status" | "statusTone"> {
	if (!installedAgent) {
		return { status: "Needs install", statusTone: "muted" };
	}
	if (isAuthUnknown) {
		return { status: "Auth unknown", statusTone: "warning" };
	}
	if (!isAuthorized) {
		return { status: "Needs auth", statusTone: "warning" };
	}
	// Authorized agents stay clean — only surface problem statuses in the menu.
	return { status: "", statusTone: "success" };
}

export function buildRankedAgentOptions({
	supported,
	installed,
	authorized,
	priorityRank,
	fallbackAgents,
	filter,
}: {
	supported?: AgentInfo[];
	installed?: AgentInfo[];
	authorized?: AgentInfo[];
	priorityRank: Map<string, number>;
	fallbackAgents: AgentInfo[];
	filter?: (agent: AgentInfo) => boolean;
}): RankedAgentOption[] {
	const supportedAgents = (supported ?? fallbackAgents).filter((agent) => (filter ? filter(agent) : true));
	const installedAgents = installed ?? supportedAgents;
	const authorizedAgents = authorized ?? supportedAgents;
	const authorizedIds = new Set(authorizedAgents.map((agent) => agent.id));
	const installedById = new Map(installedAgents.map((agent) => [agent.id, agent]));

	return supportedAgents
		.map((agent) => {
			const installedAgent = installedById.get(agent.id);
			const authStatus = installedAgent?.authStatus;
			const isAuthorized = authorizedIds.has(agent.id) || authStatus === "authorized";
			const isAuthUnknown = Boolean(installedAgent) && !isAuthorized && authStatus !== "unauthorized";
			const isSelectable = isAuthorized || isAuthUnknown;
			const rank = isAuthorized ? 0 : isAuthUnknown ? 1 : installedAgent ? 2 : 3;
			return {
				...agent,
				disabled: !isSelectable,
				priorityRank: priorityRank.get(agent.id) ?? Number.MAX_SAFE_INTEGER,
				rank,
				...agentStatus(installedAgent, isAuthorized, isAuthUnknown),
			};
		})
		.sort((a, b) => a.rank - b.rank || a.priorityRank - b.priorityRank || agentLabelCompare(a, b));
}
