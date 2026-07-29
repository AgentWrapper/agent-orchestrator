import remarkGfm from "remark-gfm";
import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "../landing/content/docs",
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkGfm],
  },
});
