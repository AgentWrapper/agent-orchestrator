import changelogData from "@/data/changelog.json";

export const DATE_GROUPS_PER_PAGE = 5;

const dateKeys = new Set(changelogData.stories.map((story) => story.date.slice(0, 10)));
dateKeys.add(changelogData.firstCommit.authoredAt.slice(0, 10));

export const totalChangelogPages = Math.max(1, Math.ceil(dateKeys.size / DATE_GROUPS_PER_PAGE));
