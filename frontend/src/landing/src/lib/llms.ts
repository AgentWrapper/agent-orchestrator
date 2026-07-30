import { COMPANY } from "@ao/shared/constants";
import { FAQ_ITEMS } from "@/app/components/FAQSection/constants";
import { getBlogPosts } from "./blog";
import { getComparisonPages } from "./compare";

export function stripMdxSyntax(content: string): string {
	return (
		content
			// Remove import statements
			.replace(/^import\s+.*$/gm, "")
			// Remove JSX component tags (e.g. <Video ... />, <Component>...</Component>)
			.replace(/<[A-Z]\w*\b[^>]*\/>/g, "")
			.replace(/<[A-Z]\w*\b[^>]*>[\s\S]*?<\/[A-Z]\w*>/g, "")
			// Clean up excessive blank lines
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

export function buildLlmsHeader(): string[] {
	return [
		`# ${COMPANY.NAME}`,
		"",
		"> Run 10+ parallel coding agents on your machine",
		"",
		`${COMPANY.NAME} is an open-source desktop application that lets developers run multiple AI coding agents in parallel, each in its own isolated Git worktree. It works with any CLI-based agent including Claude Code, OpenCode, and OpenAI Codex. Agents can work on different branches or features simultaneously without conflicts. ${COMPANY.NAME} is free, does not proxy API calls, and supports macOS with Windows and Linux coming soon.`,
	];
}

export function buildWhenToUseSection(): string[] {
	return [
		"## When to use Agent Orchestrator",
		"",
		"Reach for Agent Orchestrator when you need to:",
		"",
		"- Run several coding agents (Claude Code, Codex, OpenCode, or any CLI agent) at the same time on one repository without them stepping on each other, each agent gets an isolated Git worktree and its own branch.",
		"- Orchestrate agent work through the desktop app and local `ao` CLI: create workspaces, launch agents with a prompt, open terminals, and track tasks.",
		"- Schedule recurring agent runs (automations) that execute a prompt on a cron-like schedule in a fresh or existing workspace.",
		"- Review diffs, manage ports, and monitor many concurrent agent sessions from one dashboard.",
		"",
		"Agent Orchestrator is not a coding agent itself; it is the local workspace and orchestration layer the agents run in. If you are an AI agent inside an AO-managed session, use the installed `ao` CLI. To learn the product, start with the docs index at https://aoagents.dev/docs/.",
	];
}

export function buildDeveloperResourcesSection(): string[] {
	const baseUrl = COMPANY.MARKETING_URL;
	const docsUrl = COMPANY.DOCS_URL;
	return [
		"## Developer resources",
		"",
		`- [Documentation](${docsUrl}/): product and workflow documentation`,
		`- [Quickstart](${docsUrl}/quickstart/): install and first-run guide`,
		`- [CLI](${docsUrl}/cli/): local \`ao\` command reference`,
		`- [Agent instructions](${baseUrl}/agents.md): when and how AI agents should use Agent Orchestrator`,
		`- [Blog llms.txt](${baseUrl}/blog/llms.txt): scoped index of blog posts`,
		`- [GitHub](${COMPANY.GITHUB_URL}): source code and releases`,
	];
}

export function buildLlmsTxt(): string {
	const posts = getBlogPosts();
	const comparisons = getComparisonPages();
	const baseUrl = COMPANY.MARKETING_URL;
	const docsUrl = COMPANY.DOCS_URL;

	const lines: string[] = [
		...buildLlmsHeader(),
		"",
		...buildWhenToUseSection(),
		"",
		...buildDeveloperResourcesSection(),
		"",
		"## Docs",
		"",
		`- [Documentation](${docsUrl}/)`,
		`- [Quickstart](${docsUrl}/quickstart/)`,
		`- [GitHub](${COMPANY.GITHUB_URL})`,
		"",
		"## Blog",
		"",
		...posts.map((post) => `- [${post.title}](${baseUrl}/blog/${post.slug}/)`),
		"",
		"## Comparisons",
		"",
		...comparisons.map(
			(page) => `- [${page.title}](${baseUrl}/compare/${page.slug}/)`,
		),
		"",
		"## FAQ",
		"",
		...FAQ_ITEMS.flatMap((item) => [
			`### ${item.question}`,
			"",
			item.answer,
			"",
		]),
	];

	return lines.join("\n");
}

export const MARKDOWN_HEADERS = {
	"Content-Type": "text/markdown; charset=utf-8",
	"Cache-Control": "public, max-age=3600, s-maxage=3600",
	Vary: "Accept",
} as const;
