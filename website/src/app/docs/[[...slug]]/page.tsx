import { notFound } from "next/navigation";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
import type { Metadata } from "next";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/components/docs/mdx-components";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function DocsSlugPage({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      tableOfContent={{
        style: "clerk",
        single: false,
      }}
      editOnGithub={{
        owner: "ComposioHQ",
        repo: "agent-orchestrator",
        sha: "main",
        path: `website/content/docs/${page.file?.path ?? ""}`,
      }}
      breadcrumb={{
        enabled: true,
        includePage: true,
      }}
      footer={{
        enabled: true,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    return {
      title: "Docs page not found",
      description: "This docs page moved or does not exist.",
      robots: {
        index: false,
        follow: true,
      },
    };
  }

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: `https://aoagents.dev${page.url}`,
    },
    openGraph: {
      title: page.data.title,
      description: page.data.description,
    },
  };
}
