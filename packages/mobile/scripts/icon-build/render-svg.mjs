// Rasterize assets/ao-logo.svg at high resolution using the Chromium bundled with
// frontend's playwright. Chromium renders the traced logo's overlapping fills
// faithfully; cairosvg is not an option (no libcairo on macOS by default).
//
// The import deliberately reaches across into frontend/node_modules instead of
// adding playwright to packages/mobile: this script runs by hand a few times a
// year, and a second Chromium download is ~150MB for every mobile dev who will
// never run it. The cost is that `npm install --prefix frontend` is a hard
// prerequisite -- generate-icons.sh checks for it up front.
import { chromium } from '../../../../frontend/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const svgPath = path.join(repoRoot, 'assets', 'ao-logo.svg');
const svg = fs.readFileSync(svgPath, 'utf8');
const out = process.argv[2];
const width = Number(process.argv[3] ?? 4096);

// Derive the aspect ratio from the viewBox rather than assuming it. The source
// has been re-framed before (#3266 tightened it from "150 80 870 760" to a square
// "170.86 91.03 737.23 737.23"), and a hardcoded ratio silently squashes the
// artwork instead of failing. compose.py re-crops to the content bounding box, so
// only the aspect ratio matters here -- but it has to be right.
const viewBox = svg.match(/viewBox="([\d.\s-]+)"/);
if (!viewBox) throw new Error(`no viewBox in ${svgPath}`);
const [, , vbWidth, vbHeight] = viewBox[1].trim().split(/\s+/).map(Number);
if (!(vbWidth > 0 && vbHeight > 0)) {
  throw new Error(`bad viewBox "${viewBox[1]}" in ${svgPath}`);
}
const height = Math.round((width * vbHeight) / vbWidth);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 1,
});
await page.setContent(
  `<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>` +
    svg.replace(/<\?xml[^>]*\?>/, ''),
);
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`rendered ${out} @ ${width}x${height}`);
