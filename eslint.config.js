import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/dist-server/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/.source/**",
      "**/next-env.d.ts",
      "**/.next-dev/**",
      "**/coverage/**",
      ".ao/**",
      ".claude/**",
      ".context/**",
      ".cursor/**",
      ".expect/**",
      ".gstack/**",
      ".worktrees/**",
      "artifacts/**",
      "packages/web/next-env.d.ts",
      "packages/web/next.config.js",
      "packages/web/postcss.config.mjs",
      "test-clipboard*.mjs",
      "test-clipboard*.sh",
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript strict rules
  ...tseslint.configs.strict,

  // Prettier compat (disables formatting rules)
  eslintConfigPrettier,

  // Project-wide rules
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Security: prevent shell injection patterns
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Code quality
      "no-console": "warn",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-template-curly-in-string": "warn",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='createInterface'] Property[key.name='input'] > CallExpression[callee.name='createReadStream']",
          message:
            "Do not pass createReadStream() inline to createInterface(); keep the stream in a variable and close/destroy it in a finally block.",
        },
        {
          selector:
            "CallExpression[callee.name='createInterface'] Property[key.name='input'] > CallExpression[callee.property.name='createReadStream']",
          message:
            "Do not pass createReadStream() inline to createInterface(); keep the stream in a variable and close/destroy it in a finally block.",
        },
      ],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],

      // TypeScript
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-require-imports": "error",

      // C-04: enforce 400-line cap on component/source files (CLAUDE.md constraint)
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },

  // Relaxed rules for test files — fixtures legitimately grow large
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-lines": "off",
    },
  },

  // C-04 migration ratchet: existing offenders grandfathered in.
  // Each entry is a visible, auditable TODO — removing one is part of the
  // acceptance criteria for the matching split PR. New code must stay ≤400 lines.
  //
  // Web-package offenders are grandfathered in `packages/web/eslint.config.js`
  // instead of here. Flat config cascades: files under `packages/web/` are
  // linted via that config (not root), and `files` globs resolve relative to
  // the declaring config file — so web paths belong in the web config.
  //
  // Tracked by open split issues:
  //   packages/core/src/session-manager.ts              → #1415
  //   packages/core/src/lifecycle-manager.ts            → #1417
  //   packages/cli/src/commands/start.ts                → #1416
  //   packages/plugins/scm-github/src/index.ts          → #1418
  //   packages/plugins/scm-github/src/graphql-batch.ts  → #1418
  //   (web: SessionDetail.tsx → #770, DirectTerminal.tsx → #769 — see web config)
  //
  // Remaining offenders (no split issue yet — good candidates for future refactors):
  //   packages/core/src/{types,config,global-config,agent-report,observability,lifecycle-state}.ts
  //   packages/cli/src/commands/{plugin,setup,status}.ts
  //   packages/cli/src/lib/completion.ts
  //   packages/plugins/{agent-claude-code,agent-codex,scm-gitlab,tracker-linear}/src/index.ts
  //   openclaw-plugin/index.ts
  {
    files: [
      // Known offenders with open split issues
      "packages/core/src/session-manager.ts",
      "packages/core/src/lifecycle-manager.ts",
      "packages/cli/src/commands/start.ts",
      "packages/plugins/scm-github/src/index.ts",
      "packages/plugins/scm-github/src/graphql-batch.ts",

      // Other existing offenders (grandfathered — no split issue yet)
      "packages/core/src/types.ts",
      "packages/core/src/config.ts",
      "packages/core/src/global-config.ts",
      "packages/core/src/agent-report.ts",
      "packages/core/src/observability.ts",
      "packages/core/src/lifecycle-state.ts",
      "packages/cli/src/commands/plugin.ts",
      "packages/cli/src/commands/setup.ts",
      "packages/cli/src/commands/status.ts",
      "packages/cli/src/lib/completion.ts",
      "packages/plugins/agent-claude-code/src/index.ts",
      "packages/plugins/agent-codex/src/index.ts",
      "packages/plugins/scm-gitlab/src/index.ts",
      "packages/plugins/tracker-linear/src/index.ts",
      "openclaw-plugin/index.ts",
    ],
    rules: {
      "max-lines": "off",
    },
  },

  // CLI package uses console.log/error for user output
  {
    files: ["packages/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Web package uses console for server-side logging
  {
    files: ["packages/web/**/*.ts", "packages/web/**/*.tsx"],
    rules: {
      "no-console": "off",
    },
  },

  // Long-running daemon entrypoints must use the managed-child API so any
  // subprocess they own is registered and reaped on stop/SIGINT.
  {
    files: ["packages/cli/src/commands/start.ts", "packages/web/server/start-all.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["spawn"],
              message: "Use spawnManagedDaemonChild() for daemon-owned subprocesses.",
            },
            {
              name: "child_process",
              importNames: ["spawn"],
              message: "Use spawnManagedDaemonChild() for daemon-owned subprocesses.",
            },
          ],
        },
      ],
    },
  },

  // Scripts directory - Node.js environment
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs", "packages/*/scripts/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-console": "off", // Scripts use console for output
    },
  },

  // ao bin scripts - Node.js environment (postinstall, etc.)
  {
    files: ["packages/ao/bin/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-console": "off", // Bin scripts use console for install output
    },
  },
);
