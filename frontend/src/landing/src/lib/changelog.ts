import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { type ChangelogEntry, slugify } from "./changelog-utils";
import { normalizeContentDate } from "./content-utils";

export {
	type ChangelogEntry,
	formatChangelogDate,
	slugify,
} from "./changelog-utils";

const CHANGELOG_DIR = path.join(process.cwd(), "content/changelog");

// Releases are pulled from GitHub so the changelog updates itself on each build
// (the landing redeploys on push to main + a daily schedule). Curated MDX
// entries in content/changelog still take precedence for the same version.
const RELEASES_REPO = "AgentWrapper/agent-orchestrator";
// Only stable vMAJOR.MINOR.PATCH tags — skips nightlies, per-PR prereleases,
// and package tags like @composio/ao@x.
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

interface GithubRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	published_at: string;
	draft: boolean;
	prerelease: boolean;
}

function parseFrontmatter(filePath: string): ChangelogEntry | null {
	try {
		const fileContent = fs.readFileSync(filePath, "utf-8");
		const { data, content } = matter(fileContent);

		const slug = path.basename(filePath, ".mdx");
		const dateValue = normalizeContentDate(data.date) as string;

		return {
			slug,
			url: `/changelog/${slug}`,
			title: data.title ?? "Untitled",
			description: data.description,
			date: dateValue,
			image: data.image,
			content,
			draft: data.draft === true,
		};
	} catch {
		return null;
	}
}

function getMdxEntries(): ChangelogEntry[] {
	if (!fs.existsSync(CHANGELOG_DIR)) {
		return [];
	}

	const files = fs.readdirSync(CHANGELOG_DIR).filter((f) => f.endsWith(".mdx"));

	return files
		.map((file) => parseFrontmatter(path.join(CHANGELOG_DIR, file)))
		.filter((entry): entry is ChangelogEntry => entry !== null && !entry.draft);
}

// Release bodies are plain GitHub markdown, not MDX. Escape the constructs MDX
// would otherwise try to evaluate (JSX tags, {expressions}) everywhere except
// code spans, so an arbitrary release body can never break the build.
function sanitizeMdx(markdown: string): string {
	return markdown
		.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
		.map((segment, i) => (i % 2 === 1 ? segment : segment.replace(/[<{}]/g, (c) => `\\${c}`)))
		.join("");
}

async function getReleaseEntries(): Promise<ChangelogEntry[]> {
	try {
		const token = process.env.GITHUB_TOKEN;
		const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`, {
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			// Baked in at build for the static export; the redeploy is the refresh.
			next: { revalidate: 3600 },
		});
		if (!res.ok) {
			return [];
		}
		const releases = (await res.json()) as GithubRelease[];
		return releases
			.filter(
				(r) => !r.draft && !r.prerelease && STABLE_TAG.test(r.tag_name) && (r.body ?? "").trim().length > 0,
			)
			.map((r) => {
				const slug = slugify(r.tag_name);
				return {
					slug,
					url: `/changelog/${slug}`,
					title: r.name?.trim() || r.tag_name,
					date: normalizeContentDate(r.published_at) as string,
					content: sanitizeMdx(r.body ?? ""),
					draft: false,
				} satisfies ChangelogEntry;
			});
	} catch {
		return [];
	}
}

// The X.Y.Z inside a title/slug, used to dedupe a curated entry against its
// eventual GitHub release.
function versionKey(entry: ChangelogEntry): string | null {
	const match = `${entry.title} ${entry.slug}`.match(/(\d+)\.(\d+)\.(\d+)/);
	return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export async function getChangelogEntries(): Promise<ChangelogEntry[]> {
	const mdx = getMdxEntries();
	const releases = await getReleaseEntries();
	const curatedVersions = new Set(mdx.map(versionKey).filter((v): v is string => v !== null));

	const merged = [
		...mdx,
		...releases.filter((r) => {
			const v = versionKey(r);
			return v === null || !curatedVersions.has(v);
		}),
	];

	return merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function getChangelogEntry(slug: string): Promise<ChangelogEntry | undefined> {
	const entries = await getChangelogEntries();
	return entries.find((entry) => entry.slug === slug);
}

export async function getAllChangelogSlugs(): Promise<string[]> {
	const entries = await getChangelogEntries();
	return entries.map((entry) => entry.slug);
}

export function extractToc(
	content: string,
): { id: string; text: string; level: number }[] {
	const headingRegex = /^(#{2,3})\s+(.+)$/gm;
	const toc: { id: string; text: string; level: number }[] = [];

	for (const match of content.matchAll(headingRegex)) {
		const hashes = match[1];
		const heading = match[2];
		if (!hashes || !heading) continue;

		const level = hashes.length;
		const text = heading.trim();
		const id = slugify(text);

		toc.push({ id, text, level });
	}

	return toc;
}
