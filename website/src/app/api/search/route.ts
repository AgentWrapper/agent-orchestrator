import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, {
  search: {
    threshold: 0,
    tolerance: 0,
  },
  buildIndex(page) {
    return {
      title: page.data.title,
      description: page.data.description ?? "",
      url: page.url,
      id: page.url,
      structuredData: page.data.structuredData ?? {
        headings: [],
        contents: [],
      },
    };
  },
});