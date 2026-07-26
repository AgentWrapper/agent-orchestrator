import { buildLlmsTxt, MARKDOWN_HEADERS } from "@/lib/llms";


export const dynamic = "force-static";

export async function GET() {
	return new Response(buildLlmsTxt(), { headers: MARKDOWN_HEADERS });
}
