import { COMPANY } from "@ao/shared/constants";


export const dynamic = "force-static";

export function GET() {
	const baseUrl = COMPANY.MARKETING_URL;

	const content = `# Default: open to all crawlers
User-Agent: *
Allow: /
Disallow: /api/
Disallow: /_next/

# Content Signals (https://contentsignals.org)
Content-Signal: search=yes, ai-input=yes, ai-train=yes

# AI assistants, search, and training crawlers - explicitly welcome
User-Agent: ChatGPT-User
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: OAI-SearchBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: GPTBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: Claude-User
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: Claude-SearchBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: PerplexityBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: GoogleOther
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: Google-Extended
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: Applebot-Extended
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: Bingbot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: meta-externalagent
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

User-Agent: DuckAssistBot
Allow: /
Content-Signal: search=yes, ai-input=yes, ai-train=yes

# Bulk-scraping crawlers - not welcome
User-Agent: CCBot
Disallow: /

User-Agent: Bytespider
Disallow: /

Sitemap: ${baseUrl}/sitemap.xml
`;

	return new Response(content, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600, s-maxage=3600",
		},
	});
}
