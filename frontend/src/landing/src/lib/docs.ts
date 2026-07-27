import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { slugify } from "./content-utils";

const DOCS_DIR = path.join(process.cwd(), "content/docs");

export interface DocPage {
	/** URL path segments after /docs, e.g. ["guides", "review-loop"] (root index = []). */
	slug: string[];
	url: string;
	title: string;
	description?: string;
	content: string;
}

export interface DocsNavItem {
	title: string;
	/** A section label ("Getting Started") has no url and no children. */
	separator?: boolean;
	url?: string;
	items?: DocsNavItem[];
}

export interface TocItem {
	id: string;
	text: string;
	level: number;
}

function readMeta(dir: string): { title?: string; pages?: string[] } {
	const file = path.join(dir, "meta.json");
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
}

/** Resolve a slug array to its .mdx file: dir/index.mdx for a section, dir/name.mdx for a leaf. */
function resolveFile(slug: string[]): string | null {
	const base = path.join(DOCS_DIR, ...slug);
	const asFile = `${base}.mdx`;
	if (slug.length > 0 && fs.existsSync(asFile)) return asFile;
	const asIndex = path.join(base, "index.mdx");
	if (fs.existsSync(asIndex)) return asIndex;
	return null;
}

export function getDocPage(slug: string[]): DocPage | undefined {
	const file = resolveFile(slug);
	if (!file) return undefined;
	try {
		const { data, content } = matter(fs.readFileSync(file, "utf-8"));
		return {
			slug,
			url: `/docs${slug.length ? `/${slug.join("/")}` : ""}`,
			title: data.title ?? "Untitled",
			description: data.description,
			content,
		};
	} catch {
		return undefined;
	}
}

/** Every doc path for generateStaticParams (each slug array, including [] for the index). */
export function getAllDocSlugs(): string[][] {
	const slugs: string[][] = [];
	const walk = (dir: string, prefix: string[]) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), [...prefix, entry.name]);
			} else if (entry.name.endsWith(".mdx")) {
				if (entry.name === "index.mdx") slugs.push(prefix);
				else slugs.push([...prefix, entry.name.replace(/\.mdx$/, "")]);
			}
		}
	};
	if (fs.existsSync(DOCS_DIR)) walk(DOCS_DIR, []);
	return slugs;
}

function titleFor(slug: string[], fallback: string): string {
	return getDocPage(slug)?.title ?? fallback;
}

function humanize(name: string): string {
	return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build one nav node for a page entry (a leaf .mdx or a subsection directory). */
function navNode(dir: string, prefix: string[], name: string): DocsNavItem {
	const childDir = path.join(dir, name);
	// A directory entry: recurse using its own meta.json.
	if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
		const meta = readMeta(childDir);
		const slug = [...prefix, name];
		return {
			title: meta.title ?? titleFor(slug, humanize(name)),
			url: fs.existsSync(path.join(childDir, "index.mdx")) ? `/docs/${slug.join("/")}` : undefined,
			items: buildItems(childDir, slug, meta.pages),
		};
	}
	// A leaf page.
	const slug = [...prefix, name];
	return { title: titleFor(slug, humanize(name)), url: `/docs/${slug.join("/")}` };
}

function buildItems(dir: string, prefix: string[], pages?: string[]): DocsNavItem[] {
	const order =
		pages ??
		fs
			.readdirSync(dir, { withFileTypes: true })
			.map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.mdx$/, "")))
			.filter((n) => n !== "index" && n !== "meta.json");
	const items: DocsNavItem[] = [];
	for (const entry of order) {
		const sep = entry.match(/^---(.+)---$/);
		if (sep) {
			items.push({ title: sep[1].trim(), separator: true });
			continue;
		}
		if (entry === "index") continue;
		items.push(navNode(dir, prefix, entry));
	}
	return items;
}

/** The full sidebar tree, driven by content/docs/meta.json. */
export function getDocsNav(): DocsNavItem[] {
	if (!fs.existsSync(DOCS_DIR)) return [];
	const meta = readMeta(DOCS_DIR);
	return buildItems(DOCS_DIR, [], meta.pages);
}

/** Flat list of every linkable page in nav order — used for prev/next. */
export function flattenNav(items: DocsNavItem[] = getDocsNav()): { title: string; url: string }[] {
	const out: { title: string; url: string }[] = [];
	const walk = (list: DocsNavItem[]) => {
		for (const item of list) {
			if (item.url) out.push({ title: item.title, url: item.url });
			if (item.items) walk(item.items);
		}
	};
	walk(items);
	return out;
}

/** Headings (h2/h3) for the right-hand table of contents. */
export function extractToc(content: string): TocItem[] {
	const toc: TocItem[] = [];
	let inFence = false;
	for (const line of content.split("\n")) {
		if (/^```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
		if (m) toc.push({ id: slugify(m[2]), text: m[2], level: m[1].length });
	}
	return toc;
}
