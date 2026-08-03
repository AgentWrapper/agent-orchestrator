// @vitest-environment node
import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(new URL("./generate-markdown-twins.mjs", import.meta.url));
const workspaces = new Set();

afterEach(async () => {
  await Promise.all([...workspaces].map((workspace) => rm(workspace, { recursive: true, force: true })));
  workspaces.clear();
});

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "ao-markdown-twins-"));
  workspaces.add(workspace);
  await mkdir(path.join(workspace, "out", "docs"), { recursive: true });
  return workspace;
}

async function writeDoc(workspace, slug, html) {
  const directory = path.join(workspace, "out", "docs", slug);
  await mkdir(directory, { recursive: true });
  const htmlPath = path.join(directory, "index.html");
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

function runGenerator(workspace) {
  return spawnSync(process.execPath, [generatorPath], { cwd: workspace, encoding: "utf8" });
}

test("generates Markdown with every tab panel and without tab controls", async () => {
  const workspace = await createWorkspace();
  const htmlPath = await writeDoc(
    workspace,
    "installation",
    `
      <h1 data-doc-title>Installation</h1>
      <p data-doc-description>Install AO on your platform.</p>
      <article data-doc-content>
        <div data-doc-tab-list><button>Tab controls only</button></div>
        <section data-doc-tab-panel data-doc-tab-label="Claude Code">
          <p>Run Claude Code.</p>
        </section>
        <section data-doc-tab-panel data-doc-tab-label="Codex" hidden>
          <p>Run Codex.</p>
        </section>
      </article>
    `,
  );

  const result = runGenerator(workspace);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const markdown = await readFile(`${htmlPath}.md`, "utf8");
  expect(markdown).toMatch(/^# Installation\n\nInstall AO on your platform\./);
  expect(markdown).toMatch(/\*\*Claude Code\*\*[\s\S]*Run Claude Code\./);
  expect(markdown).toMatch(/\*\*Codex\*\*[\s\S]*Run Codex\./);
  expect(markdown).not.toMatch(/Tab controls only/);
});

test.each([
  {
    name: "title",
    html: '<p data-doc-description>Description</p><article data-doc-content><p>Body</p></article>',
  },
  {
    name: "description",
    html: '<h1 data-doc-title>Title</h1><article data-doc-content><p>Body</p></article>',
  },
  {
    name: "article",
    html: '<h1 data-doc-title>Title</h1><p data-doc-description>Description</p>',
  },
])("rejects documentation with missing $name", async ({ name, html }) => {
  const workspace = await createWorkspace();
  const htmlPath = await writeDoc(workspace, name, html);

  const result = runGenerator(workspace);

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/Missing documentation content/);
  await expect(readFile(`${htmlPath}.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects an empty documentation tree", async () => {
  const workspace = await createWorkspace();

  const result = runGenerator(workspace);

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/No documentation HTML files found/);
});
