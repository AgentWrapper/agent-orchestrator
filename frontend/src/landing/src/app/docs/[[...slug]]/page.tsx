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
    title: `${doc.title} · Docs`,
    description: doc.description,
    alternates: { canonical: doc.url },
    openGraph: {
      title: `${doc.title} | Agent Orchestrator Docs`,
      description: doc.description,
      url: doc.url,
      images: ["/og-image.png"],
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
    <main className="min-h-screen bg-background">
      <header>
        <div className="mx-auto max-w-7xl px-6 xl:pl-[18rem] 2xl:pl-[19rem]">
          <div className="max-w-3xl pt-16 pb-10 md:pt-20 md:pb-12">
            <p className="text-sm text-muted-foreground">Documentation</p>
            <h1
              data-doc-title
              className="mt-4 text-balance text-3xl font-medium tracking-[-0.5px] text-foreground md:text-4xl"
            >
              {doc.title}
            </h1>
            {doc.description ? (
              <p data-doc-description className="mt-3 max-w-2xl text-pretty text-muted-foreground">
                {doc.description}
              </p>
            ) : (
              <p data-doc-description className="mt-3 max-w-2xl text-pretty text-muted-foreground">
                Product docs for running, extending, and operating Agent Orchestrator.
              </p>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 pb-16 xl:pl-[18rem] 2xl:pl-[19rem]">
        <aside className="hidden xl:block">
          <div className="scrollbar-hide fixed top-20 bottom-6 w-56 overflow-y-auto pr-6 left-[max(1rem,calc((100vw-80rem)/2+1.125rem))]">
            <DocsSidebar nav={nav} />
          </div>
        </aside>

        <div className="flex gap-10">
          <article
            data-doc-content
            className="prose prose-invert min-w-0 max-w-3xl flex-1 pt-10 pb-4 text-foreground prose-headings:text-balance prose-headings:font-medium prose-headings:tracking-[-0.5px] prose-headings:text-foreground prose-h1:mt-0 prose-h1:text-3xl prose-h1:mb-2 prose-h2:mt-10 prose-h2:text-2xl prose-h2:pb-0 prose-h3:mt-7 prose-h3:text-xl prose-p:text-pretty prose-p:text-muted-foreground prose-p:leading-relaxed prose-li:text-muted-foreground prose-ul:text-muted-foreground prose-ol:text-muted-foreground prose-blockquote:text-muted-foreground prose-strong:text-foreground prose-a:text-foreground prose-a:decoration-border prose-a:underline prose-a:underline-offset-4 hover:prose-a:text-foreground prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-muted/35 prose-hr:my-8 prose-hr:border-border prose-th:text-foreground prose-td:text-muted-foreground"
          >
            <MDXRemote
              source={doc.content}
              components={docsMdxComponents}
              options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
            />
          </article>

          <DocsToc toc={toc} />
        </div>
      </div>
    </main>
  );
}
