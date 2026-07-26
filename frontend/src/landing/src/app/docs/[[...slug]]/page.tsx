import type { Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import { notFound } from "next/navigation";
import remarkGfm from "remark-gfm";
import { docsMdxComponents } from "../components/mdx";
import { DocsSidebar } from "../components/DocsSidebar";
import { DocsToc } from "../components/DocsToc";
import { extractToc, getAllDocSlugs, getDocPage, getDocsNav } from "@/lib/docs";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDocPage(slug ?? []);
  if (!doc) return { title: "Docs" };
  return {
    title: `${doc.title} | Agent Orchestrator Docs`,
    description: doc.description,
    alternates: { canonical: doc.url },
    openGraph: {
      title: `${doc.title} | Agent Orchestrator Docs`,
      description: doc.description,
      url: doc.url,
      images: ["/opengraph-image"],
    },
  };
}

export default async function DocsPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const doc = getDocPage(slug ?? []);
  if (!doc) notFound();

  const nav = getDocsNav();
  const toc = extractToc(doc.content);

  return (
    <div className="mx-auto flex max-w-7xl gap-8 px-6">
      {/* Left sidebar */}
      <aside className="scrollbar-hide sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto border-r border-border py-8 pr-2 lg:block">
        <DocsSidebar nav={nav} />
      </aside>

      {/* Content */}
      <article className="prose prose-invert min-w-0 max-w-none flex-1 pt-8 pb-16 prose-headings:font-medium prose-headings:tracking-[-0.5px] prose-h1:mt-0 prose-h1:text-3xl prose-h1:mb-2 prose-h2:mt-10 prose-h2:text-xl prose-h2:border-b prose-h2:border-border prose-h2:pb-2 prose-h3:mt-6 prose-h3:text-lg prose-p:text-muted-foreground prose-p:leading-relaxed prose-li:text-muted-foreground prose-strong:text-foreground prose-a:text-foreground prose-a:underline prose-a:underline-offset-4 hover:prose-a:text-muted-foreground prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-hr:border-border">
        <h1 className="!mt-0">{doc.title}</h1>
        {doc.description && <p className="!mt-0 text-lg text-muted-foreground">{doc.description}</p>}
        <MDXRemote
          source={doc.content}
          components={docsMdxComponents}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
        />
      </article>

      {/* Right TOC — scroll-spy highlights the current section */}
      <DocsToc toc={toc} />
    </div>
  );
}
