import { ChangelogDetails, type RelatedPullRequest } from "@/components/changelog/ChangelogDetails";
import { ChangelogPagination } from "@/components/changelog/ChangelogPagination";
import { LandingNav } from "@/components/LandingNav";
import changelogData from "@/data/changelog.json";
import { formatDate } from "@/lib/utils";
import { DATE_GROUPS_PER_PAGE, totalChangelogPages } from "./changelog-pages";

type PullRequestCategory = "breaking" | "feature" | "fix" | "docs" | "maintenance";

type ChangelogPullRequest = RelatedPullRequest & {
	displayTitle: string;
	bodySummary: string[];
	summarySource: "pull-request-body" | "pull-request-title";
	labels: string[];
	additions: number;
	deletions: number;
	changedFiles: number;
	importance: number;
	area: {
		key: string;
		label: string;
	};
};

type ChangelogStory = {
	key: string;
	leadPullRequestNumber: number;
	pullRequestNumbers: number[];
	date: string;
};

type FirstCommit = {
	hash: string;
	authoredAt: string;
	authorName: string;
	subject: string;
	url: string;
};

type ChangelogData = {
	generatedAt: string;
	repository: string;
	sourceBranch: string;
	firstCommit: FirstCommit;
	stories: ChangelogStory[];
	pullRequests: ChangelogPullRequest[];
};

const data = changelogData as ChangelogData;
const pullRequestsByNumber = new Map(data.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));

const categoryLabels: Record<PullRequestCategory, string> = {
	breaking: "Breaking change",
	feature: "Feature",
	fix: "Fix",
	docs: "Documentation",
	maintenance: "Engineering",
};

function ExternalArrow() {
	return (
		<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5 shrink-0">
			<path d="M5 3h8v8M13 3 3 13" stroke="currentColor" strokeWidth="1.4" />
		</svg>
	);
}

function getStory(story: ChangelogStory) {
	const leadPullRequest = pullRequestsByNumber.get(story.leadPullRequestNumber);
	if (!leadPullRequest) throw new Error(`Missing lead pull request #${story.leadPullRequestNumber}`);

	const pullRequests = story.pullRequestNumbers.map((number) => {
		const pullRequest = pullRequestsByNumber.get(number);
		if (!pullRequest) throw new Error(`Missing pull request #${number}`);
		return pullRequest;
	});

	return { story, leadPullRequest, pullRequests };
}

function groupStoriesByDate(changelogs: ReturnType<typeof getStory>[], firstCommit: FirstCommit) {
	const dateGroups = new Map<string, { entries: ReturnType<typeof getStory>[]; firstCommit?: FirstCommit }>();

	for (const changelog of changelogs) {
		const dateKey = changelog.story.date.slice(0, 10);
		const dateGroup = dateGroups.get(dateKey) ?? { entries: [] };
		dateGroup.entries.push(changelog);
		dateGroups.set(dateKey, dateGroup);
	}

	const firstCommitDate = firstCommit.authoredAt.slice(0, 10);
	const firstCommitGroup = dateGroups.get(firstCommitDate) ?? { entries: [] };
	firstCommitGroup.firstCommit = firstCommit;
	dateGroups.set(firstCommitDate, firstCommitGroup);

	return Array.from(dateGroups, ([dateKey, dateGroup]) => ({
		dateKey,
		date: new Date(`${dateKey}T00:00:00Z`),
		...dateGroup,
	})).sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

const dateGroups = groupStoriesByDate(data.stories.map(getStory), data.firstCommit);

export function ChangelogPage({ currentPage }: { currentPage: number }) {
	const page = Math.min(Math.max(1, currentPage), totalChangelogPages);
	const pageStart = (page - 1) * DATE_GROUPS_PER_PAGE;
	const visibleDateGroups = dateGroups.slice(pageStart, pageStart + DATE_GROUPS_PER_PAGE);

	return (
		<div className="changelog-template relative min-h-dvh bg-background pt-24 text-foreground">
			<div className="landing-page contents">
				<LandingNav />
			</div>

			<main className="mx-auto max-w-5xl px-6 pt-10 lg:px-10">
				<div className="relative">
					{visibleDateGroups.map((dateGroup) => {
						const updateCount = dateGroup.entries.length + (dateGroup.firstCommit ? 1 : 0);

						return (
							<section key={dateGroup.dateKey} className="relative">
								<div className="flex flex-col gap-y-6 md:flex-row">
									<div className="shrink-0 md:w-48">
										<div className="pb-4 md:sticky md:top-8 md:pb-10">
											<time dateTime={dateGroup.dateKey} className="block text-sm font-medium text-muted-foreground">
												{formatDate(dateGroup.date)}
											</time>
											<p className="mt-2 text-xs text-muted-foreground">
												{updateCount} {updateCount === 1 ? "update" : "updates"}
											</p>
										</div>
									</div>

									<div className="relative flex-1 pb-14 md:pl-8">
										<div className="absolute left-0 top-2 hidden h-full w-px bg-border md:block" />

										<div className="space-y-14">
											{dateGroup.entries.map(({ story, leadPullRequest, pullRequests }) => {
												const relatedPullRequests = pullRequests.reduce<RelatedPullRequest[]>(
													(related, pullRequest) => {
														if (pullRequest.number !== leadPullRequest.number) {
															related.push({
																number: pullRequest.number,
																title: pullRequest.title,
																mergedAt: pullRequest.mergedAt,
																url: pullRequest.url,
																author: pullRequest.author,
																category: pullRequest.category,
															});
														}

														return related;
													},
													[],
												);
												const hasBreakingChange = pullRequests.some(
													(pullRequest) => pullRequest.category === "breaking",
												);
												const tags = [
													leadPullRequest.area.label,
													hasBreakingChange ? categoryLabels.breaking : categoryLabels[leadPullRequest.category],
													`${pullRequests.length} ${pullRequests.length === 1 ? "PR" : "PRs"}`,
												];

												return (
													<article key={story.key} className="relative">
														<div className="absolute -left-8 top-2 z-10 hidden size-3 -translate-x-1/2 rounded-full bg-primary md:block" />

														<div className="space-y-6">
															<div className="relative z-10 flex flex-col gap-2">
																<h2 className="text-balance text-2xl font-semibold tracking-tight">
																	{leadPullRequest.displayTitle}
																</h2>

																<div className="flex flex-wrap gap-2">
																	<a
																		href={leadPullRequest.url}
																		target="_blank"
																		rel="noreferrer"
																		className="changelog-source-badge flex h-6 w-fit items-center justify-center rounded-full border px-2 text-xs font-semibold transition-colors"
																	>
																		#{leadPullRequest.number}
																	</a>
																	{tags.map((tag) => (
																		<span
																			key={tag}
																			className="flex h-6 w-fit items-center justify-center rounded-full border bg-muted px-2 text-xs font-medium text-muted-foreground"
																		>
																			{tag}
																		</span>
																	))}
																</div>
															</div>

															<div className="prose max-w-none text-balance tracking-tight dark:prose-invert prose-a:no-underline prose-headings:scroll-mt-8 prose-headings:text-balance prose-headings:font-semibold prose-headings:tracking-tight prose-p:text-balance prose-p:tracking-tight">
																{leadPullRequest.bodySummary.map((paragraph) => (
																	<p key={paragraph}>{paragraph}</p>
																))}

																<p className="text-sm text-muted-foreground">
																	<a
																		href={leadPullRequest.url}
																		target="_blank"
																		rel="noreferrer"
																		className="group inline-flex items-center gap-1 font-medium text-foreground"
																	>
																		<span>View primary PR #{leadPullRequest.number}</span>
																		<ExternalArrow />
																	</a>
																	<span>
																		{" "}
																		· @{leadPullRequest.author} · {leadPullRequest.changedFiles}{" "}
																		{leadPullRequest.changedFiles === 1 ? "file" : "files"} changed
																	</span>
																</p>

																{relatedPullRequests.length > 0 && (
																	<ChangelogDetails
																		pullRequests={relatedPullRequests}
																		areaLabel={leadPullRequest.area.label}
																	/>
																)}
															</div>
														</div>
													</article>
												);
											})}

											{dateGroup.firstCommit && (
												<article className="relative">
													<div className="absolute -left-8 top-2 z-10 hidden size-3 -translate-x-1/2 rounded-full bg-primary md:block" />

													<div className="space-y-6">
														<div className="relative z-10 flex flex-col gap-2">
															<h2 className="text-balance text-2xl font-semibold tracking-tight">Hello, world.</h2>

															<div className="flex flex-wrap gap-2">
																<a
																	href={dateGroup.firstCommit.url}
																	target="_blank"
																	rel="noreferrer"
																	className="changelog-source-badge flex h-6 w-fit items-center justify-center rounded-full border px-2 font-mono text-xs font-semibold transition-colors"
																>
																	{dateGroup.firstCommit.hash.slice(0, 7)}
																</a>
																<span className="flex h-6 w-fit items-center justify-center rounded-full border bg-muted px-2 text-xs font-medium text-muted-foreground">
																	First commit
																</span>
																<span className="flex h-6 w-fit items-center justify-center rounded-full border bg-muted px-2 text-xs font-medium text-muted-foreground">
																	Repository origin
																</span>
															</div>
														</div>

														<div className="prose max-w-none text-balance tracking-tight dark:prose-invert prose-a:no-underline prose-p:text-balance prose-p:tracking-tight">
															<p>{dateGroup.firstCommit.subject.replace(/^\w+(?:\([^)]*\))?:\s*/i, "")}</p>
															<p className="text-sm text-muted-foreground">
																<a
																	href={dateGroup.firstCommit.url}
																	target="_blank"
																	rel="noreferrer"
																	className="group inline-flex items-center gap-1 font-medium text-foreground"
																>
																	<span>View first commit {dateGroup.firstCommit.hash.slice(0, 7)}</span>
																	<ExternalArrow />
																</a>
																<span> · {dateGroup.firstCommit.authorName}</span>
															</p>
														</div>
													</div>
												</article>
											)}
										</div>
									</div>
								</div>
							</section>
						);
					})}
				</div>

				<ChangelogPagination currentPage={page} totalPages={totalChangelogPages} />
			</main>
		</div>
	);
}
