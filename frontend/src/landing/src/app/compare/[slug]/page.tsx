import { COMPANY } from "@ao/shared/constants";
import type { Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import { notFound } from "next/navigation";
import remarkGfm from "remark-gfm";
import {
	ComparisonJsonLd,
	FAQPageJsonLd,
} from "@/components/JsonLd";
import { docsMdxComponents } from "@/app/docs/components/mdx";
import {
	formatCompareDate,
	getAllComparisonSlugs,
	getComparisonPage,
} from "@/lib/compare";
import { extractComparisonFaqItems } from "@/lib/compare-utils";

export const dynamicParams = false;

export function generateStaticParams() {
	return getAllComparisonSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
	params,
}: {
	params: Promise<{ slug: string }>;
}): Promise<Metadata> {
	const { slug } = await params;
	const page = getComparisonPage(slug);
	if (!page) return { title: "Comparison not found" };

	return {
		title: page.title,
		description: page.description,
		keywords: page.keywords,
		alternates: { canonical: page.url },
		openGraph: {
			title: page.title,
			description: page.description,
			url: page.url,
			images: [page.image ?? "/og-image.png"],
		},
	};
}

export default async function ComparisonPage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	const page = getComparisonPage(slug);
	if (!page) notFound();

	const url = `${COMPANY.MARKETING_URL}${page.url}`;
	const faqItems = extractComparisonFaqItems(page.content);

	return (
		<main className="min-h-screen bg-background">
			<ComparisonJsonLd
				title={page.title}
				description={page.description}
				publishedTime={page.date}
				modifiedTime={page.lastUpdated}
				url={url}
				image={page.image}
				keywords={page.keywords}
				articleSection="Comparisons"
			/>
			{faqItems.length > 0 && <FAQPageJsonLd items={faqItems} />}

			<header className="mx-auto max-w-4xl px-6 pt-16 pb-10 md:pt-20">
				<p className="text-sm text-muted-foreground">Comparison</p>
				<h1 className="mt-4 text-balance text-3xl font-medium tracking-[-0.5px] text-foreground md:text-5xl">
					{page.title}
				</h1>
				<p className="mt-4 max-w-3xl text-pretty text-lg text-muted-foreground">
					{page.description}
				</p>
				<p className="mt-4 text-sm text-muted-foreground">
					Updated {formatCompareDate(page.lastUpdated ?? page.date)}
				</p>
			</header>

			<article className="prose prose-invert mx-auto max-w-4xl px-6 pb-20 text-foreground prose-headings:text-balance prose-headings:font-medium prose-headings:text-foreground prose-p:text-pretty prose-p:text-muted-foreground prose-li:text-muted-foreground prose-strong:text-foreground prose-a:text-foreground prose-a:underline prose-a:underline-offset-4 prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-muted/35 prose-th:text-foreground prose-td:text-muted-foreground">
				<MDXRemote
					source={page.content}
					components={docsMdxComponents}
					options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
				/>
			</article>
		</main>
	);
}
