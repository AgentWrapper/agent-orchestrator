import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GridCross } from "@/app/blog/components/GridCross";
import { getAllChangelogSlugs, getChangelogEntry } from "@/lib/changelog";
import { ChangelogEntry } from "../components/ChangelogEntry";

// Static export needs every entry enumerated at build time.
export async function generateStaticParams() {
  return (await getAllChangelogSlugs()).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = await getChangelogEntry(slug);
  if (!entry) {
    return { title: "Changelog" };
  }
  return {
    title: entry.title,
    description: entry.description,
    alternates: { canonical: entry.url },
    openGraph: {
      title: `${entry.title} | Agent Orchestrator`,
      description: entry.description,
      url: entry.url,
      images: ["/og-image.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: `${entry.title} | Agent Orchestrator`,
      description: entry.description,
      images: ["/og-image.png"],
    },
  };
}

export default async function ChangelogEntryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = await getChangelogEntry(slug);
  if (!entry) {
    notFound();
  }

  return (
    <main className="relative min-h-screen">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(to right, transparent 0%, transparent calc(50% - 384px), rgba(255,255,255,0.06) calc(50% - 384px), rgba(255,255,255,0.06) calc(50% - 383px), transparent calc(50% - 383px), transparent calc(50% + 383px), rgba(255,255,255,0.06) calc(50% + 383px), rgba(255,255,255,0.06) calc(50% + 384px), transparent calc(50% + 384px))
          `,
        }}
      />

      <header className="relative border-b border-border">
        <div className="max-w-3xl mx-auto px-6 pt-16 pb-10 md:pt-20 md:pb-12 relative">
          <GridCross className="top-0 left-0" />
          <GridCross className="top-0 right-0" />

          <Link
            href="/changelog"
            className="inline-flex items-center gap-1.5 text-sm font-mono text-muted-foreground hover:text-foreground transition-colors tracking-[0.5px]"
          >
            <ArrowLeft className="size-4" />
            Changelog
          </Link>

          <GridCross className="bottom-0 left-0" />
          <GridCross className="bottom-0 right-0" />
        </div>
      </header>

      <div className="relative max-w-3xl mx-auto px-6 py-16">
        <ChangelogEntry entry={entry} />
      </div>
    </main>
  );
}
