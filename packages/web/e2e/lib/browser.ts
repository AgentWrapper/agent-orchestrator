import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

interface ScreenshotOptions {
  width?: number;
  height?: number;
}

interface PageSpec {
  path: string;
  name: string;
}

function pathToName(path: string): string {
  if (path === "/") return "dashboard";
  return path.replace(/^\//, "").replace(/\//g, "-");
}

const DEFAULT_PAGES: PageSpec[] = [
  { path: "/", name: "dashboard" },
  { path: "/sessions/backend-3", name: "session-detail" },
];

export async function captureScreenshots(
  baseUrl: string,
  extraPaths: string[],
  options: ScreenshotOptions = {},
): Promise<string[]> {
  const { width = 1280, height = 900 } = options;

  const screenshotDir = join(new URL("../../", import.meta.url).pathname, "screenshots");
  await mkdir(screenshotDir, { recursive: true });

  const pages: PageSpec[] =
    extraPaths.length > 0
      ? extraPaths.map((p) => ({ path: p, name: pathToName(p) }))
      : DEFAULT_PAGES;

  const browser = await chromium.launch({ headless: true });
  const savedPaths: string[] = [];

  try {
    // Theme is controllable for design QA; defaults to dark (the app's
    // defaultTheme). SHOT_SCHEME=light captures the secondary theme.
    const scheme = process.env.SHOT_SCHEME === "light" ? "light" : "dark";
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    await context.addInitScript((s) => {
      try {
        localStorage.setItem("theme", s);
      } catch {
        /* ignore */
      }
    }, scheme);
    const page = await context.newPage();

    for (const spec of pages) {
      const url = `${baseUrl}${spec.path}`;
      console.log(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: "networkidle" });
      // Extra delay for React hydration
      await page.waitForTimeout(1000);

      const filePath = join(screenshotDir, `${spec.name}.png`);
      await page.screenshot({ path: filePath, fullPage: true });
      savedPaths.push(filePath);
      console.log(`Saved ${filePath}`);
    }
  } finally {
    await browser.close();
  }

  return savedPaths;
}
