import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { NodeHtmlMarkdown } from "node-html-markdown";

async function findIndexHtmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findIndexHtmlFiles(entryPath)));
    else if (entry.name === "index.html") files.push(entryPath);
  }
  return files;
}

const htmlFiles = await findIndexHtmlFiles("out/docs");

if (htmlFiles.length === 0) throw new Error("No documentation HTML files found");

for (const htmlFile of htmlFiles) {
  const $ = load(await readFile(htmlFile, "utf8"));
  const title = $("[data-doc-title]").first().text().trim();
  const description = $("[data-doc-description]").first().text().trim();
  const article = $("[data-doc-content]").first().html();

  if (!title || !description || !article) throw new Error(`Missing documentation content in ${htmlFile}`);

  const body = NodeHtmlMarkdown.translate(article);
  await writeFile(`${htmlFile}.md`, `# ${title}\n\n${description}\n\n${body}\n`, "utf8");
}

console.log(`Generated ${htmlFiles.length} documentation Markdown twins`);
