import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "AgentWrapper/agent-orchestrator";
const targetStoryCount = 72;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDirectory, "../data/changelog.json");
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const ghExecutable = process.platform === "win32" ? "gh.exe" : "gh";
const gitExecutable = process.platform === "win32" ? "git.exe" : "git";

const areaDefinitions = [
	{
		key: "browser",
		label: "Browser & previews",
		patterns: [/\bbrowser\b/i, /\bpreview\b/i, /\bannotation/i, /\bscreenshot/i, /\blocalhost\b/i],
	},
	{
		key: "mobile",
		label: "Mobile & remote",
		patterns: [
			/\bmobile\b/i,
			/\bremote\b/i,
			/\bandroid\b/i,
			/\bios\b/i,
			/react native/i,
			/\blan\b/i,
			/connect mobile/i,
			/supervisor app/i,
		],
	},
	{
		key: "desktop",
		label: "Desktop & updates",
		patterns: [
			/\bdesktop\b/i,
			/\belectron\b/i,
			/\btitlebar\b/i,
			/\bupdater\b/i,
			/\bauto-update\b/i,
			/\bapp update\b/i,
			/update channel/i,
			/\bwindow controls?\b/i,
		],
	},
	{
		key: "reviews",
		label: "Reviews & CI",
		patterns: [
			/\breview/i,
			/\breviewer/i,
			/\bci\b/i,
			/\bcheck runs?\b/i,
			/\bbugbot\b/i,
			/merge conflict/i,
			/pull request/i,
			/\bpr status/i,
		],
	},
	{
		key: "projects",
		label: "Projects & workspaces",
		patterns: [
			/\bprojects?\b/i,
			/\bworkspaces?\b/i,
			/\bworktrees?\b/i,
			/\brepositor/i,
			/\brepo import/i,
			/\bportfolio\b/i,
		],
	},
	{
		key: "sessions",
		label: "Sessions & lifecycle",
		patterns: [
			/\bsessions?\b/i,
			/\brestore/i,
			/\blifecycle\b/i,
			/\bterminal/i,
			/\bspawn/i,
			/\bactivity\b/i,
			/\bruntime\b/i,
			/\btmux\b/i,
			/\bprompt/i,
			/\borchestrat/i,
		],
	},
	{
		key: "agents",
		label: "Agents & plugins",
		patterns: [
			/\bagents?\b/i,
			/\bharness/i,
			/\bplugins?\b/i,
			/claude/i,
			/codex/i,
			/cursor/i,
			/opencode/i,
			/\bkimi\b/i,
			/\bgrok\b/i,
			/\bpi\b/i,
			/kilocode/i,
			/\bqwen\b/i,
			/gemini/i,
		],
	},
	{
		key: "integrations",
		label: "Integrations",
		patterns: [
			/\bnotifier/i,
			/\blinear\b/i,
			/\bgithub\b/i,
			/\bscm\b/i,
			/\btracker/i,
			/\bslack\b/i,
			/\bdiscord\b/i,
			/\bcomposio\b/i,
			/\bwebhooks?\b/i,
		],
	},
	{
		key: "cli",
		label: "CLI & configuration",
		patterns: [
			/\bcli\b/i,
			/\bcommands?\b/i,
			/\bconfig/i,
			/\bao start\b/i,
			/\bsettings?\b/i,
			/\binstall/i,
			/\bonboarding\b/i,
			/\bsetup\b/i,
		],
	},
	{
		key: "dashboard",
		label: "Dashboard & UX",
		patterns: [
			/\bdashboard\b/i,
			/\bui\b/i,
			/\bfrontend\b/i,
			/\bsidebar\b/i,
			/\bkanban\b/i,
			/\btheme\b/i,
			/\bdesign\b/i,
			/\blayout\b/i,
			/\btopbar\b/i,
			/\bbutton\b/i,
			/\bicon\b/i,
		],
	},
	{
		key: "docs",
		label: "Docs & website",
		patterns: [/\bdocs?\b/i, /documentation/i, /\blanding\b/i, /\bwebsite\b/i, /\breadme\b/i, /\bchangelog\b/i],
	},
	{
		key: "platform",
		label: "Platform & reliability",
		patterns: [
			/\bwindows?\b/i,
			/\bmacos\b/i,
			/\blinux\b/i,
			/\bsecurity\b/i,
			/\bdatabase\b/i,
			/\bsqlite\b/i,
			/\bapi\b/i,
			/\bserver\b/i,
			/\bperformance\b/i,
			/\breliab/i,
		],
	},
];

function runGh(args) {
	const output = execFileSync(ghExecutable, args, {
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});

	return JSON.parse(output);
}

function runGit(args) {
	return execFileSync(gitExecutable, args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

function readFirstCommit() {
	const rootHashes = runGit(["rev-list", "--max-parents=0", "origin/main"]).split(/\s+/).filter(Boolean);
	const commits = rootHashes.map((hash) => {
		const [fullHash, authoredAt, authorName, subject] = runGit([
			"show",
			"-s",
			"--format=%H%x1f%aI%x1f%an%x1f%s",
			hash,
		]).split("\u001f");

		return {
			hash: fullHash,
			authoredAt,
			authorName,
			subject,
			url: `https://github.com/${repository}/commit/${fullHash}`,
		};
	});

	return commits.sort((left, right) => left.authoredAt.localeCompare(right.authoredAt))[0];
}

function categorizePullRequest(title, body, labels) {
	const titleAndLabels = `${title} ${labels.join(" ")}`.toLowerCase();
	const hasBreakingHeading =
		/^#{1,3}\s*(?:⚠️\s*)?breaking(?:\s*\/\s*behavioral)?(?:\s+changes?|\s+visual change|\s+change)(?!s?\s*:\s*(?:none|no)\b)/im.test(
			body,
		);
	const removesPublicSurface =
		/^(?:\w+(?:\([^)]*\))?:\s*)?(remove|deprecat)\w*\b.*\b(command|flag|option|api|feature)\b/.test(titleAndLabels);

	if (
		/breaking[ -]change|\bbreaking\b|backward incompatible/.test(titleAndLabels) ||
		hasBreakingHeading ||
		removesPublicSurface
	)
		return "breaking";
	if (/^\(?feat(?:\(.+?\))?\)?:|\bfeature\b|\benhancement\b/.test(title.toLowerCase())) return "feature";
	if (/^fix(?:\(.+?\))?:|\bbug\b|\bhotfix\b|^revert\b/i.test(title)) return "fix";
	if (/^docs?(?:\(.+?\))?:|\breadme\b|\bdocumentation\b/i.test(title)) return "docs";
	return "maintenance";
}

function areaScore(definition, title, body) {
	return definition.patterns.reduce((score, pattern) => {
		const titleMatch = pattern.test(title);
		const bodyMatch = pattern.test(body.slice(0, 1200));
		return score + (titleMatch ? 5 : 0) + (bodyMatch ? 2 : 0);
	}, 0);
}

function detectArea(title, body) {
	if (/\b(mobile|android|ios|react native|expo|haptic)\b/i.test(`${title} ${body.slice(0, 800)}`)) {
		const mobileArea = areaDefinitions.find((definition) => definition.key === "mobile");
		return { key: mobileArea.key, label: mobileArea.label };
	}

	let bestArea = areaDefinitions.at(-1);
	let bestScore = 0;

	for (const definition of areaDefinitions) {
		const score = areaScore(definition, title, body);
		if (score > bestScore) {
			bestArea = definition;
			bestScore = score;
		}
	}

	return { key: bestArea.key, label: bestArea.label };
}

function importanceScore(pullRequest) {
	const text = `${pullRequest.title} ${pullRequest.labels.join(" ")}`.toLowerCase();
	const changedLines = pullRequest.additions + pullRequest.deletions;
	let score = 0;

	if (pullRequest.category === "breaking") score += 150;
	if (pullRequest.category === "feature") score += 70;
	if (pullRequest.category === "fix") score += 28;
	if (/security|critical|crash|data loss|vulnerability/.test(text)) score += 50;
	if (/rebuild|redesign|introduc|launch|support|workspace|desktop|windows|browser|mobile|overhaul/.test(text))
		score += 24;
	if (/major|highlight|priority|complete/.test(text)) score += 20;
	score += Math.min(42, Math.log10(changedLines + 1) * 11);
	score += Math.min(20, pullRequest.changedFiles * 0.75);
	if (/^test|^chore|^refactor|^style|^build|^ci/i.test(pullRequest.title)) score -= 24;
	if (pullRequest.category === "docs") score -= 20;

	return Math.round(score);
}

function cleanDisplayTitle(title) {
	const cleaned = title
		.replace(/^\((feat|fix|docs|chore|refactor|test|perf|build|ci)\):\s*/i, "")
		.replace(/^(feat|fix|docs|chore|refactor|test|perf|build|ci)(\([^)]*\))?:\s*/i, "")
		.trim();

	return cleaned ? `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}` : title;
}

function plainText(line) {
	return line
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^- \[[ xX]\]\s+/, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`>#]/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateAtWord(text, maximumLength = 240) {
	if (text.length <= maximumLength) return text;
	const truncated = text.slice(0, maximumLength + 1);
	const lastSpace = truncated.lastIndexOf(" ");
	return `${truncated.slice(0, lastSpace > maximumLength * 0.7 ? lastSpace : maximumLength).trim()}…`;
}

function extractBodySummary(body) {
	if (!body?.trim()) return [];

	const sanitized = body
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<details[\s\S]*?<\/details>/gi, "")
		.replace(/```[\s\S]*?```/g, "");
	const lines = sanitized.split(/\r?\n/);
	const summaryHeadingIndex = lines.findIndex((line) =>
		/^#{1,3}\s*(summary|overview|description|what changed|changes)\s*:?\s*$/i.test(line.trim()),
	);
	const candidates = [];

	for (let index = summaryHeadingIndex === -1 ? 0 : summaryHeadingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (
			/^#{1,3}\s*(test|testing|validation|verification|screenshots?|checklist|how to test|notes? for reviewers?)/i.test(
				line,
			)
		)
			break;
		if (/^#{1,3}\s+/.test(line)) {
			if (candidates.length > 0) break;
			continue;
		}
		if (!line || /^https?:\/\/\S+$/.test(line) || /^[-*+]\s*\[[ xX]\]/.test(line)) continue;

		const text = plainText(line);
		if (
			text.length < 18 ||
			/^(closes|fixes|resolves)\s+#\d+\.?$/i.test(text) ||
			/^(npm|pnpm|yarn|bun|npx|go test|cargo test|pytest)\b/i.test(text)
		)
			continue;
		candidates.push(truncateAtWord(text));
		if (candidates.length === 3) break;
	}

	return [...new Set(candidates)];
}

function tokenize(title) {
	const stopWords = new Set([
		"add",
		"adds",
		"added",
		"fix",
		"feat",
		"the",
		"and",
		"for",
		"with",
		"from",
		"into",
		"support",
		"update",
		"improve",
	]);
	return new Set(
		title
			.toLowerCase()
			.replace(/[^a-z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((word) => word.length > 2 && !stopWords.has(word)),
	);
}

function tokenOverlap(left, right) {
	const leftTokens = tokenize(left);
	const rightTokens = tokenize(right);
	let count = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) count += 1;
	}
	return count;
}

function daysBetween(left, right) {
	return Math.abs(new Date(left).getTime() - new Date(right).getTime()) / 86_400_000;
}

function allocateStoryCounts(groupedPullRequests, totalPullRequests) {
	const allocations = Array.from(groupedPullRequests, ([area, pullRequests]) => {
		const exact = (pullRequests.length / totalPullRequests) * targetStoryCount;
		return {
			area,
			count: Math.max(1, Math.floor(exact)),
			fraction: exact - Math.floor(exact),
		};
	});

	while (allocations.reduce((sum, allocation) => sum + allocation.count, 0) < targetStoryCount) {
		const next = [...allocations].sort(
			(left, right) =>
				right.fraction - left.fraction ||
				groupedPullRequests.get(right.area).length - groupedPullRequests.get(left.area).length,
		)[0];
		next.count += 1;
		next.fraction = -1;
	}

	while (allocations.reduce((sum, allocation) => sum + allocation.count, 0) > targetStoryCount) {
		const next = [...allocations]
			.filter((allocation) => allocation.count > 1)
			.sort((left, right) => left.fraction - right.fraction)[0];
		next.count -= 1;
	}

	return new Map(allocations.map((allocation) => [allocation.area, allocation.count]));
}

function selectAnchors(pullRequests, count) {
	const newestFirst = [...pullRequests].sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
	if (count >= newestFirst.length) return newestFirst;

	const highestImportance = [...newestFirst].sort((left, right) => right.importance - left.importance)[0];
	if (count === 1) return [highestImportance];

	const selected = [newestFirst[0]];
	if (count > 1 && highestImportance.number !== selected[0].number) selected.push(highestImportance);

	while (selected.length < count) {
		const selectedNumbers = new Set(selected.map((pullRequest) => pullRequest.number));
		const candidate = newestFirst
			.filter((pullRequest) => !selectedNumbers.has(pullRequest.number))
			.map((pullRequest) => {
				const distance = Math.min(...selected.map((anchor) => daysBetween(pullRequest.mergedAt, anchor.mergedAt)));
				return { pullRequest, score: pullRequest.importance + Math.min(70, distance * 2.4) };
			})
			.sort(
				(left, right) =>
					right.score - left.score || right.pullRequest.mergedAt.localeCompare(left.pullRequest.mergedAt),
			)[0].pullRequest;
		selected.push(candidate);
	}

	return selected;
}

function buildStories(pullRequests) {
	const groupedPullRequests = new Map();
	for (const pullRequest of pullRequests) {
		const existing = groupedPullRequests.get(pullRequest.area.key) ?? [];
		existing.push(pullRequest);
		groupedPullRequests.set(pullRequest.area.key, existing);
	}

	const allocations = allocateStoryCounts(groupedPullRequests, pullRequests.length);
	const stories = [];

	for (const [area, areaPullRequests] of groupedPullRequests) {
		const anchors = selectAnchors(areaPullRequests, allocations.get(area));
		const assignments = new Map(anchors.map((anchor) => [anchor.number, [anchor]]));
		const anchorNumbers = new Set(anchors.map((anchor) => anchor.number));

		for (const pullRequest of areaPullRequests) {
			if (anchorNumbers.has(pullRequest.number)) continue;
			const anchor = [...anchors]
				.map((candidate) => ({
					candidate,
					score:
						daysBetween(pullRequest.mergedAt, candidate.mergedAt) * 2 -
						tokenOverlap(pullRequest.title, candidate.title) * 18,
				}))
				.sort(
					(left, right) => left.score - right.score || right.candidate.importance - left.candidate.importance,
				)[0].candidate;
			assignments.get(anchor.number).push(pullRequest);
		}

		for (const anchor of anchors) {
			const assigned = assignments
				.get(anchor.number)
				.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
			stories.push({
				key: `pr-${anchor.number}`,
				leadPullRequestNumber: anchor.number,
				pullRequestNumbers: assigned.map((pullRequest) => pullRequest.number),
				date: assigned[0].mergedAt,
			});
		}
	}

	return stories.sort(
		(left, right) => right.date.localeCompare(left.date) || right.leadPullRequestNumber - left.leadPullRequestNumber,
	);
}

function auditStories(pullRequests, stories) {
	const sourceNumbers = new Set(pullRequests.map((pullRequest) => pullRequest.number));
	const representedNumbers = stories.flatMap((story) => story.pullRequestNumbers);
	const representedSet = new Set(representedNumbers);

	if (stories.length < 50 || stories.length > 80) {
		throw new Error(`Expected 50–80 product stories, found ${stories.length}.`);
	}
	if (representedNumbers.length !== representedSet.size) {
		throw new Error("A merged pull request appears in more than one changelog story.");
	}
	if (representedSet.size !== sourceNumbers.size) {
		const missing = [...sourceNumbers].filter((number) => !representedSet.has(number));
		throw new Error(`Changelog is missing ${missing.length} merged pull requests: ${missing.join(", ")}`);
	}
	for (const story of stories) {
		if (!story.pullRequestNumbers.includes(story.leadPullRequestNumber)) {
			throw new Error(`Story ${story.key} does not contain its lead pull request.`);
		}
	}
}

const rawPullRequests = runGh([
	"pr",
	"list",
	"--repo",
	repository,
	"--state",
	"merged",
	"--limit",
	"1000",
	"--json",
	"number,title,body,mergedAt,url,author,labels,additions,deletions,changedFiles",
]);

const pullRequests = rawPullRequests
	.map((pullRequest) => {
		const labels = pullRequest.labels.map((label) => label.name).filter(Boolean);
		const body = pullRequest.body ?? "";
		const category = categorizePullRequest(pullRequest.title, body, labels);
		const area = detectArea(pullRequest.title, body);
		const normalized = {
			number: pullRequest.number,
			title: pullRequest.title.trim(),
			displayTitle: cleanDisplayTitle(pullRequest.title),
			bodySummary: extractBodySummary(body),
			summarySource: body.trim() ? "pull-request-body" : "pull-request-title",
			mergedAt: pullRequest.mergedAt,
			url: pullRequest.url,
			author: pullRequest.author?.login ?? "unknown",
			labels,
			additions: pullRequest.additions,
			deletions: pullRequest.deletions,
			changedFiles: pullRequest.changedFiles,
			category,
			area,
		};

		return { ...normalized, importance: importanceScore(normalized) };
	})
	.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));

const stableReleases = runGh([
	"release",
	"list",
	"--repo",
	repository,
	"--limit",
	"100",
	"--json",
	"tagName,name,publishedAt,isPrerelease,isLatest",
])
	.filter((release) => !release.isPrerelease && /^v\d+\.\d+\.\d+$/.test(release.tagName))
	.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));

const stories = buildStories(pullRequests);
auditStories(pullRequests, stories);
const firstCommit = readFirstCommit();
const generatedAt = pullRequests[0]?.mergedAt ?? firstCommit.authoredAt;

const payload = {
	generatedAt,
	repository,
	sourceBranch: "main",
	methodology: {
		source: "Merged GitHub pull requests and the repository root commit",
		summarySource: "Pull request titles and body summaries",
		grouping: "Product area, title similarity, change significance, and merge chronology",
	},
	firstCommit,
	stableReleases,
	stories,
	pullRequests,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(
	`Wrote ${pullRequests.length} merged pull requests into ${stories.length} audited product stories at ${outputPath}`,
);
