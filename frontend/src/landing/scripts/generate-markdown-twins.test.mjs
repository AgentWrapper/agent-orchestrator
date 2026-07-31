import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(new URL("./generate-markdown-twins.mjs", import.meta.url));

async function createWorkspace(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), "ao-markdown-twins-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
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

test("generates Markdown with every tab panel and without tab controls", async (t) => {
  const workspace = await createWorkspace(t);
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

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const markdown = await readFile(`${htmlPath}.md`, "utf8");
  assert.match(markdown, /^# Installation\n\nInstall AO on your platform\./);
  assert.match(markdown, /\*\*Claude Code\*\*[\s\S]*Run Claude Code\./);
  assert.match(markdown, /\*\*Codex\*\*[\s\S]*Run Codex\./);
  assert.doesNotMatch(markdown, /Tab controls only/);
});

test("rejects documentation with missing required content", async (t) => {
  const cases = [
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
  ];

  for (const fixture of cases) {
    await t.test(`missing ${fixture.name}`, async (t) => {
      const workspace = await createWorkspace(t);
      const htmlPath = await writeDoc(workspace, fixture.name, fixture.html);

      const result = runGenerator(workspace);

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /Missing documentation content/);
      await assert.rejects(readFile(`${htmlPath}.md`, "utf8"), { code: "ENOENT" });
    });
  }
});

test("rejects an empty documentation tree", async (t) => {
  const workspace = await createWorkspace(t);

  const result = runGenerator(workspace);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /No documentation HTML files found/);
});
