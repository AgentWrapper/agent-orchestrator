import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: "raw-markdown",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith(".md")) {
          return null;
        }

        return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
      },
    },
  ],
  test: {
    alias: {
      // Integration tests import real plugins. These aliases resolve
      // package names to source files so we don't need circular devDeps
      // (plugins depend on core, core can't depend on plugins).
      "@aoagents/ao-plugin-tracker-github": resolve(
        __dirname,
        "../plugins/tracker-github/src/index.ts",
      ),
      "@aoagents/ao-plugin-scm-github": resolve(__dirname, "../plugins/scm-github/src/index.ts"),
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts", "src/recovery/index.ts"],
    },
  },
});
