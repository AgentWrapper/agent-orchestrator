import type {
  AgentCredentialType,
  CloudAgent,
  ProviderConnection,
} from "./cloud-api";

export interface CloudAgentOption {
  id: CloudAgent;
  label: string;
  credentialTypes: ReadonlyArray<{
    id: AgentCredentialType;
    label: string;
    placeholder: string;
  }>;
}

export const CLOUD_AGENTS: ReadonlyArray<CloudAgentOption> = [
  {
    id: "claude-code",
    label: "Claude Code",
    credentialTypes: [
      {
        id: "oauth_token",
        label: "Claude access token",
        placeholder: "Run `claude setup-token` and paste the token here",
      },
      {
        id: "api_key",
        label: "Anthropic API key",
        placeholder: "Paste your Anthropic API key, for example sk-ant-...",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    credentialTypes: [
      {
        id: "api_key",
        label: "OpenAI API key",
        placeholder: "OpenAI API key",
      },
      {
        id: "access_token",
        label: "Codex access token",
        placeholder: "Codex access token",
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    credentialTypes: [
      {
        id: "api_key",
        label: "Cursor API key",
        placeholder: "Cursor API key",
      },
    ],
  },
];

export function agentConnections(
  connections: ProviderConnection[],
): ProviderConnection[] {
  const agentIDs = new Set<CloudAgent>(CLOUD_AGENTS.map(({ id }) => id));
  return connections.filter(
    (connection) =>
      agentIDs.has(connection.provider as CloudAgent) &&
      connection.validationState === "valid",
  );
}

export function connectedAgentIDs(
  connections: ProviderConnection[],
): Set<CloudAgent> {
  return new Set(
    agentConnections(connections).map(({ provider }) => provider as CloudAgent),
  );
}

export function defaultConnectedAgent(
  connections: ProviderConnection[],
): CloudAgent | undefined {
  const connected = connectedAgentIDs(connections);
  return CLOUD_AGENTS.find(({ id }) => connected.has(id))?.id;
}
