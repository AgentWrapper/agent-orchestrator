import { COMPANY } from "@superset/shared/constants";
import { MCP_SERVER_URL } from "@/lib/llms";


export const dynamic = "force-static";

const FALLBACK_CARD = {
  name: "ao-agents",
  description:
    `${COMPANY.NAME} MCP server: create Git-worktree workspaces, launch coding-agent sessions, schedule automations, open terminals, and manage tasks.`,
  version: "0.1.0",
  serverUrl: MCP_SERVER_URL,
  transport: "streamable-http",
  documentationUrl: `${COMPANY.DOCS_URL}/mcp-server`,
  authentication: {
    type: "oauth2",
    resourceMetadataUrl: `${COMPANY.MARKETING_URL}/.well-known/oauth-protected-resource`,
  },
  tools: [] as unknown[],
};

export function GET() {
  return Response.json(FALLBACK_CARD, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
