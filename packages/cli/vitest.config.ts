import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

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
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 10000,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 8,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
    },
  },
  resolve: {
    alias: [
      {
        find: "@aoagents/ao-core/scm-webhook-utils",
        replacement: resolve(__dirname, "../core/src/scm-webhook-utils.ts"),
      },
      {
        find: "@aoagents/ao-core/types",
        replacement: resolve(__dirname, "../core/src/types.ts"),
      },
      {
        find: "@aoagents/ao-core",
        replacement: resolve(__dirname, "../core/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-claude-code",
        replacement: resolve(__dirname, "../plugins/agent-claude-code/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-codex",
        replacement: resolve(__dirname, "../plugins/agent-codex/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-aider",
        replacement: resolve(__dirname, "../plugins/agent-aider/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-opencode",
        replacement: resolve(__dirname, "../plugins/agent-opencode/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-agent-cursor",
        replacement: resolve(__dirname, "../plugins/agent-cursor/src/index.ts"),
      },
      {
        find: "@aoagents/ao-plugin-scm-github",
        replacement: resolve(__dirname, "../plugins/scm-github/src/index.ts"),
      },
    ],
  },
});
