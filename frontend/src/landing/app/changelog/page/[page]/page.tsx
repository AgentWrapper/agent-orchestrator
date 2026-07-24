import type { Metadata } from "next";
import { ChangelogPage } from "../../ChangelogPage";
import { totalChangelogPages } from "../../changelog-pages";

type ChangelogArchivePageProps = {
	params: Promise<{ page: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
	return Array.from({ length: Math.max(0, totalChangelogPages - 1) }, (_, index) => ({
		page: String(index + 2),
	}));
}

export async function generateMetadata({ params }: ChangelogArchivePageProps): Promise<Metadata> {
	const { page } = await params;
	return {
		title: `Changelog — Page ${page} — Agent Orchestrator`,
		description: "Every merged Agent Orchestrator pull request, organized into real product updates.",
		alternates: {
			canonical: `https://aoagents.dev/changelog/page/${page}`,
		},
	};
}

export default async function ChangelogArchivePage({ params }: ChangelogArchivePageProps) {
	const { page } = await params;
	return <ChangelogPage currentPage={Number.parseInt(page, 10)} />;
}
