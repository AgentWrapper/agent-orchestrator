import { COMPANY } from "@ao/shared/constants";
import { getBlogPosts } from "@/lib/blog";
import { getComparisonPages } from "@/lib/compare";
import {
	buildDeveloperResourcesSection,
	buildLlmsHeader,
	buildWhenToUseSection,
	stripMdxSyntax,
} from "@/lib/llms";
import { FAQ_ITEMS } from "../components/FAQSection/constants";


export const dynamic = "force-static";

export async function GET() {
	const posts = getBlogPosts();
	const comparisons = getComparisonPages();
	const baseUrl = COMPANY.MARKETING_URL;

	const sections: string[] = [];

	// Header and guidance sections (same as llms.txt)
	sections.push(
		[
			...buildLlmsHeader(),
			"",
			...buildWhenToUseSection(),
			"",
			...buildDeveloperResourcesSection(),
		].join("\n"),
	);

	// Comparison pages - full content
	if (comparisons.length > 0) {
		sections.push(
			[
				"---",
				"",
				"# Comparisons",
				"",
				...comparisons.flatMap((page) => [
					`## ${page.title}`,
					"",
					`URL: ${baseUrl}/compare/${page.slug}/`,
					"",
					stripMdxSyntax(page.content),
					"",
				]),
			].join("\n"),
		);
	}

	// Blog posts - full content
	if (posts.length > 0) {
		sections.push(
			[
				"---",
				"",
				"# Blog Posts",
				"",
				...posts.flatMap((post) => [
					`## ${post.title}`,
					"",
					`URL: ${baseUrl}/blog/${post.slug}/`,
					`Date: ${post.date}`,
					`Author: ${post.author.name}`,
					"",
					stripMdxSyntax(post.content),
					"",
				]),
			].join("\n"),
		);
	}

	// FAQ section
	sections.push(
		[
			"---",
			"",
			"# FAQ",
			"",
			...FAQ_ITEMS.flatMap((item) => [
				`## ${item.question}`,
				"",
				item.answer,
				"",
			]),
		].join("\n"),
	);

	const content = sections.join("\n\n");

	return new Response(content, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600, s-maxage=3600",
		},
	});
}
