import type { MetadataRoute } from "next";

export const dynamic = "force-static";
import { source } from "@/lib/source";

const siteUrl = "https://aoagents.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const docsPages = source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  return [
    { url: `${siteUrl}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1.0 },
    { url: `${siteUrl}/docs`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    ...docsPages,
  ];
}
