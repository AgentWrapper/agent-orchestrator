import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      valueToExport: ["structuredData"],
    },
  },
});

export default defineConfig({
  // Skip tableCell so search snippets are actual sentences, not table cells
  // like "Flag" / "Default" / "Purpose". Paragraphs + headings only.
  mdxOptions: {
    remarkStructureOptions: {
      types: ["paragraph", "blockquote", "heading"],
    },
  },
});
