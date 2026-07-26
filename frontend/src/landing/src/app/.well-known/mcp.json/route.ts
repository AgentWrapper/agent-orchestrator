import { COMPANY } from "@superset/shared/constants";
import { MCP_SERVER_URL } from "@/lib/llms";

export const dynamic = "force-static";

export function GET() {
	return Response.json(
		{
			servers: [
				{
					name: "ao-agents",
					description: `${COMPANY.NAME} MCP server, orchestrate parallel coding agents, workspaces, automations, and tasks.`,
					url: MCP_SERVER_URL,
					transport: "streamable-http",
					serverCard: `${COMPANY.MARKETING_URL}/.well-known/mcp/server-card.json`,
					authentication: {
						type: "oauth2",
						resourceMetadataUrl: `${COMPANY.MARKETING_URL}/.well-known/oauth-protected-resource`,
					},
					documentation: `${COMPANY.DOCS_URL}/mcp-server`,
				},
			],
		},
		{
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Cache-Control": "public, max-age=3600, s-maxage=3600",
			},
		},
	);
}
