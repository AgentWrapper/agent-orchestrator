"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

type PullRequestCategory = "breaking" | "feature" | "fix" | "docs" | "maintenance";

export type RelatedPullRequest = {
	number: number;
	title: string;
	mergedAt: string;
	url: string;
	author: string;
	category: PullRequestCategory;
};

const pullRequestDateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

function formatPullRequestDate(date: string) {
	return pullRequestDateFormatter.format(new Date(date));
}

export function ChangelogDetails({
	pullRequests,
	areaLabel,
}: {
	pullRequests: RelatedPullRequest[];
	areaLabel: string;
}) {
	return (
		<Accordion type="single" collapsible className="not-prose w-full">
			<AccordionItem value="related-changes">
				<AccordionTrigger>
					<span>Related {areaLabel.toLowerCase()} changes</span>
					<span className="ml-auto text-xs font-normal text-muted-foreground">{pullRequests.length}</span>
				</AccordionTrigger>
				<AccordionContent>
					<ul className="space-y-3">
						{pullRequests.map((pullRequest) => (
							<li key={pullRequest.number} className="border-l border-border pl-3">
								<a
									href={pullRequest.url}
									target="_blank"
									rel="noreferrer"
									className="font-medium text-foreground underline-offset-4 transition-colors hover:underline"
								>
									{pullRequest.title}
								</a>
								<div className="mt-1 text-xs text-muted-foreground">
									#{pullRequest.number} · @{pullRequest.author} · {formatPullRequestDate(pullRequest.mergedAt)}
								</div>
							</li>
						))}
					</ul>
				</AccordionContent>
			</AccordionItem>
		</Accordion>
	);
}
